/** The OpenAI provider against its emulator. */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { after, before, beforeEach, test } from "node:test";
import { loadConfig } from "../src/config.mjs";
import { BLOCK_SCOPES, createOpenAIProvider, scopesFromEvent } from "../src/providers/openai.mjs";
import { runOnce } from "../src/run.mjs";
import { baseEnv, command, fakeKeyll, lastHour, post, startEmulator, tempDir, trusted } from "./helpers.mjs";

let emu;
let dir;
before(async () => (emu = await startEmulator("openai")));
after(() => emu.stop());
beforeEach(async () => {
  await post(`${emu.url}/_emulator/reset`, {});
  dir = tempDir();
});

const emulator = async () => (await fetch(`${emu.url}/_emulator/keys`)).json();
const keyNamed = async (name) => (await emulator()).keys.find((k) => k.name === name);
const complete = async (name) => (await fetch(`${emu.url}/v1/chat/completions`, { method: "POST", headers: { Authorization: `Bearer ${(await keyNamed(name)).secret}` }, body: "{}" })).status;
const ref = async (name) => ({ uid: (await keyNamed(name)).id, keyId: (await keyNamed(name)).id });
const BLOCKING = { KEYLL_OPENAI_BLOCK: "recorded-scopes" };

async function deps(env = {}) {
  const config = loadConfig({ ...baseEnv(dir), KEYLL_PROVIDER: "openai", KEYLL_OPENAI_API_URL: emu.url, OPENAI_ADMIN_KEY: (await emulator()).admin, ...env });
  return { config, provider: createOpenAIProvider(config), trusted };
}
const withCommands = (...cmds) => fakeKeyll({ hello: () => ({ requests: {}, commands: cmds }) });

test("reads scopes from both audit event shapes", () => {
  assert.deepEqual(scopesFromEvent({ type: "api_key.created", "api_key.created": { id: "key_a", data: { scopes: ["api.model.request"] } } }), ["api.model.request"]);
  assert.deepEqual(scopesFromEvent({ type: "api_key.updated", "api_key.updated": { id: "key_a", changes_requested: { scopes: [] } } }), []);
  assert.equal(scopesFromEvent({ type: "api_key.updated", "api_key.updated": { id: "key_a", changes_requested: { expires_in_seconds: 60 } } }), undefined);
});

test("reads keys, requests per key and model, daily costs, and a scope summary, not the scopes", async () => {
  const end = Math.floor(Date.now() / 86_400_000) * 86_400_000;
  const keyll = fakeKeyll({ hello: () => ({ requests: { minutes: lastHour(), costs: { from: new Date(end - 3 * 86_400_000).toISOString() }, scopes: true }, commands: [] }) });
  await runOnce({ ...(await deps()), keyll });
  const hello = keyll.sent.hellos[0];
  assert.deepEqual(hello.capabilities, { block: "none", restore: true });
  assert.deepEqual(hello.keys.map((k) => k.displayName).sort(), ["etl-pipeline", "intern-key", "mobile-app", "web-backend"]);
  const r = keyll.sent.readings[0];
  const web = (await keyNamed("web-backend")).id;
  assert.ok(r.minutes.series.find((s) => s.key === web).points.every(([, n]) => n === 30));
  assert.equal(r.daily.kind, "openai-costs");
  assert.ok(r.daily.rows.some((x) => x.key === web && x.usd === 8));
  const summary = Object.fromEntries(r.scopes.map((s) => [s.key, s.summary]));
  assert.equal(summary[web], "all");
  assert.equal(summary[(await keyNamed("mobile-app")).id], "restricted");
  assert.equal(summary[(await keyNamed("intern-key")).id], "unknown");
  assert.ok(!JSON.stringify(keyll.sent).includes("api.files.read"), "the scopes themselves never leave");
});

test("alerts only by default: a block command is refused and nothing is changed", async () => {
  const keyll = withCommands(command("block", await ref("web-backend")));
  await runOnce({ ...(await deps()), keyll });
  assert.equal(keyll.sent.results[0].reason, "alert-only-provider");
  assert.equal((await (await fetch(`${emu.url}/_emulator/stats`)).json()).scopeWrites.length, 0);
});

test("with blocking on, a key with recorded scopes goes read-only and gets exactly those scopes back", async () => {
  const r = await ref("mobile-app");
  const block = command("block", r);
  await runOnce({ ...(await deps(BLOCKING)), keyll: withCommands(block) });
  assert.deepEqual((await keyNamed("mobile-app")).scopes, BLOCK_SCOPES);
  assert.equal(await complete("mobile-app"), 403);
  const ledger = fs.readFileSync(path.join(dir, "openai-ledger.json"), "utf8");
  assert.ok(ledger.includes("api.files.read"), "the saved scopes stay in the local ledger");
  const back = withCommands(command("restore", r, block.incidentId));
  await runOnce({ ...(await deps(BLOCKING)), keyll: back });
  assert.equal(back.sent.results[0].ok, true);
  assert.deepEqual((await keyNamed("mobile-app")).scopes, ["api.model.request", "api.files.read"]);
  const writes = (await (await fetch(`${emu.url}/_emulator/stats`)).json()).scopeWrites.map((w) => w.scopes);
  assert.deepEqual(writes, [BLOCK_SCOPES, ["api.model.request", "api.files.read"]]);
});

test("a key whose scopes were never recorded isn't blocked, and a hand change during a block is kept", async () => {
  const intern = withCommands(command("block", await ref("intern-key")));
  await runOnce({ ...(await deps(BLOCKING)), keyll: intern });
  assert.equal(intern.sent.results[0].reason, "scopes-not-recorded");

  const r = await ref("web-backend");
  const block = command("block", r);
  await runOnce({ ...(await deps(BLOCKING)), keyll: withCommands(block) });
  await post(`${emu.url}/_emulator/scopes`, { key: "web-backend", scopes: ["api.model.request"] });
  const back = withCommands(command("restore", r, block.incidentId));
  await runOnce({ ...(await deps(BLOCKING)), keyll: back });
  assert.equal(back.sent.results[0].note, "changed-outside-keyll");
  assert.deepEqual((await keyNamed("web-backend")).scopes, ["api.model.request"]);
});

test("backs off on 429 and honours Retry-After", async () => {
  await post(`${emu.url}/_emulator/ratelimit`, { count: 2, retryAfter: 1 });
  const started = Date.now();
  const summary = await runOnce({ ...(await deps()), keyll: fakeKeyll() });
  assert.deepEqual(summary.errors, []);
  assert.ok(Date.now() - started >= 2000);
});

test("never sends a key string or a redacted value", async () => {
  const keyll = fakeKeyll({ hello: () => ({ requests: { minutes: lastHour() }, commands: [] }) });
  await runOnce({ ...(await deps()), keyll });
  const sent = JSON.stringify(keyll.sent);
  const all = await emulator();
  assert.ok(!sent.includes(all.admin));
  for (const k of all.keys) assert.ok(!sent.includes(`${k.secret.slice(0, 8)}...`));
});
