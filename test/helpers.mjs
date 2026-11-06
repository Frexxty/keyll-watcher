/**
 * Shared by the tests: provider emulators, a test signing key standing in for Keyll's, signed commands, and a
 * fake Keyll that answers the watcher with whatever a test tells it to and records everything sent to it.
 * Every ID, token and key here is made up for tests.
 */
import { spawn } from "node:child_process";
import { generateKeyPairSync, randomUUID, sign } from "node:crypto";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { toKeyll } from "../src/keyll.mjs";
import { kidOf, loadPublicKey } from "../src/signing.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
export const WATCHER_ID = "00000000-0000-4000-8000-000000000001";
export const WORKSPACE_ID = "00000000-0000-4000-8000-000000000002";
export const TOKEN = "kw_test-token-for-unit-tests-only-not-a-real-token";

/** A test signing key, trusted through KEYLL_PUBLIC_KEYS like a key given at install. */
const signer = generateKeyPairSync("ed25519");
export const TEST_PUBLIC_KEY = signer.publicKey.export({ type: "spki", format: "der" }).toString("base64");
export const TEST_KID = kidOf(signer.publicKey.export({ type: "spki", format: "der" }));
export const trusted = [loadPublicKey(TEST_PUBLIC_KEY)];
const stranger = generateKeyPairSync("ed25519");

let seq = 0;
/** A signed command, valid for five minutes. `over` replaces any field; `key` signs with another key. */
export function command(action, keyRef, incidentId = randomUUID(), over = {}, { key = signer.privateKey, kid = TEST_KID } = {}) {
  const now = Date.now();
  const payload = JSON.stringify({
    v: 2,
    aud: "keyll-watcher",
    type: "command",
    kid,
    nonce: randomUUID(),
    issuedAt: new Date(now).toISOString(),
    expiresAt: new Date(now + 5 * 60_000).toISOString(),
    commandId: randomUUID(),
    seq: ++seq + 1000 * Math.floor(now / 1000),
    workspaceId: WORKSPACE_ID,
    watcherId: WATCHER_ID,
    action,
    key: { uid: keyRef.uid, keyId: keyRef.keyId },
    incidentId,
    ...over,
  });
  return { payload, signature: sign(null, Buffer.from(payload), key).toString("base64"), kid, id: JSON.parse(payload).commandId, incidentId, seq: JSON.parse(payload).seq };
}
export const strangerKey = { key: stranger.privateKey, kid: "0000000000000000" };

/**
 * A fake Keyll. `respond.hello(body)` and `respond.readings(body)` return what Keyll would answer; by default
 * no requests and no commands. Everything sent passes the real client's key-string check first.
 */
export function fakeKeyll(respond = {}) {
  const sent = { hellos: [], readings: [], results: [] };
  return {
    sent,
    hello: async (body) => (sent.hellos.push(toKeyll(body)), (respond.hello || (() => ({ requests: {}, commands: [] })))(body)),
    readings: async (body) => (sent.readings.push(toKeyll(body)), (respond.readings || (() => ({ commands: [] })))(body)),
    commandResult: async (id, body) => (sent.results.push({ id, ...toKeyll(body) }), { ok: true }),
  };
}

/** A port the OS says is free right now. */
export function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

export async function startEmulator(name) {
  const port = await freePort();
  const url = `http://127.0.0.1:${port}`;
  const child = spawn("node", [path.join(here, "emulators", name, "server.mjs")], { env: { ...process.env, PORT: String(port) }, stdio: "ignore" });
  for (let i = 0; i < 200; i++) {
    try {
      await fetch(`${url}/_emulator/keys`);
      return { url, stop: () => child.kill() };
    } catch {
      await new Promise((r) => setTimeout(r, 100));
    }
  }
  child.kill();
  throw new Error(`${name} emulator didn't start`);
}

export const tempDir = () => fs.mkdtempSync(path.join(os.tmpdir(), "keyll-watcher-test-"));

/** The environment every provider test shares: a local Keyll URL, test IDs, blocking allowed, no call spacing. */
export const baseEnv = (stateDir) => ({
  KEYLL_URL: "http://127.0.0.1:1",
  KEYLL_TOKEN: TOKEN,
  KEYLL_WATCHER_ID: WATCHER_ID,
  KEYLL_WORKSPACE_ID: WORKSPACE_ID,
  KEYLL_PUBLIC_KEYS: TEST_PUBLIC_KEY,
  KEYLL_MODE: "enforce",
  KEYLL_STATE_DIR: stateDir,
  KEYLL_REQUEST_GAP_MS: "0",
});

export const post = (url, body) => fetch(url, { method: "POST", body: JSON.stringify(body) }).then((r) => r.json());

/** The last hour, as Keyll would ask for it. */
export const lastHour = () => {
  const end = Math.floor(Date.now() / 60_000) * 60_000 + 60_000;
  return { from: new Date(end - 60 * 60_000).toISOString(), to: new Date(end).toISOString() };
};
