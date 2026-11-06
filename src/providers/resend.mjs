/**
 * Resend: API keys and the request log, with a full-access API key (RESEND_API_KEY). Resend has no narrower
 * admin scope.
 *
 * Calls it makes, and nothing else:
 *   GET    /api-keys              keys: id, name, created_at, last_used_at
 *   GET    /logs, /logs/{id}      the request log, from where the last readings stopped (Keyll says where)
 *   DELETE /api-keys/{id}         only with KEYLL_ALLOW_DELETE=true: Resend can't disable a key, and a deleted
 *                                 key can't come back
 *
 * Resend's log doesn't say which key made each request. The watcher sends Keyll each send request's time,
 * endpoint, status and number of emails, plus each key's last-use time, exactly as Resend gives them, and Keyll
 * works out which key sent what. The log also holds email contents and recipients: the watcher reads them only
 * to count the emails in a batch, and never keeps or sends them.
 */
import { requestJson } from "../http.mjs";
import { blockMarker, createLedger, ledgerRails, recordBlock } from "../ledger.mjs";
import { pacer } from "./common.mjs";

const USER_AGENT = "keyll-watcher";
const SEND_ENDPOINTS = new Set(["/emails", "/emails/batch"]);
/** The most log pages read in one run. */
const MAX_PAGES = 20;

/** Resend's timestamps: "2026-10-14 17:52:47.482621+00". */
function isoOf(value) {
  const t = Date.parse(String(value || "").replace(" ", "T").replace(/\+00(:00)?$/, "Z"));
  return Number.isFinite(t) ? new Date(t).toISOString() : null;
}

export function createResendProvider(config) {
  const base = config.endpoints.resend;
  const ledger = createLedger(config, "resend");
  // Resend allows about 10 requests a second per team, shared with your own sending. Stay well under it.
  const pace = pacer(config.requestGapMs ?? 350);
  // The watcher's own key, found from its own requests in the log. Kept in the ledger, so it's never blocked.
  let selfKeyId = ledger.load().selfKeyId || null;
  let lastRaw = [];

  async function resend(pathname, options = {}) {
    await pace();
    return requestJson(`${base}${pathname}`, { ...options, retries: 4, headers: { Authorization: `Bearer ${config.resendApiKey}`, "User-Agent": USER_AGENT } });
  }

  async function listKeys() {
    const st = ledger.load();
    lastRaw = (await resend("/api-keys"))?.data || [];
    return lastRaw.map((k) => ({
      keyId: k.id,
      uid: k.id,
      displayName: k.name || "",
      createdAt: isoOf(k.created_at),
      // Resend's API doesn't say whether a key is full-access or sending-only, or which domain it's limited to.
      restrictions: { apiTargets: [], kind: "none", unrestricted: false },
      details: null,
      blocked: blockMarker(st, k.id),
      self: k.id === selfKeyId,
    }));
  }

  /** Number of emails in one logged send. Only the count is kept; the request body is dropped here. */
  async function sendCount(log) {
    if (log.endpoint !== "/emails/batch" || log.response_status >= 400) return 1;
    try {
      const detail = await resend(`/logs/${encodeURIComponent(log.id)}`);
      return Array.isArray(detail?.response_body?.data) ? detail.response_body.data.length : 1;
    } catch {
      return 1;
    }
  }

  async function read(requests) {
    if (!requests.logs) return {};
    const after = requests.logs.after;
    const keys = lastRaw.map((k) => ({ key: k.id, lastUsedAt: k.last_used_at ?? null }));
    if (!after) {
      // No cursor yet: only report where the log ends, so counting starts from now.
      const first = await resend("/logs?limit=1");
      return { logs: { entries: [], latestId: first?.data?.[0]?.id || null, keys } };
    }
    const fresh = [];
    let cursor = "";
    for (let page = 0; page < MAX_PAGES; page++) {
      const data = await resend(`/logs?limit=100${cursor ? `&after=${encodeURIComponent(cursor)}` : ""}`);
      const items = data?.data || [];
      let reached = false;
      for (const log of items) {
        if (log.id === after) {
          reached = true;
          break;
        }
        fresh.push(log);
      }
      if (reached || !data?.has_more || !items.length) break;
      cursor = items[items.length - 1].id;
    }
    // The watcher's own requests carry its user agent; their timestamp names the watcher's key.
    const ownStamps = new Set(fresh.filter((l) => l.user_agent === USER_AGENT).map((l) => l.created_at));
    const self = lastRaw.find((k) => k.last_used_at && ownStamps.has(k.last_used_at));
    if (self && self.id !== selfKeyId) {
      selfKeyId = self.id;
      const st = ledger.load();
      st.selfKeyId = selfKeyId;
      ledger.save(st);
    }
    const entries = [];
    for (const log of fresh.reverse()) {
      const send = log.method === "POST" && SEND_ENDPOINTS.has(log.endpoint);
      if (!send && log.user_agent !== USER_AGENT) continue;
      entries.push({
        id: log.id,
        at: log.created_at,
        method: log.method,
        endpoint: log.endpoint,
        status: log.response_status,
        count: send ? await sendCount(log) : 0,
        self: log.user_agent === USER_AGENT,
      });
    }
    return { logs: { entries, latestId: fresh.length ? fresh[fresh.length - 1].id : after, keys } };
  }

  async function block(key, { incidentId, commandId, now = new Date() }) {
    if (!config.allowDelete) return { refused: "destructive-not-allowed" };
    if (key.self || key.uid === selfKeyId) return { refused: "watcher-key" };
    const st = ledger.load();
    recordBlock(st, key.uid, { incidentId, commandId }, now);
    ledger.save(st);
    await resend(`/api-keys/${encodeURIComponent(key.uid)}`, { method: "DELETE" });
    const remaining = (await resend("/api-keys"))?.data || [];
    if (remaining.some((k) => k.id === key.uid)) throw new Error("Resend accepted the delete, but the key is still listed");
    return { blockedAt: now.toISOString(), method: "deleted" };
  }

  async function restore() {
    return { ok: false, reason: "not-supported", error: "Resend can't bring a deleted key back. Create a new key and update the app that used it." };
  }

  return {
    id: "resend",
    unit: "emails",
    capabilities: { block: config.allowDelete ? "delete" : "none", restore: false, destructive: true },
    scopeId: async () => config.scopeLabel || "resend",
    listKeys,
    read,
    block,
    restore,
    isSelf: (key) => !!key.self || key.uid === selfKeyId,
    ...ledgerRails(ledger),
  };
}
