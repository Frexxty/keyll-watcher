/** Every way a command can fail verification, and the one way it passes. */
import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { test } from "node:test";
import { CommandRejected, trustedKeys, verifyCommand } from "../src/signing.mjs";
import { TRUSTED_KEYS } from "../src/trusted-keys.mjs";
import { command, strangerKey, trusted, WATCHER_ID, WORKSPACE_ID } from "./helpers.mjs";

const key = { uid: "uid-1", keyId: "key-1" };
const expect = { watcherId: WATCHER_ID, workspaceId: WORKSPACE_ID };
const reason = (fn) => {
  try {
    fn();
  } catch (error) {
    assert.ok(error instanceof CommandRejected);
    return error.reason;
  }
  return null;
};

test("a command signed by a trusted key, for this workspace and watcher, verifies", () => {
  const c = command("block", key);
  const v = verifyCommand(c, trusted, expect);
  assert.equal(v.action, "block");
  assert.deepEqual(v.key, key);
});

test("rejects a signature from any other key, or a key it doesn't know", () => {
  assert.equal(reason(() => verifyCommand(command("block", key, undefined, {}, strangerKey), trusted, expect)), "unknown-signing-key");
  assert.equal(reason(() => verifyCommand({ ...command("block", key, undefined, {}, strangerKey), kid: trusted[0].kid }, trusted, expect)), "bad-signature");
});

test("rejects a payload changed after signing", () => {
  const c = command("restore", key);
  const changed = { ...c, payload: c.payload.replace('"restore"', '"block"') };
  assert.equal(reason(() => verifyCommand(changed, trusted, expect)), "bad-signature");
});

test("rejects commands for another watcher or workspace", () => {
  assert.equal(reason(() => verifyCommand(command("block", key, undefined, { watcherId: "00000000-0000-4000-8000-0000000000ff" }), trusted, expect)), "wrong-watcher");
  assert.equal(reason(() => verifyCommand(command("block", key, undefined, { workspaceId: "00000000-0000-4000-8000-0000000000ff" }), trusted, expect)), "wrong-workspace");
});

test("rejects expired, future-dated and long-lived commands", () => {
  const now = Date.now();
  assert.equal(reason(() => verifyCommand(command("block", key, undefined, { issuedAt: new Date(now - 600_000).toISOString(), expiresAt: new Date(now - 1).toISOString() }), trusted, expect)), "expired");
  assert.equal(reason(() => verifyCommand(command("block", key, undefined, { issuedAt: new Date(now + 600_000).toISOString(), expiresAt: new Date(now + 700_000).toISOString() }), trusted, expect)), "issued-in-future");
  assert.equal(reason(() => verifyCommand(command("block", key, undefined, { expiresAt: new Date(now + 3_600_000).toISOString() }), trusted, expect)), "validity-too-long");
});

test("rejects unknown actions, versions and audiences, and malformed fields", () => {
  assert.equal(reason(() => verifyCommand(command("delete", key), trusted, expect)), "unknown-action");
  assert.equal(reason(() => verifyCommand(command("block", key, undefined, { v: 1 }), trusted, expect)), "unsupported-version");
  assert.equal(reason(() => verifyCommand(command("block", key, undefined, { aud: "something-else" }), trusted, expect)), "wrong-audience");
  assert.equal(reason(() => verifyCommand(command("block", key, undefined, { seq: 0 }), trusted, expect)), "malformed");
  assert.equal(reason(() => verifyCommand(command("block", key, "not-a-uuid"), trusted, expect)), "malformed");
  assert.equal(reason(() => verifyCommand({ payload: "{", signature: "" }, trusted, expect)), "malformed");
});

test("the built-in trusted keys load, are Ed25519, and duplicates are dropped", () => {
  const keys = trustedKeys([TRUSTED_KEYS[0]]);
  assert.equal(keys.length, TRUSTED_KEYS.length);
  assert.ok(keys.every((k) => /^[0-9a-f]{16}$/.test(k.kid)));
  const rsa = generateKeyPairSync("rsa", { modulusLength: 2048 }).publicKey.export({ type: "spki", format: "der" }).toString("base64");
  assert.throws(() => trustedKeys([rsa]), /Ed25519/);
});
