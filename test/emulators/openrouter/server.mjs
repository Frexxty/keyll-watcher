/**
 * A local stand-in for the parts of OpenRouter's management API the watcher uses, plus chat completions so a
 * test can see a disabled key being refused:
 *
 *   GET   /api/v1/workspaces                   workspaces (limit, offset)
 *   GET   /api/v1/keys                         keys in one workspace (workspace_id, include_disabled, offset), 100 a page
 *   GET   /api/v1/keys/{hash}                  one key
 *   PATCH /api/v1/keys/{hash}                  name, disabled, limit, limit_reset; 400 with no update fields
 *   GET   /api/v1/activity                     spend per day and model for the last 30 completed days (api_key_hash)
 *   POST  /api/v1/chat/completions             with an inference key: 401 when disabled, otherwise costs $0.002
 *
 * Every management call needs the management key. Keys are identified by hash; the secret is never returned.
 *
 * Test controls under /_emulator: reset, keys (with secrets), spend (add dollars to a key, as if it had made
 * calls since the last poll), activity (add a past day's spend on a model), ratelimit (next N management
 * calls get 429 with Retry-After), stats.
 */
import { createHash, randomBytes, randomUUID } from "node:crypto";
import http from "node:http";

const port = Number(process.env.PORT || 4700);
const DAY = 86_400_000;
const today = () => new Date().toISOString().slice(0, 10);
const daysAgo = (n) => new Date(Date.now() - n * DAY).toISOString().slice(0, 10);

const state = { management: "", workspaces: [], keys: [], activity: [], rateLimit: { remaining: 0, retryAfter: 1 }, stats: { management: 0, limited: 0 } };

function reset() {
  const now = Date.now();
  state.management = `sk-or-v1-${randomBytes(32).toString("hex")}`;
  state.workspaces = [
    { id: randomUUID(), name: "Default", slug: "default" },
    { id: randomUUID(), name: "Research", slug: "research" },
  ];
  const make = (name, { workspace = 0, limit = null, limitReset = null, disabled = false, createdDaysAgo = 60, dailyUsd = 0, model = "anthropic/claude-sonnet-4.5" } = {}) => {
    const secret = `sk-or-v1-${randomBytes(32).toString("hex")}`;
    return {
      hash: createHash("sha256").update(secret).digest("hex"),
      secret,
      name,
      disabled,
      limit,
      limit_reset: limitReset,
      workspace_id: state.workspaces[workspace].id,
      created_at: new Date(now - createdDaysAgo * DAY).toISOString(),
      updated_at: new Date(now - createdDaysAgo * DAY).toISOString(),
      expires_at: null,
      last_used_at: null,
      // All-time and per-period credit spend, in USD. "Today" starts fresh.
      usage: dailyUsd * 30,
      usage_daily: 0,
      usage_weekly: dailyUsd * 3,
      usage_monthly: dailyUsd * 20,
      byok_usage: 0,
      byok_usage_daily: 0,
      byok_usage_weekly: 0,
      byok_usage_monthly: 0,
      dailyUsd,
      model,
    };
  };
  state.keys = [
    make("production", { limit: 100, limitReset: "daily", dailyUsd: 12 }),
    make("chat-widget", { dailyUsd: 5, model: "openai/gpt-4o-mini" }),
    make("research-notebook", { workspace: 1, dailyUsd: 2, model: "google/gemini-2.5-flash" }),
    make("retired", { disabled: true }),
  ];
  // Thirty completed days of steady spend on each key's one model.
  state.activity = [];
  for (const k of state.keys)
    if (k.dailyUsd)
      for (let d = 1; d <= 30; d++)
        state.activity.push({ hash: k.hash, date: daysAgo(d), model: k.model, usage: k.dailyUsd, requests: Math.round(k.dailyUsd * 500) });
  state.rateLimit = { remaining: 0, retryAfter: 1 };
  state.stats = { management: 0, limited: 0 };
}
reset();

function spend(key, usd) {
  for (const f of ["usage", "usage_daily", "usage_weekly", "usage_monthly"]) key[f] = Math.round((key[f] + usd) * 1e6) / 1e6;
  key.last_used_at = new Date().toISOString();
}

const publicKey = ({ secret, dailyUsd, model, ...k }) => ({
  ...k,
  label: `${secret.slice(0, 12)}...${secret.slice(-4)}`,
  limit_remaining: k.limit === null ? null : Math.max(0, k.limit - k.usage_daily),
  include_byok_in_limit: false,
  creator_user_id: "user_owner",
  external_user: null,
});

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

const error = (res, status, message) => send(res, status, { error: { code: status, message } });

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://localhost");
  const path = url.pathname;
  try {
    if (path.startsWith("/_emulator/")) {
      if (path === "/_emulator/reset" && req.method === "POST") {
        reset();
        return send(res, 200, { ok: true });
      }
      if (path === "/_emulator/keys") return send(res, 200, { management: state.management, keys: state.keys });
      if (path === "/_emulator/spend" && req.method === "POST") {
        const input = await readJson(req);
        const key = state.keys.find((k) => k.name === input.key);
        if (!key) return error(res, 404, "no such key");
        spend(key, input.usd);
        return send(res, 200, { ok: true });
      }
      if (path === "/_emulator/activity" && req.method === "POST") {
        const input = await readJson(req);
        const key = state.keys.find((k) => k.name === input.key);
        state.activity.push({ hash: key.hash, date: daysAgo(input.daysAgo ?? 1), model: input.model, usage: input.usd, requests: 10 });
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

    if (req.method === "POST" && path === "/api/v1/chat/completions") {
      const key = state.keys.find((k) => k.secret === token);
      if (!key || key.disabled) return error(res, 401, "User not found.");
      spend(key, 0.002);
      return send(res, 200, { id: "gen-emulated", choices: [{ message: { role: "assistant", content: "ok" } }] });
    }

    if (token !== state.management) return error(res, 401, "Invalid management key");
    state.stats.management++;
    if (state.rateLimit.remaining > 0) {
      state.rateLimit.remaining--;
      state.stats.limited++;
      return send(res, 429, { error: { code: 429, message: "Rate limit exceeded" } }, { "retry-after": String(state.rateLimit.retryAfter) });
    }

    if (req.method === "GET" && path === "/api/v1/workspaces") {
      const limit = Number(url.searchParams.get("limit") || 50);
      const offset = Number(url.searchParams.get("offset") || 0);
      return send(res, 200, { data: state.workspaces.slice(offset, offset + limit), total_count: state.workspaces.length });
    }
    if (req.method === "GET" && path === "/api/v1/keys") {
      const ws = url.searchParams.get("workspace_id") || state.workspaces[0].id;
      const includeDisabled = url.searchParams.get("include_disabled") === "true";
      const offset = Number(url.searchParams.get("offset") || 0);
      const all = state.keys.filter((k) => k.workspace_id === ws && (includeDisabled || !k.disabled));
      return send(res, 200, { data: all.slice(offset, offset + 100).map(publicKey) });
    }
    const one = /^\/api\/v1\/keys\/([0-9a-f]{64})$/.exec(path);
    if (one) {
      const key = state.keys.find((k) => k.hash === one[1]);
      if (!key) return error(res, 404, "Key not found");
      if (req.method === "GET") return send(res, 200, { data: publicKey(key) });
      if (req.method === "PATCH") {
        const body = await readJson(req);
        const fields = ["name", "disabled", "limit", "limit_reset", "include_byok_in_limit", "workspace_id"].filter((f) => f in body);
        if (!fields.length) return error(res, 400, "No update fields provided");
        for (const f of fields) key[f] = body[f];
        key.updated_at = new Date().toISOString();
        return send(res, 200, { data: publicKey(key) });
      }
    }
    if (req.method === "GET" && path === "/api/v1/activity") {
      const hash = url.searchParams.get("api_key_hash");
      const rows = state.activity
        .filter((a) => (!hash || a.hash === hash) && a.date < today() && a.date >= daysAgo(30))
        .map(({ hash: _h, ...a }) => ({ ...a, model_permaslug: a.model, endpoint_id: randomUUID(), provider_name: "Emulated", prompt_tokens: 1000, completion_tokens: 200, reasoning_tokens: 0, cached_tokens: 0, byok_usage_inference: 0 }));
      return send(res, 200, { data: rows });
    }
    return error(res, 404, `No route ${req.method} ${path}`);
  } catch (e) {
    return error(res, 500, e.message);
  }
});

server.listen(port, "127.0.0.1", () => console.log(`OpenRouter emulator on http://127.0.0.1:${port}`));
