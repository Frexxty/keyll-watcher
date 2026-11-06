/** The Anthropic provider against its emulator. */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { after, before, beforeEach, test } from "node:test";
import { loadConfig } from "../src/config.mjs";
import { createAnthropicProvider, tokensOf } from "../src/providers/anthropic.mjs";
import { runOnce } from "../src/run.mjs";
import { baseEnv, command, fakeKeyll, lastHour, post, startEmulator, tempDir, trusted } from "./helpers.mjs";

let emu;
let dir;
before(async () => (emu = await startEmulator("anthropic")));
after(() => emu.stop());
beforeEach(async () => {
  await post(`${emu.url}/_emulator/reset`, {});
  dir = tempDir();
});

const keys = async () => (await (await fetch(`${emu.url}/_emulator/keys`)).json()).keys;
const keyNamed = async (name) => (await keys()).find((k) => k.name === name);
const message = async (name) => (await fetch(`${emu.url}/v1/messages`, { method: "POST", headers: { "x-api-key": (await keyNamed(name)).secret }, body: "{}" })).status;
const ref = async (name) => ({ uid: (await keyNamed(name)).id, keyId: (await keyNamed(name)).id });

async function deps(env = {}) {
  const config = loadConfig({ ...baseEnv(dir), KEYLL_PROVIDER: "anthropic", KEYLL_ANTHROPIC_API_URL: emu.url, ANTHROPIC_ADMIN_KEY: (await keyNamed("keyll-watcher")).secret, ...env });
  return { config, provider: createAnthropicProvider(config), trusted };
}
const withCommands = (...cmds) => fakeKeyll({ hello: () => ({ requests: {}, commands: cmds }) });

test("counts every kind of token in a usage row", () => {
  assert.equal(tokensOf({ uncached_input_tokens: 1500, cache_creation: { ephemeral_5m_input_tokens: 10, ephemeral_1h_input_tokens: 5 }, cache_read_input_tokens: 200, output_tokens: 500 }), 2215);
});

test("lists active and inactive keys, and reads tokens per key and model per minute", async () => {
  const keyll = fakeKeyll({ hello: () => ({ requests: { minutes: lastHour() }, commands: [] }) });
  const summary = await runOnce({ ...(await deps()), keyll });
  assert.deepEqual(summary.errors, []);
  const hello = keyll.sent.hellos[0];
  assert.deepEqual(hello.keys.map((k) => k.displayName).sort(), ["batch-jobs", "old-prototype", "production-app", "support-bot"]);
  assert.equal(hello.keys.find((k) => k.displayName === "old-prototype").details.status, "inactive");
  const prod = (await keyNamed("production-app")).id;
  const series = keyll.sent.readings[0].minutes.series.find((s) => s.key === prod);
  assert.equal(series.service, "claude-sonnet-4-5-20250929");
  assert.ok(series.points.every(([, tokens]) => tokens === 1500));
});

test("a signed block sets the key inactive; the matching restore sets it active again", async () => {
  const r = await ref("production-app");
  const block = command("block", r);
  const keyll = withCommands(block);
  await runOnce({ ...(await deps()), keyll });
  assert.equal(keyll.sent.results[0].method, "status-inactive");
  assert.equal(await message("production-app"), 401);
  assert.equal(await message("support-bot"), 200);
  const ledger = JSON.parse(fs.readFileSync(path.join(dir, "anthropic-ledger.json"), "utf8"));
  assert.equal(ledger.blocks[r.uid].incidentId, block.incidentId);
  assert.equal(fs.statSync(path.join(dir, "anthropic-ledger.json")).mode & 0o777, 0o600);

  const back = withCommands(command("restore", r, block.incidentId));
  await runOnce({ ...(await deps()), keyll: back });
  assert.equal(back.sent.results[0].ok, true);
  assert.equal(await message("production-app"), 200);
});

test("never re-enables a key someone else disabled", async () => {
  const r = await ref("old-prototype");
  const keyll = withCommands(command("restore", r));
  await runOnce({ ...(await deps()), keyll });
  assert.equal(keyll.sent.results[0].reason, "not-blocked-by-this-incident");
  assert.equal((await keyNamed("old-prototype")).status, "inactive");
});

test("a replayed command is refused, using the ledger's sequence number", async () => {
  const r = await ref("batch-jobs");
  const first = command("block", r);
  await runOnce({ ...(await deps()), keyll: withCommands(first) });
  await runOnce({ ...(await deps()), keyll: withCommands(command("restore", r, first.incidentId)) });
  const replay = withCommands(first);
  await runOnce({ ...(await deps()), keyll: replay });
  assert.equal(replay.sent.results[0].reason, "replayed");
  assert.equal((await keyNamed("batch-jobs")).status, "active");
});

test("backs off on 429 and honours Retry-After", async () => {
  await post(`${emu.url}/_emulator/ratelimit`, { count: 2, retryAfter: 1 });
  const started = Date.now();
  const keyll = fakeKeyll();
  const summary = await runOnce({ ...(await deps()), keyll });
  assert.deepEqual(summary.errors, []);
  assert.ok(Date.now() - started >= 2000);
  assert.equal(keyll.sent.hellos[0].keys.length, 4);
});

test("never sends a key string or a key hint", async () => {
  const keyll = fakeKeyll({ hello: () => ({ requests: { minutes: lastHour() }, commands: [] }) });
  await runOnce({ ...(await deps()), keyll });
  const sent = JSON.stringify(keyll.sent);
  for (const k of await keys()) {
    assert.ok(!sent.includes(k.secret));
    assert.ok(!sent.includes(k.secret.slice(0, 16)));
  }
});
