/**
 * The only outbound connection besides the provider's API. Everything sent to Keyll goes through the functions
 * here. Key strings never appear: the providers' APIs either can't return them (Google Cloud without
 * getKeyString) or only return redacted hints, which the watcher drops. As a second line of defence, toKeyll()
 * refuses to send anything shaped like a key.
 *
 *   hello(body)          heartbeat: version, provider, local rails, trusted signing keys, the keys' metadata
 *   readings(body)       raw usage numbers, split into posts of about a megabyte at most
 *   commandResult(id, r) what happened to one command: done, refused by a rail, or failed
 */
import { requestJson } from "./http.mjs";

/**
 * Google API keys (AIza…, AQ.…), Resend (re_…), Anthropic (sk-ant-…), OpenRouter (sk-or-…), OpenAI (sk-proj-…,
 * sk-svcacct-…, sk-admin-…, or sk- and letters). Real keys are 40 characters and longer; the length floors
 * leave redacted hints such as "sk-ant-api03-R2D...igAA" and names such as "sk-test-key" alone.
 */
export const KEY_STRING = new RegExp(
  [
    String.raw`AIza[0-9A-Za-z_-]{20,}`,
    String.raw`\bAQ\.[0-9A-Za-z_-]{20,}`,
    String.raw`\bre_[0-9A-Za-z_-]{20,}`,
    String.raw`(?<![0-9A-Za-z])sk-ant-[a-z]+\d*-[0-9A-Za-z_-]{24,}`,
    String.raw`(?<![0-9A-Za-z])sk-or-v\d+-[0-9A-Za-z]{24,}`,
    String.raw`(?<![0-9A-Za-z])sk-(?:proj|svcacct|admin|None)-[0-9A-Za-z_-]{24,}`,
    String.raw`(?<![0-9A-Za-z])sk-[0-9A-Za-z]{32,}`,
  ].join("|"),
);

const MAX_POST_BYTES = 1_000_000;

export function createKeyllClient({ keyllUrl, token }) {
  const headers = { Authorization: `Bearer ${token}`, "User-Agent": "keyll-watcher" };
  const post = (path, body) => requestJson(`${keyllUrl}${path}`, { method: "POST", headers, body: toKeyll(body), timeoutMs: 20_000 });
  return {
    hello: (body) => post("/v1/watcher/hello", body),
    /** Posts readings, split by key if they're large. Returns every command Keyll sent back. */
    async readings(body) {
      const commands = [];
      for (const part of splitReadings(body)) commands.push(...((await post("/v1/watcher/readings", part))?.commands || []));
      return { commands };
    },
    commandResult: (commandId, body) => post(`/v1/watcher/commands/${encodeURIComponent(commandId)}/result`, body),
  };
}

/** Throws instead of sending if a payload contains anything shaped like an API key string. */
export function toKeyll(body) {
  const text = JSON.stringify(body);
  if (KEY_STRING.test(text)) throw new Error("Refusing to send a payload that contains an API key string");
  return body;
}

/**
 * Splits readings into posts under MAX_POST_BYTES, by key, so each post replaces the minutes of its own keys.
 * Everything that isn't per-minute or per-hour series goes with the first post.
 */
export function splitReadings(body) {
  if (JSON.stringify(body).length <= MAX_POST_BYTES) return [body];
  const keysOf = (part) => [...new Set([...(part?.series || []).map((s) => s.key), ...(part?.keys || [])])];
  const allKeys = [...new Set([...keysOf(body.minutes), ...keysOf(body.hourly)])];
  const size = (k) => JSON.stringify([body.minutes?.series.filter((s) => s.key === k), body.hourly?.series.filter((s) => s.key === k)]).length;
  const groups = [];
  let current = [];
  let bytes = 0;
  for (const k of allKeys) {
    const n = size(k);
    if (current.length && bytes + n > MAX_POST_BYTES * 0.8) {
      groups.push(current);
      current = [];
      bytes = 0;
    }
    current.push(k);
    bytes += n;
  }
  if (current.length) groups.push(current);
  const { minutes, hourly, ...rest } = body;
  return groups.map((g, i) => {
    const set = new Set(g);
    return {
      ...(i === 0 ? rest : { protocol: rest.protocol, ranAt: rest.ranAt, errors: [] }),
      ...(minutes && { minutes: { ...minutes, keys: (minutes.keys || allKeys).filter((k) => set.has(k)), series: minutes.series.filter((s) => set.has(s.key)) } }),
      ...(hourly && { hourly: { ...hourly, series: hourly.series.filter((s) => set.has(s.key)) } }),
    };
  });
}
