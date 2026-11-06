/**
 * The watcher against the Google Cloud emulator, with a fake Keyll that sends commands, good and bad.
 */
import assert from "node:assert/strict";
import { after, before, beforeEach, test } from "node:test";
import { loadConfig } from "../src/config.mjs";
import { ANNOTATIONS, createGcpProvider } from "../src/providers/gcp.mjs";
import { capRequests, runOnce } from "../src/run.mjs";
import { baseEnv, command, fakeKeyll, lastHour, post, startEmulator, strangerKey, tempDir, trusted, WATCHER_ID } from "./helpers.mjs";

let emu;
before(async () => (emu = await startEmulator("gcp")));
after(() => emu.stop());
beforeEach(() => post(`${emu.url}/_emulator/reset`, {}));

const keys = async () => (await (await fetch(`${emu.url}/_emulator/keys`)).json()).keys;
const keyNamed = async (name) => (await keys()).find((k) => k.displayName === name);
const callApi = async (name, service) => (await fetch(`${emu.url}/call/${service}`, { method: "POST", headers: { "x-goog-api-key": (await keyNamed(name)).keyString } })).status;

function deps(env = {}) {
  const config = loadConfig({
    ...baseEnv(tempDir()),
    GCP_PROJECT: "keyll-e2e",
    KEYLL_GCP_MONITORING_URL: emu.url,
    KEYLL_GCP_APIKEYS_URL: emu.url,
    KEYLL_GCP_METADATA_URL: emu.url,
    ...env,
  });
  return { config, provider: createGcpProvider(config), trusted };
}

/** A ref for a command, from the emulator's key. */
const refOf = async (name) => {
  const k = await keyNamed(name);
  return { uid: k.uid, keyId: k.name.split("/").pop() };
};
const withCommands = (...cmds) => fakeKeyll({ hello: () => ({ requests: {}, commands: cmds }) });

test("the heartbeat carries the version, the local rails, the trusted keys and each key's metadata, and nothing secret", async () => {
  const keyll = fakeKeyll();
  const summary = await runOnce({ ...deps({ KEYLL_PROTECTED_KEYS: "places-server" }), keyll });
  assert.deepEqual(summary.errors, []);
  const hello = keyll.sent.hellos[0];
  assert.equal(hello.protocol, 2);
  assert.equal(hello.provider, "gcp");
  assert.deepEqual(hello.capabilities, { block: "restrictions", restore: true });
  assert.deepEqual(hello.rails, { mode: "enforce", protectedKeys: ["places-server"], maxBlocksPerHour: 3, allowDestructive: false, blocksLastHour: 0 });
  assert.deepEqual(hello.trustedKeys, trusted.map((k) => k.kid));
  const maps = hello.keys.find((k) => k.displayName === "maps-website");
  assert.deepEqual(Object.keys(maps).sort(), ["blocked", "createdAt", "details", "displayName", "keyId", "restrictions", "self", "uid"]);
  const sent = JSON.stringify(keyll.sent);
  for (const k of await keys()) assert.ok(!sent.includes(k.keyString), `${k.displayName}'s key string leaked`);
});

test("reads exactly what Keyll asks for: per-minute counts with failures, and hourly totals and peaks", async () => {
  const end = Math.floor(Date.now() / 3_600_000) * 3_600_000;
  const hourly = { from: new Date(end - 48 * 3_600_000).toISOString(), to: new Date(end).toISOString() };
  const keyll = fakeKeyll({ hello: () => ({ requests: { minutes: lastHour(), hourly }, commands: [] }) });
  await runOnce({ ...deps(), keyll });
  const r = keyll.sent.readings[0];
  assert.equal(r.protocol, 2);
  assert.equal(r.minutes.keys.length, 5);
  const maps = r.minutes.series.find((s) => s.service === "maps-backend.googleapis.com");
  assert.ok(maps.points.length >= 50);
  assert.ok(maps.points.every(([sec, total, errors]) => Number.isInteger(sec) && total >= 0 && errors >= 0));
  const h = r.hourly.series.find((s) => s.service === "maps-backend.googleapis.com");
  assert.ok(h.points.length >= 40);
  assert.ok(h.points.every(([, total, peak]) => peak <= total));
  assert.equal(r.counters, undefined, "nothing that wasn't asked for");
});

test("Keyll's requests are capped: no more than a day of minutes or 35 days of hours", () => {
  const now = Date.parse("2026-01-31T00:00:00Z");
  const capped = capRequests({ minutes: { from: "2020-01-01T00:00:00Z", to: "2030-01-01T00:00:00Z" }, hourly: { from: "2020-01-01T00:00:00Z", to: "2026-01-31T00:00:00Z" }, activity: Array.from({ length: 50 }, (_, i) => `k${i}`), junk: true }, now);
  assert.equal(Date.parse(capped.minutes.to) - Date.parse(capped.minutes.from), 86_400_000);
  assert.ok(Date.parse(capped.minutes.to) <= now + 60_000);
  assert.equal(Date.parse(capped.hourly.to) - Date.parse(capped.hourly.from), 35 * 86_400_000);
  assert.equal(capped.activity.length, 10);
  assert.equal(capped.junk, undefined);
  assert.deepEqual(capRequests({ minutes: { from: "nope", to: 5 } }, now), {});
});

test("a signed block command blocks that key and nothing else, and a signed restore puts back exactly what it had", async () => {
  const ref = await refOf("places-server");
  const before = (await keyNamed("places-server")).restrictions;
  const block = command("block", ref);
  const keyll = withCommands(block);
  const summary = await runOnce({ ...deps(), keyll });
  assert.equal(summary.executed, 1);
  assert.deepEqual(keyll.sent.results[0], { id: block.id, ok: true, blockedAt: keyll.sent.results[0].blockedAt, method: "restrictions" });
  assert.equal(await callApi("places-server", "places.googleapis.com"), 403);
  assert.equal(await callApi("gemini-backend", "generativelanguage.googleapis.com"), 200);
  const marked = await keyNamed("places-server");
  assert.equal(marked.annotations[ANNOTATIONS.incident], block.incidentId);
  assert.equal(marked.annotations[ANNOTATIONS.command], block.id);

  const next = fakeKeyll();
  await runOnce({ ...deps(), keyll: next });
  assert.deepEqual(next.sent.hellos[0].keys.find((k) => k.displayName === "places-server").blocked.incidentId, block.incidentId);

  const restore = command("restore", ref, block.incidentId);
  const r = withCommands(restore);
  await runOnce({ ...deps(), keyll: r });
  assert.equal(r.sent.results[0].ok, true);
  assert.deepEqual((await keyNamed("places-server")).restrictions, before);
  assert.equal(await callApi("places-server", "places.googleapis.com"), 200);
});

test("a restore for an incident that didn't block the key does nothing", async () => {
  const ref = await refOf("maps-website");
  const keyll = withCommands(command("block", ref));
  await runOnce({ ...deps(), keyll });
  const wrong = withCommands(command("restore", ref));
  await runOnce({ ...deps(), keyll: wrong });
  assert.equal(wrong.sent.results[0].reason, "not-blocked-by-this-incident");
  assert.equal(await callApi("maps-website", "maps-backend.googleapis.com"), 403);
});

test("the local rails refuse blocks, and say why: dry run, never-block, the hourly cap", async () => {
  const ref = await refOf("maps-website");
  const dry = withCommands(command("block", ref));
  await runOnce({ ...deps({ KEYLL_MODE: "dry-run" }), keyll: dry });
  assert.equal(dry.sent.results[0].reason, "dry-run");

  const prot = withCommands(command("block", ref));
  await runOnce({ ...deps({ KEYLL_PROTECTED_KEYS: "maps-website" }), keyll: prot });
  assert.equal(prot.sent.results[0].reason, "protected");

  const capped = withCommands(command("block", ref));
  await runOnce({ ...deps({ KEYLL_MAX_BLOCKS_PER_HOUR: "0" }), keyll: capped });
  assert.equal(capped.sent.results[0].reason, "block-limit");
  assert.equal(await callApi("maps-website", "maps-backend.googleapis.com"), 200, "the key was never touched");
});

test("forged, foreign, expired and replayed commands are rejected and reported", async () => {
  const ref = await refOf("maps-website");
  const forged = command("block", ref, undefined, {}, strangerKey);
  const foreign = command("block", ref, undefined, { watcherId: "00000000-0000-4000-8000-0000000000ff" });
  const expired = command("block", ref, undefined, { issuedAt: new Date(Date.now() - 600_000).toISOString(), expiresAt: new Date(Date.now() - 60_000).toISOString() });
  const keyll = withCommands(forged, foreign, expired);
  const summary = await runOnce({ ...deps(), keyll });
  assert.equal(summary.rejected, 3);
  assert.deepEqual(keyll.sent.results.map((r) => r.reason), ["unknown-signing-key", "wrong-watcher", "expired"]);
  assert.equal(await callApi("maps-website", "maps-backend.googleapis.com"), 200);

  // A block, its restore, then the block again: the replay is older than the key's last command.
  const block = command("block", ref);
  await runOnce({ ...deps(), keyll: withCommands(block) });
  await runOnce({ ...deps(), keyll: withCommands(command("restore", ref, block.incidentId)) });
  const replay = withCommands(block);
  await runOnce({ ...deps(), keyll: replay });
  assert.equal(replay.sent.results[0].reason, "replayed");
  assert.equal(await callApi("maps-website", "maps-backend.googleapis.com"), 200);
});

test("if Keyll can't be reached, the watcher reads nothing and changes nothing", async () => {
  const keyll = {
    sent: { readings: 0 },
    hello: async () => {
      throw new Error("connect ECONNREFUSED");
    },
    readings: async () => {
      keyll.sent.readings++;
      return { commands: [] };
    },
    commandResult: async () => ({}),
  };
  const before = await keys();
  const summary = await runOnce({ ...deps(), keyll });
  assert.match(summary.errors[0], /Couldn't reach Keyll/);
  assert.equal(keyll.sent.readings, 0);
  assert.deepEqual((await keys()).map((k) => k.restrictions), before.map((k) => k.restrictions));
});

test("commands that come back with the readings run in the same run", async () => {
  const ref = await refOf("maps-website");
  const keyll = fakeKeyll({ hello: () => ({ requests: { minutes: lastHour() }, commands: [] }), readings: () => ({ commands: [command("block", ref)] }) });
  const summary = await runOnce({ ...deps(), keyll });
  assert.equal(summary.executed, 1);
  assert.equal(await callApi("maps-website", "maps-backend.googleapis.com"), 403);
  assert.equal(keyll.sent.hellos[0].keys.length, 5);
  assert.ok(WATCHER_ID);
});
