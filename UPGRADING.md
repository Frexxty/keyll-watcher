# Upgrading from version 0.1

Version 0.2 changes what the watcher does. In 0.1 the watcher decided by itself when a key looked abused and when to block it. From 0.2, Keyll's servers make those decisions, and the watcher only collects usage numbers and carries out the block and restore commands Keyll signs, within the local limits you set.

Watchers on 0.1 keep working for now. The Keyll dashboard marks them "Upgrade required" until they report with 0.2. Keyll will announce when it stops accepting 0.1.

## What changes for you

- **Settings removed.** `KEYLL_ALERT_MULTIPLIER`, `KEYLL_BLOCK_MULTIPLIER`, `KEYLL_BLOCK_AFTER_MINUTES`, `KEYLL_MIN_RATE` and their floors, `KEYLL_WINDOW_MINUTES`, `KEYLL_RECENT_MINUTES`, the `KEYLL_BASELINE_*` settings, `KEYLL_NEW_SERVICE_*`, `KEYLL_LEARNING_HOURS`, `KEYLL_MAX_SNOOZE_MINUTES` and `KEYLL_COST_SPIKE_*` no longer do anything. The watcher logs a warning if they're set; you can delete them.
- **Settings added.** `KEYLL_WORKSPACE_ID` is required: the watcher rejects commands for any other workspace. The Connect page and the watcher page in the dashboard show it.
- **Signing keys.** The watcher now ships with Keyll's public signing key. `KEYLL_PUBLIC_KEY` still works and is read as an extra trusted key; the new name is `KEYLL_PUBLIC_KEYS`, which takes a comma-separated list.
- **Local limits stay yours.** `KEYLL_MODE`, `KEYLL_PROTECTED_KEYS` and `KEYLL_MAX_BLOCKS_PER_HOUR` work as before. Two are new: `KEYLL_ALLOW_DELETE` (Resend; off by default, so Resend keys only get alerts) and `KEYLL_OPENAI_BLOCK` (unchanged from 0.1's OpenAI option).
- **Resend.** In 0.1 the watcher deleted an abused Resend key on its own. In 0.2 it deletes one only if `KEYLL_ALLOW_DELETE=true` is set here and deletes are allowed for the watcher in Keyll.
- **Local files.** The Anthropic, OpenAI, OpenRouter and Resend watchers now keep `<provider>-ledger.json` in `KEYLL_STATE_DIR` instead of `<provider>-state.json`. Restore any key the 0.1 watcher blocked before you upgrade (`node bin/keyll-watcher.mjs restore <key>`, or in the provider's console), then delete the old file. Google Cloud keys blocked by 0.1 keep their annotations and can still be restored by 0.2.

## How to upgrade

**Google Cloud (Cloud Run).** Pull the new version and run the install again with your workspace ID; it updates the job in place:

```bash
./install.sh --project my-app-prod --region us-central1 \
  --keyll-url https://app.keyll.cloud --workspace-id <workspace id> --watcher-id <watcher id>
```

**Docker.** Pull the new version, add `KEYLL_WORKSPACE_ID=<workspace id>` to `keyll-watcher.env`, and rebuild:

```bash
docker compose -p keyll-<provider> -f deploy/docker-compose.ai.yml up -d --build
```

**systemd and Kubernetes.** Update the code or image, add `KEYLL_WORKSPACE_ID` to the environment file or secret, and restart.

The first run on 0.2 sends Keyll up to four weeks of usage history, if the provider has it, so nothing has to be relearned.
