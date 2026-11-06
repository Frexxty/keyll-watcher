#!/usr/bin/env node
/**
 * keyll-watcher run            one run (what Cloud Scheduler or a timer triggers every minute)
 * keyll-watcher loop [secs]    run every N seconds (Docker)
 * keyll-watcher status         list keys and which ones this watcher has blocked
 * keyll-watcher restore <key>  undo this watcher's block of a key, without Keyll (key ID, uid or display name)
 *
 * status and restore work with your own provider credentials and don't need Keyll at all. For Google Cloud:
 *   GOOGLE_OAUTH_ACCESS_TOKEN=$(gcloud auth print-access-token) GCP_PROJECT=my-project keyll-watcher status
 * For the other providers, run them where the watcher runs, so they see its ledger.
 */
import { loadConfig } from "../src/config.mjs";
import { createKeyllClient } from "../src/keyll.mjs";
import { createProvider } from "../src/providers/index.mjs";
import { log, runOnce } from "../src/run.mjs";
import { trustedKeys } from "../src/signing.mjs";

const [command = "run", arg] = process.argv.slice(2);

function watcherDeps() {
  const config = loadConfig();
  const missing = { keyllUrl: "KEYLL_URL", token: "KEYLL_TOKEN", watcherId: "KEYLL_WATCHER_ID", workspaceId: "KEYLL_WORKSPACE_ID" };
  for (const [name, env] of Object.entries(missing)) if (!config[name]) throw new Error(`Missing ${env}`);
  if (config.retired.length) log("WARNING", "these settings are no longer used; Keyll's servers make those decisions now", { settings: config.retired });
  return { config, provider: createProvider(config), keyll: createKeyllClient(config), trusted: trustedKeys(config.publicKeys) };
}

async function main() {
  if (command === "run") {
    const summary = await runOnce(watcherDeps());
    log(summary.errors.length ? "ERROR" : "INFO", "run finished", summary);
    process.exitCode = summary.errors.length ? 1 : 0;
    return;
  }
  if (command === "loop") {
    const deps = watcherDeps();
    const every = Math.max(1, Number(arg || 60)) * 1000;
    for (;;) {
      const started = Date.now();
      try {
        const summary = await runOnce({ ...deps, now: Date.now() });
        log("INFO", "run finished", summary);
      } catch (error) {
        log("ERROR", "run crashed", { error: error.message });
      }
      await new Promise((r) => setTimeout(r, Math.max(0, every - (Date.now() - started))));
    }
  }
  if (command === "status" || command === "restore") {
    const provider = createProvider(loadConfig());
    const keys = await provider.listKeys();
    if (command === "status") {
      for (const k of keys)
        console.log(`${k.blocked ? "BLOCKED " : "ok      "} ${k.keyId}  ${k.displayName || "(no name)"}${k.blocked ? `  incident ${k.blocked.incidentId} at ${k.blocked.blockedAt}` : ""}`);
      return;
    }
    const key = keys.find((k) => [k.keyId, k.uid, k.displayName].includes(arg));
    if (!key) throw new Error(`No key matches ${arg}`);
    if (!key.blocked) throw new Error(`${arg} isn't blocked by this watcher`);
    const result = await provider.restore(key, { incidentId: key.blocked.incidentId, seq: (await provider.lastSeq(key)) + 1 });
    console.log(result.ok ? `Restored ${key.displayName || key.keyId}.` : `Not restored: ${result.reason}`);
    return;
  }
  console.error("Usage: keyll-watcher [run | loop <seconds> | status | restore <key>]");
  process.exitCode = 2;
}

main().catch((error) => {
  log("ERROR", error.message);
  process.exitCode = 1;
});
