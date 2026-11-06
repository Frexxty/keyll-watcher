/**
 * Google Cloud: API keys from the API Keys API (v2), request counts from Cloud Monitoring.
 *
 * Required permissions, all in one custom role (see install.sh):
 *   monitoring.timeSeries.list   read per-key request counts
 *   apikeys.keys.list            list keys and their restrictions
 *   apikeys.keys.get             re-read a key before and after changing it
 *   apikeys.keys.update          block (swap restrictions) and restore
 * Deliberately missing: apikeys.keys.getKeyString, so the watcher can't read a key's secret value, and
 * apikeys.keys.delete / create, so it can't remove or mint keys.
 *
 * Blocking replaces a key's restrictions with BLOCKED_RESTRICTIONS and saves the old ones in the key's own
 * annotations, with the incident and command that blocked it. Restoring writes them back, only for that
 * incident. The saved copy never leaves your project, so Keyll can't choose what a key gets restored to.
 * Nothing is stored anywhere else: the Google Cloud watcher keeps no local state.
 */
import fs from "node:fs";
import { requestJson } from "../http.mjs";
import { toSeries } from "./common.mjs";
import { tokenSourceFromFile } from "./gcp-auth.mjs";

export const MONITORING_METRIC = "serviceruntime.googleapis.com/api/request_count";

/**
 * Restrictions that let a key call nothing. API Keys v2 has no "disable" and no documented "allow nothing"
 * restriction, so a block stacks two restrictions that each reject every real request:
 *   - an IP allowlist holding only 192.0.2.1, an address reserved for documentation (RFC 5737) that no
 *     client can send from
 *   - an API allowlist naming one method that doesn't exist, on the API Keys API
 * If Google rejects the method name, BLOCK_FALLBACKS drops it and keeps the IP allowlist.
 */
export const BLOCKED_RESTRICTIONS = {
  serverKeyRestrictions: { allowedIps: ["192.0.2.1/32"] },
  apiTargets: [{ service: "apikeys.googleapis.com", methods: ["KeyllBlockedThisKey"] }],
};
export const BLOCK_FALLBACKS = [BLOCKED_RESTRICTIONS, { serverKeyRestrictions: { allowedIps: ["192.0.2.1/32"] }, apiTargets: [{ service: "apikeys.googleapis.com" }] }];
export const isBlockRestriction = (r) => BLOCK_FALLBACKS.some((b) => sameRestrictions(r, b));

export const ANNOTATIONS = {
  incident: "keyll.cloud/incident",
  command: "keyll.cloud/command",
  blockedAt: "keyll.cloud/blocked-at",
  saved: "keyll.cloud/saved-restrictions",
  lastBlockedAt: "keyll.cloud/last-blocked-at",
  seq: "keyll.cloud/seq",
};

/** Cloud Monitoring labels API key traffic with credential_id "apikey:<uid>", where uid is the Key resource's uid field. */
export const credentialIdFor = (key) => `apikey:${key.uid}`;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const HOUR = 3_600_000;

export function createGcpProvider(config) {
  const { endpoints } = config;
  let cachedToken = null;
  // Outside Google Cloud: a credentials file (workload identity federation, a key, or a gcloud login).
  const fileSource = !config.accessToken && config.credentialsFile ? tokenSourceFromFile(config.credentialsFile) : null;
  let project = config.project || fileSource?.projectId || "";
  // Personal credentials need a project to bill API quota to. Service accounts don't.
  const personal = !!config.accessToken || (config.credentialsFile && /"authorized_user"/.test(readSafe(config.credentialsFile)));

  async function accessToken() {
    if (config.accessToken) return config.accessToken;
    if (cachedToken && cachedToken.expires > Date.now() + 60_000) return cachedToken.value;
    if (fileSource) {
      cachedToken = await fileSource.token();
      return cachedToken.value;
    }
    const data = await requestJson(`${endpoints.metadata}/computeMetadata/v1/instance/service-accounts/default/token`, {
      headers: { "Metadata-Flavor": "Google" },
      timeoutMs: 5_000,
    });
    cachedToken = { value: data.access_token, expires: Date.now() + Number(data.expires_in || 300) * 1000 };
    return cachedToken.value;
  }

  async function projectId() {
    if (project) return project;
    if (fileSource || config.accessToken) throw new Error("Set GCP_PROJECT to the project the watcher protects");
    project = await fetch(`${endpoints.metadata}/computeMetadata/v1/project/project-id`, {
      headers: { "Metadata-Flavor": "Google" },
      signal: AbortSignal.timeout(5_000),
    }).then((r) => (r.ok ? r.text() : ""));
    if (!project) throw new Error("Set GCP_PROJECT: the project ID isn't available from the metadata server");
    return project;
  }

  async function google(url, options = {}) {
    const token = await accessToken();
    const quota = personal && project ? { "x-goog-user-project": project } : {};
    return requestJson(url, { ...options, retries: 4, headers: { Authorization: `Bearer ${token}`, ...quota, ...(options.headers || {}) } });
  }

  async function listKeys() {
    const p = await projectId();
    const keys = [];
    let pageToken = "";
    do {
      const url = new URL(`${endpoints.apikeys}/v2/projects/${encodeURIComponent(p)}/locations/global/keys`);
      url.searchParams.set("pageSize", "300");
      if (pageToken) url.searchParams.set("pageToken", pageToken);
      const data = await google(url.href);
      for (const key of data?.keys || []) keys.push(normalizeKey(key));
      pageToken = data?.nextPageToken || "";
    } while (pageToken);
    return keys;
  }

  const getKey = (name) => google(`${endpoints.apikeys}/v2/${name}`);

  /**
   * Update restrictions and annotations, then read the key back until the change shows. Polling the returned
   * Operation would need serviceusage.operations.get, which custom roles only get as "testing", so the watcher
   * polls keys.get instead. The Operation's response is never read.
   */
  async function patchKey(raw, { restrictions, annotations }) {
    const url = new URL(`${endpoints.apikeys}/v2/${raw.name}`);
    url.searchParams.set("updateMask", "restrictions,annotations");
    const body = { annotations, etag: raw.etag };
    // Leaving restrictions out under the mask clears them, which is how an originally unrestricted key is restored.
    if (restrictions) body.restrictions = restrictions;
    const op = await google(url.href, { method: "PATCH", body });
    if (op?.error) throw new Error(`Key update failed: ${op.error.message || JSON.stringify(op.error)}`);
    for (let i = 0; ; i++) {
      const key = await getKey(raw.name);
      if (sameRestrictions(key.restrictions, restrictions) && sameAnnotations(key.annotations, annotations)) return key;
      if (i >= 20) return key;
      await sleep(1000);
    }
  }

  async function block(key, { incidentId, commandId, seq, now = new Date() }) {
    const raw = await getKey(key.name);
    const annotations = { ...(raw.annotations || {}) };
    if (annotations[ANNOTATIONS.incident]) return { alreadyBlocked: true, incidentId: annotations[ANNOTATIONS.incident] };
    Object.assign(annotations, {
      [ANNOTATIONS.incident]: incidentId,
      [ANNOTATIONS.command]: commandId,
      [ANNOTATIONS.blockedAt]: now.toISOString(),
      [ANNOTATIONS.lastBlockedAt]: now.toISOString(),
      [ANNOTATIONS.saved]: encodeSaved(raw.restrictions),
      [ANNOTATIONS.seq]: String(seq),
    });
    let lastError = null;
    for (const [i, restrictions] of BLOCK_FALLBACKS.entries()) {
      try {
        const updated = await patchKey(raw, { restrictions, annotations });
        if (!sameRestrictions(updated.restrictions, restrictions)) throw new Error("Key update returned, but the restrictions didn't change");
        return { blockedAt: now.toISOString(), method: i === 0 ? "restrictions" : "restrictions-fallback" };
      } catch (error) {
        lastError = error;
        // Only a rejected restriction is worth retrying in the simpler form. Anything else (permissions, etag) fails now.
        if (error.status !== 400) break;
      }
    }
    throw lastError;
  }

  /**
   * Puts back the restrictions saved when this incident blocked the key. Refuses unless the key is still marked
   * with this exact incident, so a command can only undo a block this watcher made, once.
   */
  async function restore(key, { incidentId, seq, now = new Date() }) {
    const raw = await getKey(key.name);
    const annotations = { ...(raw.annotations || {}) };
    if (annotations[ANNOTATIONS.incident] !== incidentId) return { ok: false, reason: "not-blocked-by-this-incident" };
    const saved = decodeSaved(annotations[ANNOTATIONS.saved]);
    for (const name of [ANNOTATIONS.incident, ANNOTATIONS.command, ANNOTATIONS.blockedAt, ANNOTATIONS.saved]) delete annotations[name];
    annotations[ANNOTATIONS.seq] = String(seq);
    if (!isBlockRestriction(raw.restrictions)) {
      // Someone changed the key by hand after it was blocked. Keep their change and just drop the marker.
      await patchKey(raw, { restrictions: raw.restrictions, annotations });
      return { ok: true, restoredAt: now.toISOString(), note: "changed-outside-keyll" };
    }
    const updated = await patchKey(raw, { restrictions: saved, annotations });
    if (!sameRestrictions(updated.restrictions, saved)) throw new Error("Key update returned, but the saved restrictions weren't applied");
    return { ok: true, restoredAt: now.toISOString() };
  }

  // Google's docs show both resource.label.x and resource.labels.x for groupByFields. Try the documented
  // spelling first and remember whichever the API accepts.
  let labelPrefix = "resource.labels.";
  async function timeSeries(args) {
    try {
      return await timeSeriesWith(args, labelPrefix);
    } catch (error) {
      if (error.status !== 400 || labelPrefix === "resource.label.") throw error;
      labelPrefix = "resource.label.";
      return timeSeriesWith(args, labelPrefix);
    }
  }

  async function timeSeriesWith({ start, end, period, aligner, metricGroupBy = [] }, prefix) {
    const p = await projectId();
    const series = [];
    let pageToken = "";
    do {
      const url = new URL(`${endpoints.monitoring}/v3/projects/${encodeURIComponent(p)}/timeSeries`);
      const q = url.searchParams;
      q.set("filter", `metric.type="${MONITORING_METRIC}" AND resource.type="consumed_api" AND resource.labels.credential_id=starts_with("apikey:")`);
      q.set("interval.startTime", new Date(start).toISOString());
      q.set("interval.endTime", new Date(end).toISOString());
      q.set("aggregation.alignmentPeriod", `${period}s`);
      q.set("aggregation.perSeriesAligner", aligner);
      q.set("aggregation.crossSeriesReducer", "REDUCE_SUM");
      const metricPrefix = prefix.replace("resource.", "metric.");
      for (const field of [`${prefix}credential_id`, `${prefix}service`, ...metricGroupBy.map((l) => metricPrefix + l)]) q.append("aggregation.groupByFields", field);
      q.set("view", "FULL");
      q.set("pageSize", "10000");
      if (pageToken) q.set("pageToken", pageToken);
      const data = await google(url.href);
      for (const ts of data?.timeSeries || []) {
        series.push({
          credentialId: ts.resource?.labels?.credential_id || "",
          service: ts.resource?.labels?.service || "",
          responseClass: ts.metric?.labels?.response_code_class || "",
          points: (ts.points || []).map((pt) => ({
            start: Date.parse(pt.interval.startTime || pt.interval.endTime) || Date.parse(pt.interval.endTime) - period * 1000,
            value: Number(pt.value?.int64Value ?? pt.value?.doubleValue ?? 0),
          })),
        });
      }
      pageToken = data?.nextPageToken || "";
    } while (pageToken);
    return series;
  }

  /** Requests per key, service and minute (all, and non-2xx), and on request hourly totals and peaks. */
  async function read(requests, keys) {
    const uidOf = new Map(keys.map((k) => [credentialIdFor(k), k.uid]));
    const out = {};
    if (requests.minutes) {
      const start = Date.parse(requests.minutes.from);
      const end = Date.parse(requests.minutes.to);
      const raw = await timeSeries({ start, end, period: 60, aligner: "ALIGN_SUM", metricGroupBy: ["response_code_class"] });
      const cells = new Map();
      for (const s of raw) {
        const uid = uidOf.get(s.credentialId);
        if (!uid || !s.service) continue;
        for (const p of s.points) {
          const minute = Math.floor(p.start / 60_000) * 60_000;
          const id = `${uid}|${s.service}|${minute}`;
          const cell = cells.get(id) || [uid, s.service, minute, 0, 0];
          cell[3] += p.value;
          if (s.responseClass && s.responseClass !== "2xx") cell[4] += p.value;
          cells.set(id, cell);
        }
      }
      out.minutes = { from: requests.minutes.from, to: requests.minutes.to, keys: keys.map((k) => k.uid), series: toSeries(cells, (c) => [c[2] / 1000, c[3], c[4]]) };
    }
    if (requests.hourly) {
      const start = Date.parse(requests.hourly.from);
      const end = Date.parse(requests.hourly.to);
      const [sums, maxes] = await Promise.all([
        timeSeries({ start, end, period: 3600, aligner: "ALIGN_SUM" }),
        timeSeries({ start, end, period: 3600, aligner: "ALIGN_MAX" }),
      ]);
      const cells = new Map();
      const put = (list, index) => {
        for (const s of list) {
          const uid = uidOf.get(s.credentialId);
          if (!uid || !s.service) continue;
          for (const p of s.points) {
            const hour = Math.floor(p.start / HOUR) * HOUR;
            const id = `${uid}|${s.service}|${hour}`;
            const cell = cells.get(id) || [uid, s.service, hour, 0, 0];
            cell[index] += p.value;
            cells.set(id, cell);
          }
        }
      };
      put(sums, 3);
      put(maxes, 4);
      out.hourly = { from: requests.hourly.from, to: requests.hourly.to, series: toSeries(cells, (c) => [c[2] / 1000, c[3], c[4], 0]) };
    }
    return out;
  }

  const recentBlocks = (keys) => keys.filter((k) => k.lastBlockedAt && Date.now() - Date.parse(k.lastBlockedAt) < HOUR).length;

  return {
    id: "gcp",
    unit: "requests",
    capabilities: { block: "restrictions", restore: true },
    scopeId: projectId,
    listKeys,
    read,
    block,
    restore,
    isSelf: () => false,
    blocksLastHour: async (keys) => recentBlocks(keys),
    lastSeq: async (key) => key.seq || 0,
    // The sequence number is written to the key itself when a command changes it; nothing else is stored.
    consumeSeq: async () => {},
  };
}

function readSafe(path) {
  try {
    return fs.readFileSync(path, "utf8");
  } catch {
    return "";
  }
}

/** Only the fields Keyll may see, plus the resource name the watcher needs for updates. Never keyString. */
export function normalizeKey(raw) {
  const annotations = raw.annotations || {};
  const r = raw.restrictions || {};
  return {
    name: raw.name,
    keyId: String(raw.name || "").split("/").pop(),
    uid: raw.uid,
    displayName: raw.displayName || "",
    createdAt: raw.createTime || null,
    restrictions: {
      apiTargets: (r.apiTargets || []).map((t) => t.service).filter(Boolean),
      kind: r.browserKeyRestrictions ? "browser" : r.serverKeyRestrictions ? "server" : r.androidKeyRestrictions ? "android" : r.iosKeyRestrictions ? "ios" : "none",
      unrestricted: !r.apiTargets?.length,
    },
    blocked: annotations[ANNOTATIONS.incident] ? { incidentId: annotations[ANNOTATIONS.incident], blockedAt: annotations[ANNOTATIONS.blockedAt] || null } : null,
    lastBlockedAt: annotations[ANNOTATIONS.lastBlockedAt] || null,
    seq: Number(annotations[ANNOTATIONS.seq]) || 0,
  };
}

export function encodeSaved(restrictions) {
  return Buffer.from(JSON.stringify(restrictions || null), "utf8").toString("base64url");
}

export function decodeSaved(value) {
  if (!value) throw new Error("This key has no saved restrictions to restore");
  return JSON.parse(Buffer.from(value, "base64url").toString("utf8")) || undefined;
}

function sameAnnotations(a, b) {
  return canonical(a || {}) === canonical(b || {});
}

export function sameRestrictions(a, b) {
  return canonical(a || {}) === canonical(b || {});
}

function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object")
    return `{${Object.keys(value)
      .filter((k) => value[k] !== undefined && !(Array.isArray(value[k]) && value[k].length === 0))
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonical(value[k])}`)
      .join(",")}}`;
  return JSON.stringify(value);
}
