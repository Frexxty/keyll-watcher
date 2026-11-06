/**
 * A local stand-in for the Google Cloud APIs the watcher calls, so tests can run without a real project:
 *
 *   GET   /v3/projects/{p}/timeSeries                  Cloud Monitoring, request_count per key
 *   GET   /v2/projects/{p}/locations/global/keys       API Keys v2: list
 *   GET   /v2/projects/{p}/locations/global/keys/{id}  get
 *   PATCH /v2/projects/{p}/locations/global/keys/{id}  update restrictions/annotations (returns an Operation)
 *   GET   /v2/operations/{id}                          poll an Operation
 *   GET   /computeMetadata/v1/...                      metadata server: access token, project ID
 *
 * It also plays the part of Google's API frontends: POST /call/{service} with an x-goog-api-key header
 * succeeds or fails exactly as the key's current restrictions allow, and every call lands in the request
 * counts Monitoring returns. Test-only controls live under /_emulator.
 *
 * Deliberate differences from Google, so tests catch mistakes:
 *   - keys.list returns keyString. Google only returns it from getKeyString; including it here proves the
 *     watcher drops it before anything reaches Keyll.
 *   - Restriction changes can apply after RESTRICTION_DELAY_MS and Monitoring data can lag by
 *     MONITORING_LAG_MS, both 0 by default.
 */
import { createPublicKey, randomBytes, randomUUID, verify } from "node:crypto";
import http from "node:http";

const PROJECT = process.env.EMULATOR_PROJECT || "keyll-e2e";
const PROJECT_NUMBER = "424242424242";
const TOKEN = process.env.EMULATOR_TOKEN || "emulator-access-token";
const RESTRICTION_DELAY_MS = Number(process.env.RESTRICTION_DELAY_MS || 0);
const MONITORING_LAG_MS = Number(process.env.MONITORING_LAG_MS || 0);
const port = Number(process.env.PORT || 4100);

const MINUTE = 60_000;
const jitter = (i) => Math.sin(i * 12.9898) * 0.5 + Math.sin(i * 4.1414) * 0.5;

/**
 * Seed keys. history gives each key's requests per minute per service before the emulator started, so
 * Monitoring has a week of history, like a real project.
 */
function seedKeys(startedAt) {
  const day = 86_400_000;
  const make = (id, displayName, restrictions, history, createdDaysAgo = 200, extra = {}) => ({
    name: `projects/${PROJECT_NUMBER}/locations/global/keys/${id}`,
    uid: randomUUID(),
    displayName,
    keyString: `AIza${randomBytes(26).toString("base64url").slice(0, 35)}`,
    createTime: new Date(startedAt - createdDaysAgo * day).toISOString(),
    updateTime: new Date(startedAt - createdDaysAgo * day).toISOString(),
    restrictions,
    annotations: {},
    etag: `W/"${randomBytes(8).toString("hex")}"`,
    history,
    ...extra,
  });
  return [
    // The story from the landing page: a Maps key in front-end code, unrestricted, in a project with Gemini enabled.
    make("maps-website", "maps-website", undefined, { "maps-backend.googleapis.com": 41 }),
    make("gemini-backend", "gemini-backend", { apiTargets: [{ service: "generativelanguage.googleapis.com" }] }, { "generativelanguage.googleapis.com": 12 }),
    make(
      "places-server",
      "places-server",
      { serverKeyRestrictions: { allowedIps: ["203.0.113.0/24"] }, apiTargets: [{ service: "places.googleapis.com" }] },
      { "places.googleapis.com": 25 },
    ),
    // A nightly batch: quiet all day, busy for one hour.
    make("batch-translate", "batch-translate", { apiTargets: [{ service: "translate.googleapis.com" }] }, { "translate.googleapis.com": 2 }, 200, { batchHourUtc: 2, batchRate: 220 }),
    make("new-unused-key", "new-unused-key", { apiTargets: [{ service: "maps-backend.googleapis.com" }] }, {}, 0.05),
  ];
}

const state = { startedAt: 0, keys: [], counts: new Map(), operations: new Map(), generators: new Map(), calls: [] };
// Credentials for the token endpoints: service account public keys, and subject tokens a workload identity pool accepts.
const auth = { serviceAccountKeys: new Map(), subjectTokens: new Set(), stsTokens: new Set() };

function reset() {
  state.startedAt = Date.now();
  state.keys = seedKeys(state.startedAt);
  state.counts = new Map();
  state.operations = new Map();
  state.generators = new Map();
  state.calls = [];
  for (const key of state.keys) key.restrictionLog = [{ at: 0, restrictions: key.restrictions }];
}
reset();

// ---------- traffic ----------

function restrictionsAt(key, at) {
  let current = key.restrictionLog[0].restrictions;
  for (const entry of key.restrictionLog) if (entry.at + RESTRICTION_DELAY_MS <= at) current = entry.restrictions;
  return current;
}

function methodMatches(pattern, method) {
  return pattern.endsWith("*") ? method.startsWith(pattern.slice(0, -1)) : pattern === method;
}

/** What Google's frontend would answer for this key, service and method right now. */
function authorize(key, service, method, at = Date.now()) {
  if (!key || key.deleteTime) return { status: 400, reason: "API_KEY_INVALID" };
  const r = restrictionsAt(key, at) || {};
  if (r.apiTargets?.length) {
    const target = r.apiTargets.find((t) => t.service === service);
    if (!target) return { status: 403, reason: "API_KEY_SERVICE_BLOCKED" };
    if (target.methods?.length && !target.methods.some((m) => methodMatches(m, method))) return { status: 403, reason: "API_KEY_SERVICE_BLOCKED" };
  }
  return { status: 200, reason: "OK" };
}

function record(key, service, statusClass, at = Date.now(), n = 1) {
  const minute = Math.floor(at / MINUTE) * MINUTE;
  const id = `apikey:${key.uid}|${service}|${statusClass}`;
  const series = state.counts.get(id) || new Map();
  series.set(minute, (series.get(minute) || 0) + n);
  state.counts.set(id, series);
}

function call(key, service, method = "call") {
  const result = authorize(key, service, method);
  if (key) record(key, service, result.status === 200 ? "2xx" : "4xx");
  return result;
}

// Background generators simulate steady traffic without thousands of HTTP requests.
setInterval(() => {
  for (const gen of state.generators.values()) {
    gen.carry += gen.perMinute / 60;
    const n = Math.floor(gen.carry);
    gen.carry -= n;
    const key = state.keys.find((k) => k.uid === gen.keyUid);
    let ok = 0;
    for (let i = 0; i < n; i++) if (call(key, gen.service).status === 200) ok++;
    gen.sent += n;
    gen.ok += ok;
  }
}, 1000).unref();

// ---------- monitoring ----------

/** Synthetic history for minutes before the emulator started. */
function historyCount(key, service, minute) {
  if (minute >= state.startedAt - (state.startedAt % MINUTE)) return 0;
  if (Date.parse(key.createTime) > minute) return 0;
  const base = key.history?.[service];
  if (!base) return 0;
  let rate = base;
  if (key.batchHourUtc !== undefined && new Date(minute).getUTCHours() === key.batchHourUtc) rate = key.batchRate;
  return Math.max(0, Math.round(rate * (1 + 0.25 * jitter(minute / MINUTE))));
}

/** Every raw series: credential, service and response class, each with a count function per minute. */
function rawSeries() {
  const out = new Map();
  for (const key of state.keys) {
    for (const service of Object.keys(key.history || {})) {
      const id = `apikey:${key.uid}|${service}|2xx`;
      out.set(id, { credentialId: `apikey:${key.uid}`, service, responseClass: "2xx", key });
    }
  }
  for (const id of state.counts.keys()) {
    const [credentialId, service, responseClass] = id.split("|");
    if (!out.has(id)) out.set(id, { credentialId, service, responseClass, key: state.keys.find((k) => `apikey:${k.uid}` === credentialId) });
  }
  return [...out.entries()].map(([id, s]) => ({
    ...s,
    count: (minute) => (state.counts.get(id)?.get(minute) || 0) + (s.responseClass === "2xx" && s.key ? historyCount(s.key, s.service, minute) : 0),
  }));
}

function timeSeriesList(params) {
  const filter = params.get("filter") || "";
  if (!filter.includes('metric.type="serviceruntime.googleapis.com/api/request_count"')) return { timeSeries: [], unit: "1" };
  const credentialPrefix = /credential_id\s*=\s*starts_with\("([^"]*)"\)/.exec(filter)?.[1] ?? "";
  const start = Date.parse(params.get("interval.startTime"));
  const end = Date.parse(params.get("interval.endTime"));
  if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) throw Object.assign(new Error("invalid interval"), { status: 400 });
  const period = parseInt(params.get("aggregation.alignmentPeriod") || "60", 10) * 1000;
  const aligner = params.get("aggregation.perSeriesAligner") || "ALIGN_NONE";
  if (aligner !== "ALIGN_SUM" && aligner !== "ALIGN_MAX" && aligner !== "ALIGN_DELTA")
    throw Object.assign(new Error(`aligner ${aligner} isn't supported by the emulator`), { status: 400 });
  const groupBy = params.getAll("aggregation.groupByFields");
  const visibleUntil = Date.now() - MONITORING_LAG_MS;

  const groups = new Map();
  for (const s of rawSeries()) {
    if (!s.credentialId.startsWith(credentialPrefix)) continue;
    const labels = { credential_id: s.credentialId, service: s.service, response_code_class: s.responseClass };
    const groupKey = groupBy.map((f) => labels[f.split(".").pop()]).join("|");
    const group = groups.get(groupKey) || { labels: {}, metricLabels: {}, buckets: new Map() };
    for (const f of groupBy) {
      const name = f.split(".").pop();
      if (f.startsWith("resource.")) group.labels[name] = labels[name];
      else group.metricLabels[name] = labels[name];
    }
    // Buckets end at `end` and step back by the alignment period, like Monitoring's own alignment.
    for (let bEnd = end; bEnd - period >= start; bEnd -= period) {
      const bStart = bEnd - period;
      let value = 0;
      let any = false;
      for (let m = Math.ceil(bStart / MINUTE) * MINUTE; m < bEnd; m += MINUTE) {
        if (m + MINUTE > visibleUntil) continue;
        const c = s.count(m);
        if (!c) continue;
        any = true;
        value = aligner === "ALIGN_MAX" ? Math.max(value, c) : value + c;
      }
      if (any) group.buckets.set(bEnd, (group.buckets.get(bEnd) || 0) + value);
    }
    groups.set(groupKey, group);
  }

  const timeSeries = [];
  for (const g of groups.values()) {
    if (!g.buckets.size) continue;
    timeSeries.push({
      metric: { type: "serviceruntime.googleapis.com/api/request_count", labels: g.metricLabels },
      resource: { type: "consumed_api", labels: { project_id: PROJECT, ...g.labels } },
      metricKind: "DELTA",
      valueType: "INT64",
      points: [...g.buckets.entries()]
        .sort((a, b) => b[0] - a[0])
        .map(([bEnd, v]) => ({
          interval: { startTime: new Date(bEnd - period).toISOString(), endTime: new Date(bEnd).toISOString() },
          value: { int64Value: String(v) },
        })),
    });
  }
  return { timeSeries, unit: "1" };
}

// ---------- api keys ----------

const publicKey = (key) => {
  const { history, restrictionLog, batchHourUtc, batchRate, ...rest } = key;
  return rest;
};

function patchKey(key, mask, body) {
  if (body.etag && body.etag !== key.etag) throw Object.assign(new Error("The etag doesn't match the key's current etag."), { status: 409, code: "ABORTED" });
  const fields = mask.split(",").map((s) => s.trim()).filter(Boolean);
  if (!fields.length) throw Object.assign(new Error("updateMask is required"), { status: 400 });
  for (const field of fields) {
    if (field === "restrictions") {
      key.restrictions = body.restrictions && Object.keys(body.restrictions).length ? body.restrictions : undefined;
      key.restrictionLog.push({ at: Date.now(), restrictions: key.restrictions });
    } else if (field === "annotations") key.annotations = body.annotations || {};
    else if (field === "displayName") key.displayName = body.displayName || "";
    else throw Object.assign(new Error(`Field ${field} can't be updated`), { status: 400 });
  }
  key.updateTime = new Date().toISOString();
  key.etag = `W/"${randomBytes(8).toString("hex")}"`;
  const op = { name: `operations/akmf.p7-${randomBytes(6).toString("hex")}`, done: true, response: { "@type": "type.googleapis.com/google.api.apikeys.v2.Key", ...publicKey(key) } };
  state.operations.set(op.name, op);
  return op;
}

// ---------- http ----------

function send(res, status, body) {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
}

const googleError = (res, status, message, code = "") => send(res, status, { error: { code: status, message, status: code || (status === 403 ? "PERMISSION_DENIED" : status === 404 ? "NOT_FOUND" : "INVALID_ARGUMENT") } });

async function rawBody(req) {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  return Buffer.concat(chunks).toString("utf8");
}

async function body(req) {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  const text = Buffer.concat(chunks).toString("utf8");
  return text ? JSON.parse(text) : {};
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://localhost");
  const path = url.pathname;
  try {
    // Metadata server
    if (path.startsWith("/computeMetadata/")) {
      if (req.headers["metadata-flavor"] !== "Google") return googleError(res, 403, "Missing Metadata-Flavor header");
      if (path.endsWith("/service-accounts/default/token")) return send(res, 200, { access_token: TOKEN, expires_in: 3599, token_type: "Bearer" });
      if (path.endsWith("/project/project-id")) {
        res.writeHead(200, { "Content-Type": "text/plain" });
        return res.end(PROJECT);
      }
      return googleError(res, 404, "not found");
    }

    // OAuth token endpoint: the JWT bearer grant a service account key uses.
    if (path === "/token" && req.method === "POST") {
      const form = new URLSearchParams(await rawBody(req));
      if (form.get("grant_type") !== "urn:ietf:params:oauth:grant-type:jwt-bearer") return send(res, 400, { error: "unsupported_grant_type" });
      const [h, c, sig] = (form.get("assertion") || "").split(".");
      let claims;
      try {
        claims = JSON.parse(Buffer.from(c, "base64url").toString());
      } catch {
        return send(res, 400, { error: "invalid_grant", error_description: "malformed assertion" });
      }
      const pem = auth.serviceAccountKeys.get(claims.iss);
      const ok = pem && verify("RSA-SHA256", Buffer.from(`${h}.${c}`), createPublicKey(pem), Buffer.from(sig || "", "base64url"));
      if (!ok || claims.exp * 1000 < Date.now() || !String(claims.scope).includes("cloud-platform")) return send(res, 400, { error: "invalid_grant", error_description: "Invalid JWT Signature." });
      return send(res, 200, { access_token: TOKEN, expires_in: 3599, token_type: "Bearer" });
    }
    // Security Token Service: workload identity federation's token exchange.
    if (path === "/v1/token" && req.method === "POST") {
      const form = new URLSearchParams(await rawBody(req));
      if (!auth.subjectTokens.has(form.get("subject_token"))) return send(res, 400, { error: "invalid_grant", error_description: "The subject token is not valid for this pool." });
      const sts = `sts-${randomBytes(8).toString("hex")}`;
      auth.stsTokens.add(sts);
      return send(res, 200, { access_token: sts, issued_token_type: "urn:ietf:params:oauth:token-type:access_token", token_type: "Bearer", expires_in: 3600 });
    }
    // IAM Credentials: impersonate the watcher's service account with the federated token.
    if (/^\/v1\/projects\/-\/serviceAccounts\/[^/]+:generateAccessToken$/.test(path) && req.method === "POST") {
      const bearer = (req.headers.authorization || "").replace(/^Bearer /, "");
      if (!auth.stsTokens.has(bearer)) return googleError(res, 403, "Permission iam.serviceAccounts.getAccessToken denied");
      return send(res, 200, { accessToken: TOKEN, expireTime: new Date(Date.now() + 3600_000).toISOString() });
    }

    // Fake API frontends
    const callMatch = /^\/call\/([^/]+)$/.exec(path);
    if (callMatch && req.method === "POST") {
      const keyString = req.headers["x-goog-api-key"] || url.searchParams.get("key");
      const key = state.keys.find((k) => k.keyString === keyString);
      const result = call(key, callMatch[1], url.searchParams.get("method") || "call");
      return send(res, result.status, result.status === 200 ? { ok: true } : { error: { code: result.status, status: "PERMISSION_DENIED", reason: result.reason } });
    }

    // Test controls
    if (path.startsWith("/_emulator/")) {
      if (path === "/_emulator/reset" && req.method === "POST") {
        reset();
        return send(res, 200, { ok: true });
      }
      if (path === "/_emulator/keys") return send(res, 200, { project: PROJECT, keys: state.keys.map((k) => ({ ...publicKey(k), restrictions: k.restrictions })) });
      if (path === "/_emulator/traffic" && req.method === "POST") {
        const input = await body(req);
        const key = state.keys.find((k) => k.displayName === input.key || k.uid === input.key);
        if (!key) return googleError(res, 404, `no key ${input.key}`);
        const id = `${key.uid}|${input.service}`;
        if (!input.perMinute) state.generators.delete(id);
        else state.generators.set(id, { ...(state.generators.get(id) || { keyUid: key.uid, service: input.service, carry: 0, sent: 0, ok: 0 }), perMinute: input.perMinute });
        return send(res, 200, { ok: true });
      }
      // Put request counts straight into past minutes, for tests that can't wait for real time to pass.
      if (path === "/_emulator/inject" && req.method === "POST") {
        const input = await body(req);
        const key = state.keys.find((k) => k.displayName === input.key || k.uid === input.key);
        if (!key) return googleError(res, 404, `no key ${input.key}`);
        record(key, input.service, input.statusClass || "2xx", Date.now() - (input.minutesAgo ?? 1) * MINUTE, input.count);
        return send(res, 200, { ok: true });
      }
      if (path === "/_emulator/credentials" && req.method === "POST") {
        const input = await body(req);
        if (input.serviceAccount) auth.serviceAccountKeys.set(input.serviceAccount, input.publicKeyPem);
        if (input.subjectToken) auth.subjectTokens.add(input.subjectToken);
        return send(res, 200, { ok: true });
      }
      if (path === "/_emulator/generators") return send(res, 200, { generators: [...state.generators.values()] });
      return googleError(res, 404, "unknown control");
    }

    // Google APIs need a bearer token.
    if ((req.headers.authorization || "") !== `Bearer ${TOKEN}`) return googleError(res, 401, "Request had invalid authentication credentials.", "UNAUTHENTICATED");

    const tsMatch = /^\/v3\/projects\/([^/]+)\/timeSeries$/.exec(path);
    if (tsMatch && req.method === "GET") {
      if (tsMatch[1] !== PROJECT && tsMatch[1] !== PROJECT_NUMBER) return googleError(res, 403, "Permission monitoring.timeSeries.list denied");
      return send(res, 200, timeSeriesList(url.searchParams));
    }

    const listMatch = /^\/v2\/projects\/([^/]+)\/locations\/global\/keys$/.exec(path);
    if (listMatch && req.method === "GET") {
      if (listMatch[1] !== PROJECT && listMatch[1] !== PROJECT_NUMBER) return googleError(res, 403, "Permission apikeys.keys.list denied");
      return send(res, 200, { keys: state.keys.filter((k) => !k.deleteTime).map(publicKey) });
    }

    const keyMatch = /^\/v2\/projects\/([^/]+)\/locations\/global\/keys\/([^/:]+)(\/keyString)?$/.exec(path);
    if (keyMatch) {
      const key = state.keys.find((k) => k.name.endsWith(`/keys/${keyMatch[2]}`));
      if (!key) return googleError(res, 404, "Key not found");
      if (keyMatch[3]) return googleError(res, 403, "Permission apikeys.keys.getKeyString denied");
      if (req.method === "GET") return send(res, 200, publicKey(key));
      if (req.method === "PATCH") return send(res, 200, patchKey(key, url.searchParams.get("updateMask") || "", await body(req)));
      if (req.method === "DELETE") return googleError(res, 403, "Permission apikeys.keys.delete denied");
    }

    const opMatch = /^\/v2\/(operations\/[^/]+)$/.exec(path);
    if (opMatch && req.method === "GET") {
      const op = state.operations.get(opMatch[1]);
      return op ? send(res, 200, op) : googleError(res, 404, "Operation not found");
    }

    return googleError(res, 404, `No emulator route for ${req.method} ${path}`);
  } catch (error) {
    return googleError(res, error.status || 500, error.message, error.code);
  }
});

server.listen(port, "127.0.0.1", () => console.log(`GCP emulator on http://127.0.0.1:${port} (project ${PROJECT})`));
