/**
 * A local stand-in for the parts of Anthropic's Admin API the watcher uses, plus the Messages API so a test
 * can see a blocked key being refused:
 *
 *   GET  /v1/organizations/api_keys                list keys (limit, after_id, status), admin key only
 *   GET  /v1/organizations/api_keys/{id}           one key
 *   POST /v1/organizations/api_keys/{id}           {"status": "active" | "inactive" | "archived"}; archived is final
 *   GET  /v1/organizations/usage_report/messages   token usage in 1m buckets, group_by[]=api_key_id and model,
 *                                                  oldest bucket first, empty buckets included, paged by next_page
 *   POST /v1/messages                              with an API key: 401 unless the key is active
 *
 * Like the real API, list and get return only a partial_key_hint, never the key.
 *
 * Test controls under /_emulator: reset, keys (with their secrets, for tests), inject usage, delay (minutes
 * of usage held back, like Anthropic's ~5 minute lag), ratelimit (the next N admin calls get 429 with
 * Retry-After), and stats (admin calls served).
 */
import { randomBytes } from "node:crypto";
import http from "node:http";

const port = Number(process.env.PORT || 4600);
const MINUTE = 60_000;
const DAY = 86_400_000;

const state = { keys: [], usage: new Map(), steady: [], delayMinutes: 0, rateLimit: { remaining: 0, retryAfter: 1 }, stats: { admin: 0, limited: 0 } };
const adminKey = () => state.keys.find((k) => k.admin);

function reset() {
  const now = Date.now();
  const id = () => `apikey_01${randomBytes(11).toString("hex")}`;
  const make = (name, { status = "active", createdDaysAgo = 30, admin = false, workspace = "wrkspc_01Prod" } = {}) => ({
    id: admin ? `adminkey_01${randomBytes(8).toString("hex")}` : id(),
    name,
    status,
    admin,
    secret: admin ? `sk-ant-admin01-${randomBytes(48).toString("base64url")}` : `sk-ant-api03-${randomBytes(72).toString("base64url")}`,
    created_at: new Date(now - createdDaysAgo * DAY).toISOString(),
    expires_at: null,
    workspace,
  });
  state.keys = [
    make("keyll-watcher", { admin: true }),
    make("production-app"),
    make("batch-jobs", { workspace: "wrkspc_01Batch" }),
    make("support-bot"),
    make("old-prototype", { status: "inactive" }),
  ];
  // Steady traffic, every minute for the last 8 days: tokens a minute on one model.
  state.steady = [
    { key: "production-app", model: "claude-sonnet-4-5-20250929", perMinute: 1500 },
    { key: "batch-jobs", model: "claude-haiku-4-5-20251001", perMinute: 400 },
    { key: "support-bot", model: "claude-haiku-4-5-20251001", perMinute: 900 },
  ];
  state.usage = new Map();
  state.delayMinutes = 0;
  state.rateLimit = { remaining: 0, retryAfter: 1 };
  state.stats = { admin: 0, limited: 0 };
}
reset();

const publicKey = (k) => ({
  type: "api_key",
  id: k.id,
  name: k.name,
  status: k.status,
  created_at: k.created_at,
  created_by: { id: "user_01Owner", type: "user" },
  expires_at: k.expires_at,
  partial_key_hint: `${k.secret.slice(0, 16)}...${k.secret.slice(-4)}`,
  principal: { type: "user_actor", user_id: "user_01Owner" },
  scope: { type: "workspace", workspace_id: k.workspace },
  workspace_id: k.workspace,
});

function addUsage(keyId, model, minute, tokens) {
  const byKey = state.usage.get(keyId) || new Map();
  const cellKey = `${model}\n${minute}`;
  byKey.set(cellKey, (byKey.get(cellKey) || 0) + tokens);
  state.usage.set(keyId, byKey);
}

/** Usage for one minute: { keyId: { model: tokens } }. */
function minuteUsage(minute) {
  const out = {};
  for (const s of state.steady) {
    const key = state.keys.find((k) => k.name === s.key);
    if (!key || key.status !== "active") continue;
    ((out[key.id] ||= {})[s.model] = (out[key.id]?.[s.model] || 0) + s.perMinute);
  }
  for (const [keyId, cells] of state.usage)
    for (const [cellKey, tokens] of cells) {
      const [model, m] = cellKey.split("\n");
      if (Number(m) === minute) ((out[keyId] ||= {})[model] = (out[keyId]?.[model] || 0) + tokens);
    }
  return out;
}

function send(res, status, body, headers = {}) {
  res.writeHead(status, { "Content-Type": "application/json", ...headers });
  res.end(JSON.stringify(body));
}

async function readJson(req) {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  const text = Buffer.concat(chunks).toString("utf8");
  return text ? JSON.parse(text) : {};
}

const notFound = (res) => send(res, 404, { type: "error", error: { type: "not_found_error", message: "Not found" } });

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://localhost");
  const path = url.pathname;
  try {
    if (path.startsWith("/_emulator/")) {
      if (path === "/_emulator/reset" && req.method === "POST") {
        reset();
        return send(res, 200, { ok: true });
      }
      if (path === "/_emulator/keys") return send(res, 200, { keys: state.keys });
      if (path === "/_emulator/inject" && req.method === "POST") {
        // { key: name, model, tokens, minutesAgo } or minutesAgo as [from, to] for a run of minutes.
        const input = await readJson(req);
        const key = state.keys.find((k) => k.name === input.key);
        if (!key) return send(res, 404, { error: "no such key" });
        const [from, to] = Array.isArray(input.minutesAgo) ? input.minutesAgo : [input.minutesAgo ?? 1, input.minutesAgo ?? 1];
        const nowMinute = Math.floor(Date.now() / MINUTE) * MINUTE;
        for (let m = from; m <= to; m++) addUsage(key.id, input.model, nowMinute - m * MINUTE, input.tokens);
        return send(res, 200, { ok: true });
      }
      if (path === "/_emulator/delay" && req.method === "POST") {
        state.delayMinutes = (await readJson(req)).minutes || 0;
        return send(res, 200, { ok: true });
      }
      if (path === "/_emulator/ratelimit" && req.method === "POST") {
        const input = await readJson(req);
        state.rateLimit = { remaining: input.count || 0, retryAfter: input.retryAfter ?? 1 };
        return send(res, 200, { ok: true });
      }
      if (path === "/_emulator/stats") return send(res, 200, state.stats);
      return send(res, 404, { error: "unknown control" });
    }

    // The Messages API, with an ordinary key.
    if (req.method === "POST" && path === "/v1/messages") {
      const key = state.keys.find((k) => !k.admin && k.secret === req.headers["x-api-key"]);
      if (!key || key.status !== "active")
        return send(res, 401, { type: "error", error: { type: "authentication_error", message: "invalid x-api-key" } });
      const body = await readJson(req);
      addUsage(key.id, body.model || "claude-sonnet-4-5-20250929", Math.floor(Date.now() / MINUTE) * MINUTE, 100);
      return send(res, 200, { id: "msg_emulated", type: "message", content: [{ type: "text", text: "ok" }] });
    }

    if (!path.startsWith("/v1/organizations/")) return notFound(res);
    if (req.headers["x-api-key"] !== adminKey().secret)
      return send(res, 401, { type: "error", error: { type: "authentication_error", message: "invalid x-api-key" } });
    if (!req.headers["anthropic-version"]) return send(res, 400, { type: "error", error: { type: "invalid_request_error", message: "anthropic-version header is required" } });
    state.stats.admin++;
    if (state.rateLimit.remaining > 0) {
      state.rateLimit.remaining--;
      state.stats.limited++;
      return send(res, 429, { type: "error", error: { type: "rate_limit_error", message: "Rate limited" } }, { "retry-after": String(state.rateLimit.retryAfter) });
    }

    if (req.method === "GET" && path === "/v1/organizations/api_keys") {
      const limit = Math.min(1000, Number(url.searchParams.get("limit") || 20));
      const status = url.searchParams.get("status");
      const all = state.keys.filter((k) => !k.admin && (!status || k.status === status));
      const after = url.searchParams.get("after_id");
      const start = after ? all.findIndex((k) => k.id === after) + 1 : 0;
      const page = all.slice(start, start + limit);
      return send(res, 200, { data: page.map(publicKey), has_more: start + limit < all.length, first_id: page[0]?.id ?? null, last_id: page.at(-1)?.id ?? null });
    }
    const one = /^\/v1\/organizations\/api_keys\/([^/]+)$/.exec(path);
    if (one) {
      const key = state.keys.find((k) => !k.admin && k.id === one[1]);
      if (!key) return notFound(res);
      if (req.method === "GET") return send(res, 200, publicKey(key));
      if (req.method === "POST") {
        const body = await readJson(req);
        if (body.status !== undefined) {
          if (!["active", "inactive", "archived"].includes(body.status)) return send(res, 400, { type: "error", error: { type: "invalid_request_error", message: "bad status" } });
          if (key.status === "archived") return send(res, 400, { type: "error", error: { type: "invalid_request_error", message: "Archived keys can't be changed" } });
          key.status = body.status;
        }
        if (typeof body.name === "string") key.name = body.name;
        return send(res, 200, publicKey(key));
      }
    }

    if (req.method === "GET" && path === "/v1/organizations/usage_report/messages") {
      const q = url.searchParams;
      if ((q.get("bucket_width") || "1d") !== "1m") return send(res, 400, { type: "error", error: { type: "invalid_request_error", message: "the emulator only serves 1m buckets" } });
      const groupBy = q.getAll("group_by[]");
      const limit = Math.min(1440, Number(q.get("limit") || 60));
      const startParam = Date.parse(q.get("starting_at"));
      const start = q.get("page") ? Number(Buffer.from(q.get("page").replace(/^page_/, ""), "base64url").toString()) : Math.floor(startParam / MINUTE) * MINUTE;
      const end = q.get("ending_at") ? Date.parse(q.get("ending_at")) : start + limit * MINUTE;
      const visibleUntil = Math.floor(Date.now() / MINUTE) * MINUTE - state.delayMinutes * MINUTE;
      const data = [];
      let m = start;
      for (; m < end && data.length < limit; m += MINUTE) {
        const results = [];
        if (m <= visibleUntil)
          for (const [keyId, models] of Object.entries(minuteUsage(m)))
            for (const [model, tokens] of Object.entries(models)) {
              // Roughly how real usage splits: mostly uncached input, some cache reads, a fifth output.
              const output = Math.round(tokens / 5);
              const cacheRead = Math.round(tokens / 10);
              results.push({
                api_key_id: groupBy.includes("api_key_id") ? keyId : null,
                model: groupBy.includes("model") ? model : null,
                uncached_input_tokens: tokens - output - cacheRead,
                cache_creation: { ephemeral_1h_input_tokens: 0, ephemeral_5m_input_tokens: 0 },
                cache_read_input_tokens: cacheRead,
                output_tokens: output,
                server_tool_use: { web_search_requests: 0 },
                workspace_id: null,
                service_tier: null,
                context_window: null,
                inference_geo: null,
                speed: null,
                account_id: null,
                service_account_id: null,
              });
            }
        data.push({ starting_at: new Date(m).toISOString(), ending_at: new Date(m + MINUTE).toISOString(), results });
      }
      const hasMore = m < end;
      return send(res, 200, { data, has_more: hasMore, next_page: hasMore ? `page_${Buffer.from(String(m)).toString("base64url")}` : null });
    }
    return notFound(res);
  } catch (error) {
    return send(res, 500, { type: "error", error: { type: "api_error", message: error.message } });
  }
});

server.listen(port, "127.0.0.1", () => console.log(`Anthropic emulator on http://127.0.0.1:${port}`));
