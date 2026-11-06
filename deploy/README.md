# Running the watcher outside Cloud Run

The Google Cloud watcher runs anywhere Node 22+ or Docker runs: your own servers, another cloud, a Kubernetes cluster. It only needs outbound HTTPS to Google's APIs and to Keyll. Nothing needs to reach it.

This page is about the Google Cloud watcher. The Anthropic, OpenAI and OpenRouter watchers always run on your own server, with `docker-compose.ai.yml`, and Resend with `docker-compose.resend.yml`. The dashboard's Connect page gives you their commands, and [the watcher README](../README.md) explains them.

## 1. Set up the Google side

From this directory's parent, with `gcloud` signed in as a project owner:

```bash
./install.sh --project my-app-prod --keyll-url https://app.keyll.cloud --workspace-id <id> --watcher-id <id> \
  --target onprem --credentials wif \
  --wif-provider projects/<number>/locations/global/workloadIdentityPools/<pool>/providers/<provider> \
  --wif-principal 'principal://iam.googleapis.com/projects/<number>/locations/global/workloadIdentityPools/<pool>/subject/<subject>' \
  --wif-token-file /var/run/keyll/idp-token
```

This creates the same four-permission role and service account as the Cloud Run install. It writes two files, both readable only by you:

- `keyll-watcher.env`: the settings and the watcher token
- `keyll-watcher-credentials.json`: how the watcher gets Google credentials

### Credentials: workload identity or a key

**Workload identity federation** (`--credentials wif`) is the safer choice. Nothing long-lived is stored: the watcher trades a short-lived token from your own identity provider for a Google token. That provider can be a Kubernetes cluster's service account tokens, Azure, GitHub, or any OIDC or SAML provider. You need a workload identity pool and provider in the project first. Google's guide is "Configure workload identity federation with other identity providers".

**A service account key** (`--credentials key`) works anywhere, with no setup. But the key is a long-lived secret: anyone who copies the file can act as the watcher. Many organisations block key creation with the `iam.disableServiceAccountKeyCreation` policy.

On GKE, use Workload Identity and skip both. The metadata server provides credentials, as on Cloud Run.

## 2. Run it

Pick one:

- **Docker Compose:** `docker-compose.yml`. Runs the watcher in a loop, once a minute, read-only and without root.
- **systemd:** `systemd/keyll-watcher.service` and `.timer`. Runs one watcher run each minute, with a dynamic user and a locked-down sandbox.
- **Kubernetes:** `kubernetes/cronjob.yaml`. A CronJob every minute.

Check that it works: the Keyll dashboard shows the watcher's first heartbeat within a minute or two.

## Turning blocking on

Set `KEYLL_MODE=enforce` in `keyll-watcher.env` and restart. As with Cloud Run, only someone with access to that file can turn blocking on. The dashboard can pause blocking, but never arm it.

## Uninstall

Stop the watcher, then run `./uninstall.sh --project my-app-prod`. Deleting the service account cuts off any key or federated access at once.
