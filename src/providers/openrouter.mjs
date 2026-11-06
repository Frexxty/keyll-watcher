/**
 * OpenRouter: keys and their running spend, with a management key (OPENROUTER_MANAGEMENT_KEY).
 *
 * Calls it makes, and nothing else:
 *   GET   /v1/workspaces                  the account's workspaces (keys are listed per workspace)
 *   GET   /v1/keys?workspace_id=…         keys with their spend so far and their credit limit
 *   GET   /v1/keys/{hash}                 re-read one key before and after changing it
 *   PATCH /v1/keys/{hash}                 {"disabled": true} to block, {"disabled": false} to restore
 *   GET   /v1/activity?api_key_hash=…     one key's spend per day and model, when Keyll asks for it
 *
 * A management key is unscoped: it could also create and delete keys and change limits. This file never sends
 * POST /keys, DELETE, or a limit. List and get never return a key's secret, only its hash (the ID here) and a
 * redacted label, which the watcher drops.
 *
 * Readings are the raw running totals; Keyll works out what was spent between readings. Blocking sets
 * disabled: true and restoring sets it back, with the same secret, only for keys this watcher disabled.
 */
import { HttpError, requestJson } from "../http.mjs";
import { blockMarker, createLedger, ledgerRails, recordBlock } from "../ledger.mjs";
import { pacer } from "./common.mjs";

const round = (n) => Math.round(n * 1e6) / 1e6;

export function createOpenRouterProvider(config) {
  const base = config.endpoints.openrouter;
  const ledger = createLedger(config, "openrouter");
  const pace = pacer(config.requestGapMs ?? 200);

  async function openrouter(pathname, options = {}) {
    await pace();
    return requestJson(`${base}${pathname}`, { ...options, retries: 4, headers: { Authorization: `Bearer ${config.openrouterManagementKey}`, "User-Agent": "keyll-watcher" } });
  }

  /** Workspace IDs, or [null] where the workspaces API isn't available (only the default workspace). */
  async function workspaces() {
    const ids = [];
    try {
      for (let offset = 0; ; offset += 100) {
        const data = await openrouter(`/v1/workspaces?limit=100&offset=${offset}`);
        const page = data?.data || [];
        ids.push(...page.map((w) => w.id));
        if (page.length < 100 || ids.length >= (data?.total_count ?? Infinity)) break;
      }
    } catch (error) {
      if (!(error instanceof HttpError) || ![403, 404].includes(error.status)) throw error;
    }
    return ids.length ? ids : [null];
  }

  async function listRaw() {
    const byHash = new Map();
    for (const ws of await workspaces()) {
      for (let offset = 0; ; ) {
        const q = new URLSearchParams({ include_disabled: "true", offset: String(offset) });
        if (ws) q.set("workspace_id", ws);
        const page = (await openrouter(`/v1/keys?${q}`))?.data || [];
        for (const k of page) byHash.set(k.hash, k);
        if (!page.length || page.length < 100) break;
        offset += page.length;
      }
    }
    return [...byHash.values()];
  }

  const getKey = async (hash) => (await openrouter(`/v1/keys/${encodeURIComponent(hash)}`))?.data;
  const patchKey = async (hash, body) => (await openrouter(`/v1/keys/${encodeURIComponent(hash)}`, { method: "PATCH", body }))?.data;

  let lastRaw = [];
  async function listKeys() {
    const st = ledger.load();
    lastRaw = await listRaw();
    return lastRaw.map((k) => {
      const limit = k.limit === null || k.limit === undefined ? null : Number(k.limit);
      return {
        keyId: k.hash,
        uid: k.hash,
        displayName: k.name || "",
        createdAt: k.created_at || null,
        // No IP or model restrictions show up on the key itself. A credit limit is the one per-key cap.
        restrictions: { apiTargets: [], kind: "none", unrestricted: limit === null },
        details: {
          disabled: !!k.disabled,
          workspaceId: k.workspace_id || null,
          limitUsd: limit,
          limitRemainingUsd: k.limit_remaining ?? null,
          limitReset: k.limit_reset || null,
          expiresAt: k.expires_at || null,
          lastUsedAt: k.last_used_at || null,
        },
        blocked: blockMarker(st, k.hash),
      };
    });
  }

  /** Running totals for every key (credits plus BYOK), and daily activity for the keys Keyll asked about. */
  async function read(requests, keys, { now = Date.now() } = {}) {
    const out = {};
    if (requests.counters) {
      const at = new Date(now).toISOString();
      out.counters = lastRaw
        .filter((k) => keys.some((x) => x.uid === k.hash))
        .map((k) => ({
          key: k.hash,
          at,
          usd: round((Number(k.usage) || 0) + (Number(k.byok_usage) || 0)),
          dailyUsd: round((Number(k.usage_daily) || 0) + (Number(k.byok_usage_daily) || 0)),
        }));
    }
    if (requests.activity?.length) {
      const asked = requests.activity.filter((h) => keys.some((k) => k.uid === h));
      const rows = [];
      for (const hash of asked) {
        for (const r of (await openrouter(`/v1/activity?api_key_hash=${encodeURIComponent(hash)}`))?.data || [])
          rows.push({ key: hash, day: r.date, model: String(r.model || ""), usd: round((Number(r.usage) || 0) + (Number(r.byok_usage_inference) || 0)) });
      }
      out.daily = { kind: "openrouter-activity", keys: asked, rows };
    }
    return out;
  }

  async function block(key, { incidentId, commandId, now = new Date() }) {
    const st = ledger.load();
    if (st.blocks[key.uid]) return { alreadyBlocked: true, incidentId: st.blocks[key.uid].incidentId };
    const current = await getKey(key.uid);
    if (!current) throw new Error("The key no longer exists");
    if (current.disabled) throw new Error("The key is already disabled");
    recordBlock(st, key.uid, { incidentId, commandId }, now);
    ledger.save(st);
    try {
      const updated = await patchKey(key.uid, { disabled: true });
      if (updated?.disabled !== true) throw new Error("Key update returned, but the key isn't disabled");
    } catch (error) {
      delete st.blocks[key.uid];
      st.recent.pop();
      ledger.save(st);
      throw error;
    }
    return { blockedAt: now.toISOString(), method: "disabled" };
  }

  /** Enabled again, only for a key this watcher disabled for this incident. A key you disabled stays disabled. */
  async function restore(key, { incidentId, now = new Date() }) {
    const st = ledger.load();
    const b = st.blocks[key.uid];
    if (!b || b.incidentId !== incidentId) return { ok: false, reason: "not-blocked-by-this-incident" };
    const current = await getKey(key.uid);
    if (!current) return { ok: false, reason: "key-missing" };
    if (!current.disabled) {
      delete st.blocks[key.uid];
      ledger.save(st);
      return { ok: true, restoredAt: now.toISOString(), note: "changed-outside-keyll" };
    }
    const updated = await patchKey(key.uid, { disabled: false });
    if (updated?.disabled !== false) throw new Error("Key update returned, but the key is still disabled");
    delete st.blocks[key.uid];
    ledger.save(st);
    return { ok: true, restoredAt: now.toISOString() };
  }

  return {
    id: "openrouter",
    unit: "cents",
    capabilities: { block: "disabled", restore: true },
    scopeId: async () => config.scopeLabel || "openrouter",
    listKeys,
    read,
    block,
    restore,
    isSelf: () => false,
    ...ledgerRails(ledger),
  };
}
