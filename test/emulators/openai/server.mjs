/**
 * A local stand-in for the parts of OpenAI's Admin API the watcher uses, plus chat completions so a test can
 * see a key with narrowed permissions being refused:
 *
 *   GET  /v1/organization/projects                         projects (limit, after); archived ones hidden
 *   GET  /v1/organization/projects/{p}/api_keys            keys, user and service account owned; never their scopes
 *   POST /v1/organization/projects/{p}/api_keys/{k}        {"scopes": [...]}: replaces the scopes. [] means all permissions
 *   GET  /v1/organization/usage/{endpoint}                 1m buckets, group_by=api_key_id&group_by=model, paged
 *   GET  /v1/organization/costs                            1d buckets, group_by=api_key_id
 *   GET  /v1/organization/audit_logs                       api_key.created / api_key.updated events, newest first
 *   POST /v1/chat/completions                              with a project key: 403 unless its scopes allow model requests
 *
 * Like the real API, the key object has redacted_value only, and no scopes.
 *
 * Test controls under /_emulator: reset, keys (with secrets and scopes), inject (requests a minute), cost
 * (dollars on a key today), scopes (change a key's scopes as a person in the dashboard would, which is
 * audited), ratelimit, stats.
 */
import { randomBytes } from "node:crypto";
import http from "node:http";

const port = Number(process.env.PORT || 4800);
const MINUTE = 60_000;
const DAY = 86_400_000;

const state = {};

function reset() {
  const now = Date.now();
  state.admin = `sk-admin-${randomBytes(48).toString("base64url")}`;
  state.projects = [
    { id: "proj_web", name: "Web app", status: "active" },
    { id: "proj_data", name: "Data pipeline", status: "active" },
    { id: "proj_old", name: "Old prototype", status: "archived" },
  ];
  const make = (name, project, { owner = "user", scopes = [], createdDaysAgo = 30, audited = true, model = "gpt-5-mini", perMinute = 0, dailyUsd = 0 } = {}) => ({
    id: `key_${randomBytes(8).toString("hex")}`,
    name,
    project,
    owner,
    secret: owner === "service_account" ? `sk-svcacct-${randomBytes(60).toString("base64url")}` : `sk-proj-${randomBytes(60).toString("base64url")}`,
    scopes,
    created_at: Math.floor((now - createdDaysAgo * DAY) / 1000),
    audited,
    model,
    perMinute,
    dailyUsd,
  });
  state.keys = [
    make("web-backend", "proj_web", { perMinute: 30, dailyUsd: 8 }),
    make("mobile-app", "proj_web", { scopes: ["api.model.request", "api.files.read"], perMinute: 12, dailyUsd: 3, model: "gpt-5-nano" }),
    make("etl-pipeline", "proj_data", { owner: "service_account", perMinute: 5, dailyUsd: 4, model: "text-embedding-3-small" }),
    // Created before the organization turned audit logging on: no event says what its scopes are.
    make("intern-key", "proj_data", { audited: false, perMinute: 2, dailyUsd: 1 }),
    make("legacy", "proj_old", { perMinute: 0 }),
  ];
  state.audit = [];
  for (const k of state.keys)
    if (k.audited) audit("api_key.created", k.created_at, k, { data: { scopes: k.scopes } }, "user");
  state.usage = new Map();
  state.costs = new Map();
  state.rateLimit = { remaining: 0, retryAfter: 1 };
  state.stats = { admin: 0, limited: 0, scopeWrites: [] };
}

function audit(type, at, key, detail, actor) {
  state.audit.unshift({
    id: `audit_log-${randomBytes(6).toString("hex")}`,
    type,
    effective_at: at,
    project: { id: key.project },
    actor: actor === "admin" ? { type: "api_key", api_key: { type: "organization" } } : { type: "session", session: { user: { id: "user-owner" }, ip_address: "203.0.113.7" } },
    [type]: { id: key.id, ...detail },
  });
}
reset();

const publicKey = (k) => ({
  object: "organization.project.api_key",
  redacted_value: `${k.secret.slice(0, 8)}...${k.secret.slice(-4)}`,
  name: k.name,
  created_at: k.created_at,
  last_used_at: null,
  expires_at: null,
  id: k.id,
  owner_project_access: "active",
  owner:
    k.owner === "service_account"
      ? { type: "service_account", service_account: { id: `svc_acct_${k.id}`, name: k.name, role: "member", created_at: k.created_at } }
      : { type: "user", user: { id: "user-owner", name: "Owner", email: "owner@example.com", role: "owner", created_at: k.created_at } },
});

const cell = (map, keyId, model, minute) => `${keyId}\n${model}\n${minute}`;
function minuteUsage(minute) {
  const out = [];
  for (const k of state.keys) if (k.perMinute && state.projects.find((p) => p.id === k.project).status === "active") out.push([k.id, k.model, k.perMinute]);
  for (const [c, n] of state.usage) {
    const [keyId, model, m] = c.split("\n");
    if (Number(m) === minute) out.push([keyId, model, n]);
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

const error = (res, status, message, type = "invalid_request_error") => send(res, status, { error: { message, type, param: null, code: null } });
const canRequestModels = (scopes) => scopes.length === 0 || scopes.includes("api.model.request");

function list(res, url, items) {
  const limit = Math.min(100, Number(url.searchParams.get("limit") || 20));
  const after = url.searchParams.get("after");
  const start = after ? items.findIndex((i) => i.id === after) + 1 : 0;
  const page = items.slice(start, start + limit);
  return send(res, 200, { object: "list", data: page, first_id: page[0]?.id ?? null, last_id: page.at(-1)?.id ?? null, has_more: start + limit < items.length });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://localhost");
  const path = url.pathname;
  try {
    if (path.startsWith("/_emulator/")) {
      if (path === "/_emulator/reset" && req.method === "POST") {
        reset();
        return send(res, 200, { ok: true });
      }
      if (path === "/_emulator/keys") return send(res, 200, { admin: state.admin, keys: state.keys });
      if (path === "/_emulator/inject" && req.method === "POST") {
        const input = await readJson(req);
        const key = state.keys.find((k) => k.name === input.key);
        const [from, to] = Array.isArray(input.minutesAgo) ? input.minutesAgo : [input.minutesAgo ?? 1, input.minutesAgo ?? 1];
        const nowMinute = Math.floor(Date.now() / MINUTE) * MINUTE;
        for (let m = from; m <= to; m++) {
          const c = cell(state.usage, key.id, input.model || key.model, nowMinute - m * MINUTE);
          state.usage.set(c, (state.usage.get(c) || 0) + input.requests);
        }
        return send(res, 200, { ok: true });
      }
      if (path === "/_emulator/cost" && req.method === "POST") {
        const input = await readJson(req);
        const key = state.keys.find((k) => k.name === input.key);
        state.costs.set(key.id, (state.costs.get(key.id) || 0) + input.usd);
        return send(res, 200, { ok: true });
      }
      if (path === "/_emulator/scopes" && req.method === "POST") {
        const input = await readJson(req);
        const key = state.keys.find((k) => k.name === input.key);
        key.scopes = input.scopes;
        audit("api_key.updated", Math.floor(Date.now() / 1000), key, { changes_requested: { scopes: input.scopes } }, "user");
        return send(res, 200, { ok: true });
      }
      if (path === "/_emulator/ratelimit" && req.method === "POST") {
        const input = await readJson(req);
        state.rateLimit = { remaining: input.count || 0, retryAfter: input.retryAfter ?? 1 };
        return send(res, 200, { ok: true });
      }
      if (path === "/_emulator/stats") return send(res, 200, state.stats);
      return error(res, 404, "unknown control");
    }

    const token = (req.headers.authorization || "").replace(/^Bearer\s+/i, "");
    if (req.method === "POST" && path === "/v1/chat/completions") {
      const key = state.keys.find((k) => k.secret === token);
      if (!key) return error(res, 401, "Incorrect API key provided", "invalid_request_error");
      if (!canRequestModels(key.scopes)) return error(res, 403, "You have insufficient permissions for this operation. Missing scopes: model.request", "insufficient_permissions");
      const body = await readJson(req);
      const c = cell(state.usage, key.id, body.model || key.model, Math.floor(Date.now() / MINUTE) * MINUTE);
      state.usage.set(c, (state.usage.get(c) || 0) + 1);
      return send(res, 200, { id: "chatcmpl-emulated", choices: [{ message: { role: "assistant", content: "ok" } }] });
    }

    if (!path.startsWith("/v1/organization/")) return error(res, 404, "Not found");
    if (token !== state.admin) return error(res, 401, "Incorrect API key provided");
    state.stats.admin++;
    if (state.rateLimit.remaining > 0) {
      state.rateLimit.remaining--;
      state.stats.limited++;
      return send(res, 429, { error: { message: "Too many management requests. Reduce the request rate and try again later.", type: "rate_limit_exceeded" } }, { "retry-after": String(state.rateLimit.retryAfter) });
    }

    if (req.method === "GET" && path === "/v1/organization/projects")
      return list(res, url, state.projects.filter((p) => p.status === "active").map((p) => ({ object: "organization.project", ...p, created_at: 1711471533, archived_at: null })));
    const keysPath = /^\/v1\/organization\/projects\/([^/]+)\/api_keys(?:\/([^/]+))?$/.exec(path);
    if (keysPath) {
      const project = state.projects.find((p) => p.id === keysPath[1]);
      if (!project) return error(res, 404, "Project not found");
      if (!keysPath[2] && req.method === "GET") return list(res, url, state.keys.filter((k) => k.project === project.id).map(publicKey));
      const key = state.keys.find((k) => k.project === project.id && k.id === keysPath[2]);
      if (!key) return error(res, 404, "API key not found");
      if (req.method === "GET") return send(res, 200, publicKey(key));
      if (req.method === "POST") {
        const body = await readJson(req);
        if (!Array.isArray(body.scopes) && body.expires_in_seconds === undefined) return error(res, 400, "Provide at least one of scopes or expires_in_seconds");
        if (Array.isArray(body.scopes)) {
          key.scopes = body.scopes;
          state.stats.scopeWrites.push({ key: key.name, scopes: body.scopes });
          audit("api_key.updated", Math.floor(Date.now() / 1000), key, { changes_requested: { scopes: body.scopes } }, "admin");
        }
        return send(res, 200, publicKey(key));
      }
    }

    const usage = /^\/v1\/organization\/usage\/([a-z_]+)$/.exec(path);
    if (usage && req.method === "GET") {
      const q = url.searchParams;
      if (q.get("bucket_width") !== "1m") return error(res, 400, "the emulator only serves 1m buckets");
      const groupBy = q.getAll("group_by");
      const limit = Math.min(1440, Number(q.get("limit") || 60));
      const start = q.get("page") ? Number(q.get("page")) : Math.floor((Number(q.get("start_time")) * 1000) / MINUTE) * MINUTE;
      const end = q.get("end_time") ? Number(q.get("end_time")) * 1000 : Date.now();
      // Only completions and embeddings see traffic here; the other endpoints answer with empty buckets.
      const endpoint = usage[1];
      const data = [];
      let m = start;
      for (; m < end && data.length < limit; m += MINUTE) {
        const results = [];
        if (endpoint === "completions" || endpoint === "embeddings")
          for (const [keyId, model, n] of minuteUsage(m)) {
            if (model.startsWith("text-embedding") !== (endpoint === "embeddings")) continue;
            results.push({
              object: `organization.usage.${endpoint}.result`,
              input_tokens: n * 400,
              output_tokens: endpoint === "completions" ? n * 80 : 0,
              num_model_requests: n,
              project_id: null,
              user_id: null,
              api_key_id: groupBy.includes("api_key_id") ? keyId : null,
              model: groupBy.includes("model") ? model : null,
            });
          }
        data.push({ object: "bucket", start_time: m / 1000, end_time: (m + MINUTE) / 1000, results });
      }
      const more = m < end;
      return send(res, 200, { object: "page", data, has_more: more, next_page: more ? String(m) : null });
    }

    if (req.method === "GET" && path === "/v1/organization/costs") {
      const q = url.searchParams;
      const start = Number(q.get("start_time")) * 1000;
      const todayStart = Math.floor(Date.now() / DAY) * DAY;
      const data = [];
      for (let d = Math.floor(start / DAY) * DAY; d <= todayStart; d += DAY) {
        const results = [];
        for (const k of state.keys) {
          const usd = d === todayStart ? (state.costs.get(k.id) || 0) + k.dailyUsd / 2 : k.dailyUsd;
          if (usd > 0) results.push({ object: "organization.costs.result", amount: { value: usd, currency: "usd" }, line_item: null, project_id: null, api_key_id: k.id });
        }
        data.push({ object: "bucket", start_time: d / 1000, end_time: (d + DAY) / 1000, results });
      }
      return send(res, 200, { object: "page", data, has_more: false, next_page: null });
    }

    if (req.method === "GET" && path === "/v1/organization/audit_logs") {
      const q = url.searchParams;
      const types = q.getAll("event_types[]");
      const gte = q.get("effective_at[gte]");
      const items = state.audit.filter((e) => (!types.length || types.includes(e.type)) && (gte === null || e.effective_at >= Number(gte)));
      return list(res, url, items);
    }
    return error(res, 404, `No route ${req.method} ${path}`);
  } catch (e) {
    return error(res, 500, e.message, "server_error");
  }
});

server.listen(port, "127.0.0.1", () => console.log(`OpenAI emulator on http://127.0.0.1:${port}`));
