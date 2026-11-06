/** The local safety rails, one by one. */
import assert from "node:assert/strict";
import { test } from "node:test";
import { railsCheck } from "../src/rails.mjs";

const key = { uid: "uid-1", keyId: "key-1", displayName: "checkout-service" };
const cmd = (action, over = {}) => ({ action, seq: 10, key: { uid: "uid-1", keyId: "key-1" }, ...over });
const config = { mode: "enforce", protectedKeys: [], maxBlocksPerHour: 3, allowDelete: false };
const provider = { capabilities: { block: "restrictions" }, isSelf: () => false };
const check = (c, k = key, over = {}) => railsCheck(c, k, { config: { ...config, ...over.config }, provider: over.provider || provider, blocksLastHour: over.blocks ?? 0, lastSeq: over.lastSeq ?? 0 });

test("a block runs only when every rail allows it", () => {
  assert.equal(check(cmd("block")), null);
});

test("dry run, never-block keys, the watcher's own key and the hourly cap stop a block", () => {
  assert.equal(check(cmd("block"), key, { config: { mode: "dry-run" } }), "dry-run");
  assert.equal(check(cmd("block"), key, { config: { protectedKeys: ["checkout-service"] } }), "protected");
  assert.equal(check(cmd("block"), { ...key, self: true }), "watcher-key");
  assert.equal(check(cmd("block"), key, { blocks: 3 }), "block-limit");
});

test("delete-only blocks need KEYLL_ALLOW_DELETE, and alert-only providers never block", () => {
  const destructive = { capabilities: { block: "none", destructive: true }, isSelf: () => false };
  assert.equal(check(cmd("block"), key, { provider: destructive }), "destructive-not-allowed");
  assert.equal(check(cmd("block"), key, { provider: { capabilities: { block: "none" }, isSelf: () => false } }), "alert-only-provider");
  assert.equal(check(cmd("block"), key, { provider: { capabilities: { block: "delete", destructive: true }, isSelf: () => false }, config: { allowDelete: true } }), null);
});

test("an old or repeated sequence number is a replay", () => {
  assert.equal(check(cmd("block"), key, { lastSeq: 10 }), "replayed");
  assert.equal(check(cmd("restore"), key, { lastSeq: 11 }), "replayed");
});

test("a restore isn't stopped by dry run or the never-block list: it only undoes the watcher's own block", () => {
  assert.equal(check(cmd("restore"), key, { config: { mode: "dry-run", protectedKeys: ["key-1"] } }), null);
});

test("an unknown key, or a key ID that doesn't match, is refused", () => {
  assert.equal(check(cmd("block"), null), "unknown-key");
  assert.equal(check(cmd("block", { key: { uid: "uid-1", keyId: "other" } })), "key-mismatch");
});
