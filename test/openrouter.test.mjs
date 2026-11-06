/** The OpenRouter provider against its emulator. */
import assert from "node:assert/strict";
import { after, before, beforeEach, test } from "node:test";
import { loadConfig } from "../src/config.mjs";
import { createOpenRouterProvider } from "../src/providers/openrouter.mjs";
import { runOnce } from "../src/run.mjs";
import { baseEnv, command, fakeKeyll, post, startEmulator, tempDir, trusted } from "./helpers.mjs";

let emu;
let dir;
before(async () => (emu = await startEmulator("openrouter")));
after(() => emu.stop());
beforeEach(async () => {
  await post(`${emu.url}/_emulator/reset`, {});
  dir = tempDir();
});

const emulator = async () => (await fetch(`${emu.url}/_emulator/keys`)).json();
const keyNamed = async (name) => (await emulator()).keys.find((k) => k.name === name);
const complete = async (name) => (await fetch(`${emu.url}/api/v1/chat/completions`, { method: "POST", headers: { Authorization: `Bearer ${(await keyNamed(name)).secret}` }, body: "{}" })).status;
const ref = async (name) => ({ uid: (await keyNamed(name)).hash, keyId: (await keyNamed(name)).hash });

async function deps(env = {}) {
  const config = loadConfig({ ...baseEnv(dir), KEYLL_PROVIDER: "openrouter", KEYLL_OPENROUTER_API_URL: `${emu.url}/api`, OPENROUTER_MANAGEMENT_KEY: (await emulator()).management, ...env });
  return { config, provider: createOpenRouterProvider(config), trusted };
}
const withCommands = (...cmds) => fakeKeyll({ hello: () => ({ requests: {}, commands: cmds }) });

test("lists keys in every workspace with their credit limits, and sends running totals and daily activity", async () => {
  const chat = await ref("chat-widget");
  const keyll = fakeKeyll({ hello: () => ({ requests: { counters: true, activity: [chat.uid] }, commands: [] }) });
  await runOnce({ ...(await deps()), keyll });
  const hello = keyll.sent.hellos[0];
  assert.deepEqual(hello.keys.map((k) => k.displayName).sort(), ["chat-widget", "production", "research-notebook", "retired"]);
  assert.equal(hello.keys.find((k) => k.displayName === "production").details.limitUsd, 100);
  assert.equal(hello.keys.find((k) => k.displayName === "chat-widget").details.limitUsd, null);
  const r = keyll.sent.readings[0];
  assert.equal(r.counters.length, 4);
  assert.equal(r.counters.find((c) => c.key === chat.uid).usd, 150);
  assert.equal(r.daily.kind, "openrouter-activity");
  assert.deepEqual(r.daily.keys, [chat.uid]);
  assert.equal(r.daily.rows.length, 30);
  assert.ok(r.daily.rows.every((x) => x.model === "openai/gpt-4o-mini" && x.usd === 5));
});

test("a signed block disables the key; the restore enables it; a key you disabled stays disabled", async () => {
  const r = await ref("chat-widget");
  const block = command("block", r);
  await runOnce({ ...(await deps()), keyll: withCommands(block) });
  assert.equal(await complete("chat-widget"), 401);
  assert.equal(await complete("production"), 200);
  const back = withCommands(command("restore", r, block.incidentId));
  await runOnce({ ...(await deps()), keyll: back });
  assert.equal(back.sent.results[0].ok, true);
  assert.equal(await complete("chat-widget"), 200);

  const retired = withCommands(command("restore", await ref("retired")));
  await runOnce({ ...(await deps()), keyll: retired });
  assert.equal(retired.sent.results[0].reason, "not-blocked-by-this-incident");
  assert.equal((await keyNamed("retired")).disabled, true);
});

test("backs off on 429 and honours Retry-After", async () => {
  await post(`${emu.url}/_emulator/ratelimit`, { count: 2, retryAfter: 1 });
  const started = Date.now();
  const summary = await runOnce({ ...(await deps()), keyll: fakeKeyll() });
  assert.deepEqual(summary.errors, []);
  assert.ok(Date.now() - started >= 2000);
});

test("never sends a key string or the redacted label", async () => {
  const keyll = fakeKeyll({ hello: () => ({ requests: { counters: true }, commands: [] }) });
  await runOnce({ ...(await deps()), keyll });
  const sent = JSON.stringify(keyll.sent);
  const all = await emulator();
  assert.ok(!sent.includes(all.management));
  for (const k of all.keys) assert.ok(!sent.includes(k.secret.slice(0, 12)));
});
