/**
 * Anthropic (Claude API): API keys and per-key token usage from the Admin API, with a Claude Console Admin API
 * key (ANTHROPIC_ADMIN_KEY).
 *
 * Calls it makes, and nothing else:
 *   GET  /v1/organizations/api_keys                 list keys: id, name, status, workspace, creation, expiry
 *   GET  /v1/organizations/api_keys/{id}            re-read one key before and after changing it
 *   POST /v1/organizations/api_keys/{id}            {"status": "inactive"} to block, {"status": "active"} to restore
 *   GET  /v1/organizations/usage_report/messages    tokens per key and model, in one-minute buckets
 *
 * The Admin API key has no scopes: it can also rename keys, manage members and archive workspaces. It can't
 * create API keys or read their secrets; list and get return only a partial hint, which the watcher drops.
 * The watcher never sends "archived", which can't be undone.
 *
 * Blocking sets the key to inactive and restoring sets it back to active, with the same secret. Anthropic keys
 * can't carry a marker, so the watcher records its blocks in its local ledger (see src/ledger.mjs).
 */
import { requestJson } from "../http.mjs";
import { blockMarker, createLedger, ledgerRails, recordBlock } from "../ledger.mjs";
import { hoursOf, pacer, serviceFor, toSeries } from "./common.mjs";

const VERSION = "2023-06-01";

/** Every token a usage row counts: uncached input, cache writes, cache reads and output. */
export function tokensOf(r) {
  return (
    (r.uncached_input_tokens || 0) +
    (r.cache_creation?.ephemeral_5m_input_tokens || 0) +
    (r.cache_creation?.ephemeral_1h_input_tokens || 0) +
    (r.cache_read_input_tokens || 0) +
    (r.output_tokens || 0)
  );
}

export function createAnthropicProvider(config) {
  const base = config.endpoints.anthropic;
  const ledger = createLedger(config, "anthropic");
  // Anthropic supports polling the usage report about once a minute, with short bursts for pagination.
  const pace = pacer(config.requestGapMs ?? 250);

  async function anthropic(pathname, options = {}) {
    await pace();
    return requestJson(`${base}${pathname}`, {
      ...options,
      retries: 4,
      headers: { "x-api-key": config.anthropicAdminKey, "anthropic-version": VERSION, "User-Agent": "keyll-watcher" },
    });
  }

  /** Active and inactive keys. Archived and expired keys can't be used or restored. */
  async function listRaw() {
    const out = [];
    for (const status of ["active", "inactive"]) {
      let after = "";
      for (;;) {
        const q = new URLSearchParams({ limit: "1000", status });
        if (after) q.set("after_id", after);
        const data = await anthropic(`/v1/organizations/api_keys?${q}`);
        out.push(...(data?.data || []));
        if (!data?.has_more || !data.last_id) break;
        after = data.last_id;
      }
    }
    return out;
  }

  const getKey = (id) => anthropic(`/v1/organizations/api_keys/${encodeURIComponent(id)}`);
  const setStatus = (id, status) => anthropic(`/v1/organizations/api_keys/${encodeURIComponent(id)}`, { method: "POST", body: { status } });

  async function listKeys() {
    const st = ledger.load();
    return (await listRaw()).map((raw) => ({
      keyId: raw.id,
      uid: raw.id,
      displayName: raw.name || "",
      createdAt: raw.created_at || null,
      // Anthropic keys have no per-key restrictions to report.
      restrictions: { apiTargets: [], kind: "none", unrestricted: true },
      details: {
        status: raw.status,
        workspaceId: raw.scope?.workspace_id ?? raw.workspace_id ?? null,
        principal: raw.principal?.type === "service_account_actor" ? "service-account" : raw.principal?.type === "user_actor" ? "user" : null,
        expiresAt: raw.expires_at || null,
      },
      blocked: blockMarker(st, raw.id),
    }));
  }

  /** One-minute buckets for [from, to), grouped by key and model: cells of [key, model, minute, tokens]. */
  async function minuteCells(from, to) {
    const cells = new Map();
    let page = "";
    for (;;) {
      const q = new URLSearchParams({ starting_at: new Date(from).toISOString(), ending_at: new Date(to).toISOString(), bucket_width: "1m", limit: "1440" });
      q.append("group_by[]", "api_key_id");
      q.append("group_by[]", "model");
      if (page) q.set("page", page);
      const data = await anthropic(`/v1/organizations/usage_report/messages?${q}`);
      for (const bucket of data?.data || []) {
        const minute = Math.floor(Date.parse(bucket.starting_at) / 60_000) * 60_000;
        if (!Number.isFinite(minute)) continue;
        // Console usage has no api_key_id: it isn't any key's.
        for (const r of bucket.results || []) {
          const tokens = tokensOf(r);
          if (!r.api_key_id || !(tokens > 0)) continue;
          const service = serviceFor(r.model);
          const id = `${r.api_key_id}|${service}|${minute}`;
          const cell = cells.get(id) || [r.api_key_id, service, minute, 0];
          cell[3] += tokens;
          cells.set(id, cell);
        }
      }
      if (!data?.has_more || !data.next_page) break;
      page = data.next_page;
    }
    return cells;
  }

  async function read(requests, keys) {
    const out = {};
    if (requests.minutes) {
      const cells = await minuteCells(Date.parse(requests.minutes.from), Date.parse(requests.minutes.to));
      out.minutes = { ...requests.minutes, keys: keys.map((k) => k.uid), series: toSeries(cells, (c) => [c[2] / 1000, c[3], 0]) };
    }
    if (requests.hourly) {
      const cells = await minuteCells(Date.parse(requests.hourly.from), Date.parse(requests.hourly.to));
      out.hourly = { ...requests.hourly, series: toSeries(hoursOf(cells), (c) => [c[2] / 1000, c[3], c[4], 0]) };
    }
    return out;
  }

  async function block(key, { incidentId, commandId, now = new Date() }) {
    const st = ledger.load();
    if (st.blocks[key.uid]) return { alreadyBlocked: true, incidentId: st.blocks[key.uid].incidentId };
    const current = await getKey(key.uid);
    if (current?.status !== "active") throw new Error(`The key is ${current?.status || "missing"}, not active`);
    // Record first: if the watcher stops between the two calls, the next run still knows this block is its own.
    recordBlock(st, key.uid, { incidentId, commandId }, now);
    ledger.save(st);
    try {
      const updated = await setStatus(key.uid, "inactive");
      const after = updated?.status ? updated : await getKey(key.uid);
      if (after?.status !== "inactive") throw new Error(`Key update returned, but the status is ${after?.status}`);
    } catch (error) {
      delete st.blocks[key.uid];
      st.recent.pop();
      ledger.save(st);
      throw error;
    }
    return { blockedAt: now.toISOString(), method: "status-inactive" };
  }

  /** Back to active, only for a block this watcher made for this incident. */
  async function restore(key, { incidentId, now = new Date() }) {
    const st = ledger.load();
    const b = st.blocks[key.uid];
    if (!b || b.incidentId !== incidentId) return { ok: false, reason: "not-blocked-by-this-incident" };
    const current = await getKey(key.uid);
    if (current?.status === "active") {
      delete st.blocks[key.uid];
      ledger.save(st);
      return { ok: true, restoredAt: now.toISOString(), note: "changed-outside-keyll" };
    }
    if (current?.status !== "inactive") return { ok: false, reason: `key-${current?.status || "missing"}` };
    if (current.expires_at && Date.parse(current.expires_at) <= now.getTime()) return { ok: false, reason: "key-expired" };
    const updated = await setStatus(key.uid, "active");
    const after = updated?.status ? updated : await getKey(key.uid);
    if (after?.status !== "active") throw new Error(`Key update returned, but the status is ${after?.status}`);
    delete st.blocks[key.uid];
    ledger.save(st);
    return { ok: true, restoredAt: now.toISOString() };
  }

  return {
    id: "anthropic",
    unit: "tokens",
    capabilities: { block: "status-inactive", restore: true },
    scopeId: async () => config.scopeLabel || "anthropic",
    listKeys,
    read,
    block,
    restore,
    isSelf: () => false,
    ...ledgerRails(ledger),
  };
}
