import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { loadConfig, railsSummary } from "../src/config.mjs";

const local = (env = {}) => loadConfig({ KEYLL_URL: "https://keyll.example", ...env });

test("dry run by default, three blocks an hour at most, no deletes", () => {
  const c = local();
  assert.equal(c.mode, "dry-run");
  assert.equal(c.maxBlocksPerHour, 3);
  assert.equal(c.allowDelete, false);
  assert.equal(c.openaiBlock, false);
});

test("refuses a Keyll URL that isn't https, except localhost for tests", () => {
  assert.throws(() => loadConfig({ KEYLL_URL: "http://keyll.example" }), /https/);
  assert.equal(loadConfig({ KEYLL_URL: "http://127.0.0.1:3000" }).keyllUrl, "http://127.0.0.1:3000");
});

test("settings from earlier versions are listed as retired, not used", () => {
  const c = local({ KEYLL_ALERT_MULTIPLIER: "10", KEYLL_MIN_RATE: "60" });
  assert.deepEqual(c.retired.sort(), ["KEYLL_ALERT_MULTIPLIER", "KEYLL_MIN_RATE"]);
  assert.equal(c.alertMultiplier, undefined);
});

test("the rails report what was set locally", () => {
  const c = local({ KEYLL_MODE: "enforce", KEYLL_PROTECTED_KEYS: "a, b", KEYLL_MAX_BLOCKS_PER_HOUR: "1" });
  assert.deepEqual(railsSummary(c, 0), { mode: "enforce", protectedKeys: ["a", "b"], maxBlocksPerHour: 1, allowDestructive: false, blocksLastHour: 0 });
  assert.throws(() => local({ KEYLL_MODE: "on" }), /KEYLL_MODE/);
  assert.throws(() => local({ KEYLL_ALLOW_DELETE: "yes" }), /KEYLL_ALLOW_DELETE/);
});

test("provider credentials come from the environment or a secret file", () => {
  assert.throws(() => local({ KEYLL_PROVIDER: "anthropic" }), /ANTHROPIC_ADMIN_KEY/);
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "keyll-secret-")), "key");
  fs.writeFileSync(file, "test-admin-key-from-a-file\n");
  assert.equal(local({ KEYLL_PROVIDER: "openai", OPENAI_ADMIN_KEY_FILE: file }).openaiAdminKey, "test-admin-key-from-a-file");
  assert.equal(local({ KEYLL_PROVIDER: "gcp", ANTHROPIC_ADMIN_KEY: "x" }).anthropicAdminKey, "", "other providers' credentials aren't loaded");
  assert.throws(() => local({ KEYLL_PROVIDER: "unknown" }), /KEYLL_PROVIDER/);
});

test("extra trusted keys come from KEYLL_PUBLIC_KEYS, and from the older single-key setting", () => {
  assert.deepEqual(local({ KEYLL_PUBLIC_KEYS: "a,b", KEYLL_PUBLIC_KEY: "c" }).publicKeys, ["a", "b", "c"]);
});
