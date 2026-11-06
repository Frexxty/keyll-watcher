# Keyll watcher

The Keyll watcher runs on your infrastructure, next to your API keys. It reads per-key usage numbers from your provider and sends them to Keyll. Keyll's servers decide whether a key is being abused. When Keyll decides to block or restore a key, it sends the watcher a signed command, and the watcher carries it out only if the signature checks out and your local limits allow it.

The watcher holds your provider credentials. Keyll never gets them, and never gets your keys' secret values.

Supported providers: Google Cloud API keys, Anthropic, OpenAI, OpenRouter and Resend.

The code is small, uses only Node's standard library, and is meant to be read before you run it: `src/run.mjs` is one run, `src/signing.mjs` checks commands, `src/rails.mjs` holds the local limits, and each file in `src/providers/` makes every call to one provider.

This is source-available software under the Functional Source License 1.1 with an Apache 2.0 future license (FSL-1.1-ALv2), in [LICENSE](LICENSE). You can read, run, change and share it for any purpose except offering it, or something substantially like it, as a competing commercial product or service. Two years after each version is published, that version is also licensed under the Apache License 2.0.

## How a run works

1. List your keys from the provider: IDs, names and settings, never secrets.
2. Send Keyll a heartbeat. Keyll answers with what to read, and any signed commands.
3. Check each command and carry out the ones that pass. Report what happened to every one.
4. Read the usage Keyll asked for, within the watcher's own limits, and send the numbers.
5. Carry out any commands that came back.

If Keyll can't be reached, the run stops after step 2. The watcher never blocks a key on its own: it has no way to decide that.

## What it sends to Keyll

**Heartbeat**, every run:

| Field | Content |
|---|---|
| `protocol`, `version` | Protocol 2, and the watcher's version |
| `provider`, `unit` | Which provider, and what usage is counted in (requests, tokens, cents, emails) |
| `capabilities` | How this watcher blocks a key (`restrictions`, `status-inactive`, `disabled`, `scopes`, `delete`), or `none` |
| `scope.projectId` | The Google Cloud project ID, or the account label you set (`KEYLL_SCOPE_LABEL`) |
| `rails` | Your local limits: mode, never-block list, blocks per hour, whether deleting is allowed, blocks in the last hour |
| `trustedKeys` | The IDs of the signing keys this watcher trusts |
| `errors` | Error messages from this run, if any |
| `keys[]` | Per key: ID, uid, display name, creation time, whether this watcher has it blocked, and a summary of its settings (below) |

Key settings per provider:

| Provider | Sent |
|---|---|
| Google Cloud | Which APIs the key's restrictions allow, its restriction type (browser, server, Android, iOS), whether it's unrestricted |
| Anthropic | Status (active, inactive), workspace ID, whether it belongs to a user or a service account, expiry |
| OpenAI | Project ID and name, owner type, whether the owner still has access, last use, expiry |
| OpenRouter | Disabled or not, workspace ID, credit limit, remaining credit and reset period, expiry, last use |
| Resend | Nothing beyond ID, name and creation time |

**Readings**, every run, only what Keyll asked for:

| Provider | Sent |
|---|---|
| Google Cloud | Requests per key, API and minute, and how many weren't 2xx. On request, per key and API per hour: total requests and the busiest minute |
| Anthropic | Tokens per key, model and minute (input, cache and output added up). On request, the same per hour with the busiest minute |
| OpenAI | Model requests per key, model and minute. On request: the same per hour, dollars per key per day, and for each key whether it has all permissions, restricted ones, or none recorded |
| OpenRouter | Each key's spend so far in US dollars (all time and today). On request, one key's spend per day and model for the last 30 days |
| Resend | For each send request since the last readings: its time, endpoint, status code and number of emails, and whether it was the watcher's own request. Each key's last-use time |

**Command results**: for each command, whether it ran, or the reason it didn't.

## What it never does

- It never sends key strings, credentials or tokens. Each provider module only passes on the fields listed above, and `src/keyll.mjs` refuses to send anything shaped like a Google, Anthropic, OpenAI, OpenRouter or Resend key.
- It never reads a key's secret value. On Google Cloud its role has no `apikeys.keys.getKeyString`. The other providers' admin APIs don't return secrets; where they return a redacted hint, the watcher drops it.
- It never creates keys, and never deletes one unless you allow it for Resend (below).
- It never sends email contents or recipients. The Resend log contains them; the watcher reads them only to count the emails in a batch.
- It never runs a command that isn't signed by a key it trusts, for your workspace and this watcher.
- It never blocks a key by itself.

## Permissions per provider

| Provider | Credential | What the watcher needs it for | What else the credential allows |
|---|---|---|---|
| Google Cloud | Service account `keyll-watcher` with a custom role: `monitoring.timeSeries.list`, `apikeys.keys.list`, `apikeys.keys.get`, `apikeys.keys.update` | Read request counts, list keys, swap a key's restrictions | Change or clear any key's restrictions in the project. It can't read key strings, create or delete keys |
| Anthropic | Claude Console Admin API key | List keys, read the usage report, set a key's status | Rename keys, manage members and their roles, create and archive workspaces. It can't create API keys or read their secrets |
| OpenAI | Admin API key, read-only unless you turn blocking on | Read usage, costs, projects, keys and the audit log; with blocking, change a key's permissions | With write access to project API keys, also create service accounts, which come with new keys |
| OpenRouter | Management key | List keys and activity, turn a key off and on | Create and delete keys, change limits, guardrails and workspaces |
| Resend | Full-access API key | List keys, read the request log, delete a key (if you allow it) | Send email and manage domains |

Except for Google Cloud, none of these providers offers a credential that can only read usage and turn one key off. Give the watcher a key of its own, with the shortest expiry you can live with, and rotate it.

## The local safety rails

These limits are set where the watcher runs. Keyll can't change them, so they hold even if Keyll's servers were compromised. They're checked after a command's signature, before anything touches a key.

| Rail | Setting | Default |
|---|---|---|
| Dry run: no block runs at all | `KEYLL_MODE=dry-run` or `enforce` | `dry-run` |
| Keys that are never blocked (ID, uid or name) | `KEYLL_PROTECTED_KEYS` | none |
| No more blocks than this in any hour | `KEYLL_MAX_BLOCKS_PER_HOUR` | 3 |
| Blocks that can't be undone (Resend deletes keys) | `KEYLL_ALLOW_DELETE=true` | not allowed |
| OpenAI blocks, which change a key's permissions | `KEYLL_OPENAI_BLOCK=recorded-scopes` | not allowed |
| The watcher's own credential | always | never blocked |

Restores are limited too. A restore only undoes a block this watcher made, for the incident that made it, and puts back exactly what the key had before: on Google Cloud the saved restrictions, on OpenAI the saved permissions, on Anthropic and OpenRouter the key's previous state. If someone changed the key by hand in the meantime, the watcher keeps their change.

OpenAI blocks need the opt-in because OpenAI's API never says what a key's permissions are, and an empty permission list means all of them. With `KEYLL_OPENAI_BLOCK=recorded-scopes`, the watcher only blocks a key whose current permissions are in your organization's audit log (turn audit logging on). It saves those permissions in its ledger, sets the key to read-only, and writes back exactly what it saved on restore.

## How commands are verified

A command is a signed JSON payload for one action on one key. The watcher accepts it only if all of these hold:

1. The Ed25519 signature checks out against a trusted key: one in `src/trusted-keys.mjs`, or one you add with `KEYLL_PUBLIC_KEYS`.
2. It's version 2, addressed to `keyll-watcher`, of type `command`.
3. Its workspace ID and watcher ID are yours (`KEYLL_WORKSPACE_ID`, `KEYLL_WATCHER_ID`).
4. The action is `block` or `restore`, for a key the provider lists now, and the key's ID matches.
5. It was issued no more than two minutes in the future, hasn't expired, and was valid for 15 minutes at most.
6. Its sequence number is higher than the last one used for that key (Google Cloud, stored on the key) or for this watcher (other providers, in the ledger). A verified command uses up its number whether it runs or not.

Then the local rails apply. Anything rejected is reported back with the reason, and the key isn't touched.

Keyll's signing keys can rotate: a new key is added to `src/trusted-keys.mjs` in a release before Keyll signs with it, and the heartbeat tells Keyll which keys each watcher trusts.

## What stays on your machine

- **Google Cloud: nothing.** A block's record lives on the key itself, in annotations: the incident and command that blocked it, when, the key's previous restrictions, and the last command's sequence number. The watcher can run as a stateless job.
- **Anthropic, OpenAI, OpenRouter, Resend: a ledger** in `KEYLL_STATE_DIR/<provider>-ledger.json` (mode 600), because their keys can't carry a marker. It holds the keys this watcher blocked and for which incident, the time of each recent block (for the hourly limit), the last command's sequence number, the watcher's own Resend key, and for OpenAI each blocked key's previous permissions, which never leave your environment. Keep it on a volume. If it's lost, Keyll can no longer restore a key this watcher blocked; you'd turn it back on in the provider's console.

Nothing else is kept between runs. Usage history lives with Keyll.

## Install

The Keyll dashboard's Connect page gives you the exact commands, with your workspace and watcher IDs.

**Google Cloud**, as a Cloud Run job in your project, with `gcloud` signed in as an owner:

```bash
./install.sh --project my-app-prod --region us-central1 \
  --keyll-url https://app.keyll.cloud --workspace-id <workspace id> --watcher-id <watcher id>
```

The script lists every change and asks first. It creates the custom role and service account above, stores the watcher token in Secret Manager (it asks for it, hidden), builds this directory with Cloud Build, and runs it every minute with Cloud Scheduler. To run it on your own servers instead, add `--target onprem`: see [deploy/README.md](deploy/README.md). `./uninstall.sh` removes everything it created.

**Anthropic, OpenAI, OpenRouter**, with Docker on any server:

```bash
cat > keyll-watcher.env <<'ENV'
KEYLL_PROVIDER=anthropic
KEYLL_URL=https://app.keyll.cloud
KEYLL_WORKSPACE_ID=<workspace id>
KEYLL_WATCHER_ID=<watcher id>
KEYLL_TOKEN=<watcher token>
KEYLL_SCOPE_LABEL=acme-claude
KEYLL_MODE=dry-run
ANTHROPIC_ADMIN_KEY=<an admin key made for the watcher>
ENV
chmod 600 keyll-watcher.env
docker compose -p keyll-anthropic -f deploy/docker-compose.ai.yml up -d --build
```

For OpenAI use `OPENAI_ADMIN_KEY`, for OpenRouter `OPENROUTER_MANAGEMENT_KEY`. Each can also come from a file: `ANTHROPIC_ADMIN_KEY_FILE` and so on. **Resend** works the same way with `RESEND_API_KEY` and `deploy/docker-compose.resend.yml`.

Every install starts in dry run. When you're ready, set `KEYLL_MODE=enforce` where the watcher runs. The Keyll dashboard can pause blocking, but it can't turn it on.

## Without Keyll

`status` lists your keys and which ones this watcher has blocked. `restore` undoes this watcher's block of one key. Neither needs Keyll.

```bash
# Google Cloud, with your own login:
GOOGLE_OAUTH_ACCESS_TOKEN=$(gcloud auth print-access-token) GCP_PROJECT=my-app-prod node bin/keyll-watcher.mjs status
GOOGLE_OAUTH_ACCESS_TOKEN=$(gcloud auth print-access-token) GCP_PROJECT=my-app-prod node bin/keyll-watcher.mjs restore maps-key

# The other providers, inside the container, so the ledger is there:
docker compose -p keyll-anthropic -f deploy/docker-compose.ai.yml exec keyll-watcher node bin/keyll-watcher.mjs status
```

## Settings

| Variable | Default | |
|---|---|---|
| `KEYLL_URL` | none | Keyll's address. HTTPS only. |
| `KEYLL_TOKEN` | none | The watcher token from the dashboard. It only lets the watcher report; it can't change anything. |
| `KEYLL_WORKSPACE_ID`, `KEYLL_WATCHER_ID` | none | Commands for any other workspace or watcher are rejected. |
| `KEYLL_PUBLIC_KEYS` | none | Extra trusted signing keys, comma separated, base64 SPKI. |
| `KEYLL_PROVIDER` | `gcp` | `gcp`, `anthropic`, `openai`, `openrouter` or `resend`. |
| `KEYLL_MODE`, `KEYLL_PROTECTED_KEYS`, `KEYLL_MAX_BLOCKS_PER_HOUR`, `KEYLL_ALLOW_DELETE`, `KEYLL_OPENAI_BLOCK` | see above | The local safety rails. |
| `KEYLL_STATE_DIR` | `/var/lib/keyll` | Where the ledger lives. |
| `KEYLL_SCOPE_LABEL` | the provider | A name for the account, shown in Keyll. |
| `GCP_PROJECT`, `GOOGLE_APPLICATION_CREDENTIALS` | none | Google Cloud outside Cloud Run. See [deploy/README.md](deploy/README.md). |
| `ANTHROPIC_ADMIN_KEY`, `OPENAI_ADMIN_KEY`, `OPENROUTER_MANAGEMENT_KEY`, `RESEND_API_KEY` | none | The provider credential, or `…_FILE` with a path to it. |
| `KEYLL_REQUEST_GAP_MS` | 200 to 350 | Milliseconds between calls to the provider. |

The watcher also limits what Keyll may ask it to read in one run: at most a day of minutes, 35 days of hours, 31 days of costs, and activity for 10 keys. Calls to a provider are spaced out, and a 429 or 503 is retried up to four times, waiting as long as `Retry-After` asks (up to 30 seconds).

Upgrading from version 0.1: see [UPGRADING.md](UPGRADING.md).

## Tests

```bash
npm test
```

The tests run the watcher against local stand-ins for each provider's API, in `test/emulators/`, with a fake Keyll that sends good and bad commands. No test calls a real provider.
