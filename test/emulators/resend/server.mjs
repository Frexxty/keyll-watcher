/**
 * A local stand-in for the parts of Resend's API the watcher uses, matching how the real one behaves:
 *
 *   GET    /api-keys          list keys: id, name, created_at, last_used_at (full-access keys only)
 *   DELETE /api-keys/{id}     delete a key. Resend has no disable, and a deleted key can't come back.
 *   GET    /logs, /logs/{id}  every API request, newest first. Entries don't say which key made them;
 *                             a key's last_used_at equals the created_at of its latest request.
 *   POST   /emails, /emails/batch   send with any key; a deleted key gets 401
 *
 * Test controls under /_emulator: reset, list keys with their tokens, and a sender that sends N emails a
 * minute with one key.
 */
import { randomBytes, randomUUID } from "node:crypto";
import http from "node:http";

const port = Number(process.env.PORT || 4500);

/** Resend's timestamp format: "2026-10-14 17:52:47.482621+00". Microseconds keep timestamps unique. */
let lastMicros = 0;
function stamp() {
  let micros = Date.now() * 1000;
  if (micros <= lastMicros) micros = lastMicros + 1;
  lastMicros = micros;
  const d = new Date(Math.floor(micros / 1000));
  return `${d.toISOString().slice(0, 19).replace("T", " ")}.${String(micros % 1_000_000).padStart(6, "0")}+00`;
}

const state = { keys: [], logs: [], senders: new Map() };

function reset() {
  const make = (name, permission) => ({
    id: randomUUID(),
    name,
    permission,
    token: `re_${randomBytes(16).toString("base64url")}`,
    created_at: stamp(),
    last_used_at: null,
  });
  state.keys = [
    make("keyll-watcher", "full_access"),
    make("production-app", "sending_access"),
    make("newsletter", "sending_access"),
    make("marketing-site", "sending_access"),
  ];
  state.logs = [];
  for (const s of state.senders.values()) clearInterval(s.timer);
  state.senders = new Map();
}
reset();

function record(key, method, endpoint, status, userAgent, extra = {}) {
  const log = { id: randomUUID(), created_at: stamp(), endpoint, method, response_status: status, user_agent: userAgent || "", ...extra };
  state.logs.unshift(log);
  if (state.logs.length > 50_000) state.logs.length = 50_000;
  if (key) key.last_used_at = log.created_at;
  return log;
}

function send(res, status, body) {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
}

async function readJson(req) {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  const text = Buffer.concat(chunks).toString("utf8");
  return text ? JSON.parse(text) : {};
}

function sendEmails(key, count, userAgent = "node") {
  if (!key || !state.keys.includes(key)) {
    record(null, "POST", "/emails", 401, userAgent);
    return 401;
  }
  const ids = Array.from({ length: count }, () => ({ id: randomUUID() }));
  if (count === 1) record(key, "POST", "/emails", 200, userAgent, { response_body: ids[0] });
  else record(key, "POST", "/emails/batch", 200, userAgent, { response_body: { data: ids } });
  return 200;
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
      if (path === "/_emulator/keys") return send(res, 200, { keys: state.keys });
      if (path === "/_emulator/sender" && req.method === "POST") {
        const input = await readJson(req);
        const existing = state.senders.get(input.key);
        if (existing) clearInterval(existing.timer);
        state.senders.delete(input.key);
        if (input.perMinute > 0) {
          // The key is looked up by name once: if it's deleted, the sender keeps trying and gets 401s, like a real app.
          const key = state.keys.find((k) => k.name === input.key);
          const sender = { sent: 0, rejected: 0, carry: 0, perMinute: input.perMinute };
          sender.timer = setInterval(() => {
            sender.carry += sender.perMinute / 60;
            for (; sender.carry >= 1; sender.carry--) (sendEmails(key, 1) === 200 ? sender.sent++ : sender.rejected++);
          }, 1000);
          sender.timer.unref();
          state.senders.set(input.key, sender);
        }
        return send(res, 200, { ok: true });
      }
      if (path === "/_emulator/senders") return send(res, 200, Object.fromEntries([...state.senders].map(([k, s]) => [k, { sent: s.sent, rejected: s.rejected }])));
      return send(res, 404, { message: "unknown control" });
    }

    const token = (req.headers.authorization || "").replace(/^Bearer\s+/i, "");
    const key = state.keys.find((k) => k.token === token);
    const ua = req.headers["user-agent"] || "";

    if (req.method === "POST" && path === "/emails") {
      const status = sendEmails(key, 1, ua);
      return status === 200 ? send(res, 200, { id: randomUUID() }) : send(res, 401, { statusCode: 401, name: "validation_error", message: "API key is invalid" });
    }
    if (req.method === "POST" && path === "/emails/batch") {
      const body = await readJson(req);
      const status = sendEmails(key, Array.isArray(body) ? body.length : 1, ua);
      return status === 200 ? send(res, 200, { data: [] }) : send(res, 401, { statusCode: 401, name: "validation_error", message: "API key is invalid" });
    }

    if (!key) return send(res, 401, { statusCode: 401, name: "validation_error", message: "API key is invalid" });
    if (key.permission !== "full_access") {
      record(key, req.method, path, 401, ua);
      return send(res, 401, { statusCode: 401, name: "restricted_api_key", message: "This API key is restricted to only send emails" });
    }

    if (req.method === "GET" && path === "/api-keys") {
      record(key, "GET", "/api-keys", 200, ua);
      return send(res, 200, { object: "list", has_more: false, data: state.keys.map(({ id, name, created_at, last_used_at }) => ({ id, name, created_at, last_used_at })) });
    }
    const del = /^\/api-keys\/([^/]+)$/.exec(path);
    if (req.method === "DELETE" && del) {
      const i = state.keys.findIndex((k) => k.id === del[1]);
      record(key, "DELETE", path, i >= 0 ? 200 : 404, ua);
      if (i < 0) return send(res, 404, { statusCode: 404, name: "not_found", message: "API key not found" });
      state.keys.splice(i, 1);
      return send(res, 200, {});
    }
    if (req.method === "GET" && path === "/logs") {
      // Newest first. `after` pages towards older entries, like Resend's cursor pagination.
      const limit = Math.min(100, Number(url.searchParams.get("limit") || 20));
      const after = url.searchParams.get("after");
      const start = after ? state.logs.findIndex((l) => l.id === after) + 1 : 0;
      const page = state.logs.slice(start, start + limit);
      const out = { object: "list", has_more: start + limit < state.logs.length, data: page.map(({ response_body, ...l }) => l) };
      record(key, "GET", "/logs", 200, ua);
      return send(res, 200, out);
    }
    const one = /^\/logs\/([^/]+)$/.exec(path);
    if (req.method === "GET" && one) {
      const log = state.logs.find((l) => l.id === one[1]);
      record(key, "GET", path, log ? 200 : 404, ua);
      return log ? send(res, 200, { object: "log", ...log, request_body: { to: ["someone@example.com"], subject: "private" } }) : send(res, 404, { message: "not found" });
    }
    return send(res, 404, { statusCode: 404, name: "not_found", message: `No route ${req.method} ${path}` });
  } catch (error) {
    return send(res, 500, { message: error.message });
  }
});

server.listen(port, "127.0.0.1", () => console.log(`Resend emulator on http://127.0.0.1:${port}`));
