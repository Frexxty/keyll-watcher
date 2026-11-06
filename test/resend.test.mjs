/** The Resend provider against its emulator. */
import assert from "node:assert/strict";
import { after, before, beforeEach, test } from "node:test";
import { loadConfig } from "../src/config.mjs";
import { createResendProvider } from "../src/providers/resend.mjs";
import { runOnce } from "../src/run.mjs";
import { baseEnv, command, fakeKeyll, post, startEmulator, tempDir, trusted } from "./helpers.mjs";

let emu;
let dir;
before(async () => (emu = await startEmulator("resend")));
after(() => emu.stop());
beforeEach(async () => {
  await post(`${emu.url}/_emulator/reset`, {});
  dir = tempDir();
});

const keys = async () => (await (await fetch(`${emu.url}/_emulator/keys`)).json()).keys;
const keyNamed = async (name) => (await keys()).find((k) => k.name === name);
const ref = async (name) => ({ uid: (await keyNamed(name)).id, keyId: (await keyNamed(name)).id });
async function send(name, count) {
  const t = (await keyNamed(name)).token;
  for (let i = 0; i < count; i++) await fetch(`${emu.url}/emails`, { method: "POST", headers: { Authorization: `Bearer ${t}` }, body: "{}" });
}
async function deps(env = {}) {
  const config = loadConfig({ ...baseEnv(dir), KEYLL_PROVIDER: "resend", KEYLL_RESEND_API_URL: emu.url, RESEND_API_KEY: (await keyNamed("keyll-watcher")).token, ...env });
  return { config, provider: createResendProvider(config), trusted };
}

test("first read only marks where the log ends; later reads send each send's time, status and count, never contents", async () => {
  const first = fakeKeyll({ hello: () => ({ requests: { logs: { after: null } }, commands: [] }) });
  await runOnce({ ...(await deps()), keyll: first });
  const latestId = first.sent.readings[0].logs.latestId;
  assert.equal(first.sent.readings[0].logs.entries.length, 0);
  await send("newsletter", 3);
  const t = (await keyNamed("newsletter")).token;
  await fetch(`${emu.url}/emails/batch`, { method: "POST", headers: { Authorization: `Bearer ${t}` }, body: JSON.stringify([{}, {}, {}, {}]) });
  const next = fakeKeyll({ hello: () => ({ requests: { logs: { after: latestId } }, commands: [] }) });
  await runOnce({ ...(await deps()), keyll: next });
  const logs = next.sent.readings[0].logs;
  const sends = logs.entries.filter((e) => e.method === "POST");
  assert.equal(sends.length, 4);
  assert.deepEqual(sends.map((e) => e.count), [1, 1, 1, 4]);
  const newsletterId = (await keyNamed("newsletter")).id;
  assert.ok(logs.keys.find((k) => k.key === newsletterId).lastUsedAt);
  const sent = JSON.stringify(next.sent);
  assert.ok(!sent.includes("someone@example.com") && !sent.includes("private"));
  for (const k of await keys()) assert.ok(!sent.includes(k.token));
});

test("deleting is off unless allowed locally, and the watcher's own key is never deleted", async () => {
  const newsletter = await ref("newsletter");
  const off = fakeKeyll({ hello: () => ({ requests: {}, commands: [command("block", newsletter)] }) });
  await runOnce({ ...(await deps()), keyll: off });
  assert.equal(off.sent.results[0].reason, "destructive-not-allowed");
  assert.ok(await keyNamed("newsletter"));

  const on = fakeKeyll({ hello: () => ({ requests: {}, commands: [command("block", newsletter)] }) });
  await runOnce({ ...(await deps({ KEYLL_ALLOW_DELETE: "true" })), keyll: on });
  assert.equal(on.sent.results[0].method, "deleted");
  assert.equal(await keyNamed("newsletter"), undefined);

  // The watcher learns its own key from its own requests in the log, then refuses to delete it.
  const learn = fakeKeyll({ hello: () => ({ requests: { logs: { after: "start" } }, commands: [] }) });
  await runOnce({ ...(await deps({ KEYLL_ALLOW_DELETE: "true" })), keyll: learn });
  const own = await ref("keyll-watcher");
  const self = fakeKeyll({ hello: () => ({ requests: { logs: { after: "start" } }, commands: [command("block", own)] }) });
  await runOnce({ ...(await deps({ KEYLL_ALLOW_DELETE: "true" })), keyll: self });
  assert.equal(self.sent.results[0].reason, "watcher-key");
  assert.ok(await keyNamed("keyll-watcher"));
});
