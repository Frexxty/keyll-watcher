import assert from "node:assert/strict";
import { test } from "node:test";
import { KEY_STRING, splitReadings, toKeyll } from "../src/keyll.mjs";

test("refuses anything shaped like a provider key, and lets redacted hints and names through", () => {
  const keys = [
    `AIza${"A".repeat(35)}`,
    `sk-ant-api03-${"a".repeat(90)}`,
    `sk-ant-admin01-${"b".repeat(60)}`,
    `sk-or-v1-${"0f".repeat(32)}`,
    `sk-proj-${"Ab_".repeat(40)}`,
    `sk-svcacct-${"x".repeat(60)}`,
    `sk-admin-${"y".repeat(60)}`,
    `sk-${"Z9".repeat(24)}`,
    `re_${"r".repeat(30)}`,
  ];
  for (const k of keys) assert.throws(() => toKeyll({ note: k }), /API key string/, k.slice(0, 10));
  for (const ok of ["sk-ant-api03-R2D...igAA", "sk-or-v1-0e6...1c96", "sk-production-backend-key", "claude-sonnet-4-5"]) assert.ok(!KEY_STRING.test(ok), ok);
});

test("large readings are split by key, each part naming the keys it replaces", () => {
  const big = "x".repeat(2000);
  const series = Array.from({ length: 1000 }, (_, i) => ({ key: `k${i % 20}`, service: `s${i}`, points: [[1, 1, 0]], pad: big }));
  const parts = splitReadings({ protocol: 2, ranAt: "t", minutes: { from: "a", to: "b", keys: Array.from({ length: 21 }, (_, i) => `k${i}`), series }, counters: [{ key: "k1" }] });
  assert.ok(parts.length > 1);
  assert.ok(parts.every((p) => JSON.stringify(p).length < 1_100_000));
  assert.equal(parts.flatMap((p) => p.minutes.series).length, 1000);
  assert.deepEqual(parts.flatMap((p) => p.minutes.keys).sort(), Array.from({ length: 21 }, (_, i) => `k${i}`).sort());
  assert.equal(parts.filter((p) => p.counters).length, 1);
});
