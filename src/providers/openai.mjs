/**
 * OpenAI: project API keys (user and service account keys) and per-key usage from the Admin API, with an Admin
 * API key (OPENAI_ADMIN_KEY).
 *
 * Calls it makes:
 *   GET  /v1/organization/projects                        projects
 *   GET  /v1/organization/projects/{id}/api_keys          each project's keys
 *   GET  /v1/organization/usage/{completions,…}           model requests per key and model, one-minute buckets
 *   GET  /v1/organization/costs                           dollars per key per day, when Keyll asks for it
 *   GET  /v1/organization/audit_logs                      api_key.created and api_key.updated events: whether a
 *                                                         key has all permissions or restricted ones (a summary
 *                                                         goes to Keyll, never the permissions themselves)
 * With KEYLL_OPENAI_BLOCK=recorded-scopes, also:
 *   POST /v1/organization/projects/{p}/api_keys/{k}       {"scopes": [...]} to block and to restore
 *
 * Alerts only by default. OpenAI's one block that keeps a key's secret replaces its permissions, but the API
 * never says what a key's permissions are, and "scopes": [] means all of them. So a block needs the opt-in,
 * and only goes ahead for a key whose current permissions the audit log records. The watcher saves those
 * permissions in its local ledger, sets the key to read-only (["api.all.read"]: no model requests), and on
 * restore writes back exactly what it saved. If the audit log shows someone else changed the key's permissions
 * while it was blocked, the restore keeps their change. The watcher never deletes or expires a key.
 */
import { HttpError, requestJson } from "../http.mjs";
import { blockMarker, createLedger, ledgerRails, recordBlock } from "../ledger.mjs";
import { hoursOf, pacer, serviceFor, toSeries } from "./common.mjs";

/** Read-only: lists and reads, no model requests. */
export const BLOCK_SCOPES = ["api.all.read"];
/** Usage endpoints that group by api_key_id and count model requests. */
export const USAGE_ENDPOINTS = ["completions", "embeddings", "moderations", "images", "audio_speeches", "audio_transcriptions"];
const sameScopes = (a, b) => JSON.stringify([...a].sort()) === JSON.stringify([...b].sort());

/** The scopes an audit event says a key was given, or undefined when it says nothing about scopes. */
export function scopesFromEvent(event) {
  const detail = event[event.type] || {};
  const scopes = event.type === "api_key.created" ? detail.data?.scopes : (detail.changes_requested?.scopes ?? detail.data?.scopes);
  return Array.isArray(scopes) && scopes.every((s) => typeof s === "string") ? scopes : undefined;
}

export function createOpenAIProvider(config) {
  const base = `${config.endpoints.openai}/v1/organization`;
  const ledger = createLedger(config, "openai");
  // Management endpoints answer 429 past an undocumented limit. Space calls out.
  const pace = pacer(config.requestGapMs ?? 250);

  async function openai(pathname, options = {}) {
    await pace();
    return requestJson(`${base}${pathname}`, { ...options, retries: 4, headers: { Authorization: `Bearer ${config.openaiAdminKey}`, "User-Agent": "keyll-watcher" } });
  }

  async function paged(pathname, params = {}) {
    const out = [];
    let after = "";
    for (;;) {
      const q = new URLSearchParams({ limit: "100", ...params });
      if (after) q.set("after", after);
      const data = await openai(`${pathname}?${q}`);
      out.push(...(data?.data || []));
      if (!data?.has_more || !data.last_id) return out;
      after = data.last_id;
    }
  }

  async function listKeys() {
    const st = ledger.load();
    const keys = [];
    for (const project of await paged("/projects")) {
      if (project.status && project.status !== "active") continue;
      for (const k of await paged(`/projects/${encodeURIComponent(project.id)}/api_keys`, { owner_project_access: "any" })) {
        const sa = k.owner?.type === "service_account";
        keys.push({
          keyId: k.id,
          uid: k.id,
          displayName: k.name || (sa ? k.owner.service_account?.name : "") || "",
          createdAt: k.created_at ? new Date(k.created_at * 1000).toISOString() : null,
          restrictions: { apiTargets: [], kind: "none", unrestricted: false },
          details: {
            projectId: project.id,
            projectName: project.name || "",
            owner: sa ? "service-account" : "user",
            ownerProjectAccess: k.owner_project_access || null,
            lastUsedAt: k.last_used_at ? new Date(k.last_used_at * 1000).toISOString() : null,
            expiresAt: k.expires_at ? new Date(k.expires_at * 1000).toISOString() : null,
          },
          blocked: blockMarker(st, k.id),
          projectId: project.id,
        });
      }
    }
    return keys;
  }

  /** Model requests per key, model and minute, from every usage endpoint: cells of [key, model, minute, requests]. */
  async function minuteCells(from, to) {
    const cells = new Map();
    for (const endpoint of USAGE_ENDPOINTS) {
      let page = "";
      try {
        for (;;) {
          const q = new URLSearchParams({ start_time: String(Math.floor(from / 1000)), end_time: String(Math.floor(to / 1000)), bucket_width: "1m", limit: "1440" });
          q.append("group_by", "api_key_id");
          q.append("group_by", "model");
          if (page) q.set("page", page);
          const data = await openai(`/usage/${endpoint}?${q}`);
          for (const bucket of data?.data || []) {
            const minute = Math.floor((bucket.start_time * 1000) / 60_000) * 60_000;
            for (const r of bucket.results || []) {
              if (!r.api_key_id || !(r.num_model_requests > 0)) continue;
              const service = serviceFor(r.model || endpoint);
              const id = `${r.api_key_id}|${service}|${minute}`;
              const cell = cells.get(id) || [r.api_key_id, service, minute, 0];
              cell[3] += r.num_model_requests;
              cells.set(id, cell);
            }
          }
          if (!data?.has_more || !data.next_page) break;
          page = data.next_page;
        }
      } catch (error) {
        // An endpoint this organization doesn't have. Anything else (permissions, outages) stops the read.
        if (!(error instanceof HttpError) || error.status !== 404) throw error;
      }
    }
    return cells;
  }

  /** Every api_key.created and api_key.updated event, oldest first. */
  async function keyEvents() {
    const events = [];
    let after = "";
    for (;;) {
      const q = new URLSearchParams({ limit: "100" });
      q.append("event_types[]", "api_key.created");
      q.append("event_types[]", "api_key.updated");
      if (after) q.set("after", after);
      const data = await openai(`/audit_logs?${q}`);
      events.push(...(data?.data || []));
      if (!data?.has_more || !data.last_id) break;
      after = data.last_id;
    }
    // Newest first from the API; reverse before the stable sort so events in the same second keep their order.
    return events.reverse().sort((a, b) => a.effective_at - b.effective_at);
  }

  /** Each key's latest recorded scopes and when they were set, from the audit log. */
  async function recordedScopes() {
    const latest = new Map();
    for (const e of await keyEvents()) {
      const id = e[e.type]?.id;
      const scopes = scopesFromEvent(e);
      if (id && scopes) latest.set(id, { scopes, at: e.effective_at });
    }
    return latest;
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
    if (requests.costs) {
      const rows = [];
      let page = "";
      for (;;) {
        const q = new URLSearchParams({ start_time: String(Math.floor(Date.parse(requests.costs.from) / 1000)), bucket_width: "1d", limit: "31" });
        q.append("group_by", "api_key_id");
        if (page) q.set("page", page);
        const data = await openai(`/costs?${q}`);
        for (const bucket of data?.data || []) {
          const day = new Date(bucket.start_time * 1000).toISOString().slice(0, 10);
          for (const r of bucket.results || []) if (r.api_key_id && Number.isFinite(Number(r.amount?.value))) rows.push({ key: r.api_key_id, day, model: "", usd: Number(r.amount.value) });
        }
        if (!data?.has_more || !data.next_page) break;
        page = data.next_page;
      }
      const known = new Set(keys.map((k) => k.uid));
      out.daily = { kind: "openai-costs", keys: keys.map((k) => k.uid), rows: rows.filter((r) => known.has(r.key)) };
    }
    if (requests.scopes) {
      // Only a summary leaves: all permissions, restricted, or not in the audit log.
      let recorded = new Map();
      try {
        recorded = await recordedScopes();
      } catch (error) {
        if (!(error instanceof HttpError) || ![403, 404].includes(error.status)) throw error;
      }
      out.scopes = keys.map((k) => {
        const r = recorded.get(k.uid);
        return { key: k.uid, summary: !r ? "unknown" : r.scopes.length === 0 ? "all" : "restricted" };
      });
    }
    return out;
  }

  const updateScopes = (key, scopes) => openai(`/projects/${encodeURIComponent(key.projectId)}/api_keys/${encodeURIComponent(key.uid)}`, { method: "POST", body: { scopes } });

  async function block(key, { incidentId, commandId, now = new Date() }) {
    if (!config.openaiBlock) return { refused: "alert-only-provider" };
    const st = ledger.load();
    if (st.blocks[key.uid]) return { alreadyBlocked: true, incidentId: st.blocks[key.uid].incidentId };
    const recorded = (await recordedScopes()).get(key.uid);
    if (!recorded) return { refused: "scopes-not-recorded" };
    if (key.details?.expiresAt && Date.parse(key.details.expiresAt) <= now.getTime()) throw new Error("The key has expired");
    recordBlock(st, key.uid, { incidentId, commandId, savedScopes: recorded.scopes, projectId: key.projectId }, now);
    ledger.save(st);
    try {
      await updateScopes(key, BLOCK_SCOPES);
    } catch (error) {
      delete st.blocks[key.uid];
      st.recent.pop();
      ledger.save(st);
      throw error;
    }
    return { blockedAt: now.toISOString(), method: "scopes-read-only" };
  }

  /** Writes back exactly the saved scopes, unless someone changed the key's scopes by hand while it was blocked. */
  async function restore(key, { incidentId, now = new Date() }) {
    const st = ledger.load();
    const b = st.blocks[key.uid];
    if (!b || b.incidentId !== incidentId) return { ok: false, reason: "not-blocked-by-this-incident" };
    if (!Array.isArray(b.savedScopes)) return { ok: false, reason: "no-saved-scopes" };
    const latest = (await recordedScopes()).get(key.uid);
    const blockedAt = Date.parse(b.blockedAt) / 1000;
    if (latest && latest.at >= blockedAt - 120 && !sameScopes(latest.scopes, BLOCK_SCOPES)) {
      delete st.blocks[key.uid];
      ledger.save(st);
      return { ok: true, restoredAt: now.toISOString(), note: "changed-outside-keyll" };
    }
    if (key.details?.expiresAt && Date.parse(key.details.expiresAt) <= now.getTime()) return { ok: false, reason: "key-expired" };
    await updateScopes({ ...key, projectId: key.projectId || b.projectId }, b.savedScopes);
    delete st.blocks[key.uid];
    ledger.save(st);
    return { ok: true, restoredAt: now.toISOString() };
  }

  return {
    id: "openai",
    unit: "requests",
    capabilities: { block: config.openaiBlock ? "scopes" : "none", restore: true },
    scopeId: async () => config.scopeLabel || "openai",
    listKeys,
    read,
    block,
    restore,
    isSelf: () => false,
    ...ledgerRails(ledger),
  };
}
