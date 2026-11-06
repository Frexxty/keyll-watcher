/**
 * Small fetch wrapper: JSON in and out, a timeout, and retries on 429 and 5xx. A 429 or 503 with a
 * Retry-After header waits as long as the header asks (up to maxWaitMs); otherwise the wait doubles each try.
 */

export class HttpError extends Error {
  /** @param {string} message @param {number} status @param {unknown} body */
  constructor(message, status, body) {
    super(message);
    this.status = status;
    this.body = body;
  }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * @param {string} url
 * @param {{ method?: string, headers?: Record<string, string>, body?: unknown, timeoutMs?: number, retries?: number, maxWaitMs?: number }} [options]
 */
export async function requestJson(url, { method = "GET", headers = {}, body, timeoutMs = 15_000, retries = 2, maxWaitMs = 30_000 } = {}) {
  for (let attempt = 0; ; attempt++) {
    let response;
    try {
      response = await fetch(url, {
        method,
        headers: { Accept: "application/json", ...(body === undefined ? {} : { "Content-Type": "application/json" }), ...headers },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (error) {
      if (attempt < retries) {
        await sleep(400 * 2 ** attempt);
        continue;
      }
      throw new HttpError(`${method} ${redact(url)} failed: ${error.message}`, 0, null);
    }
    const text = await response.text();
    let data = null;
    try {
      data = text ? JSON.parse(text) : null;
    } catch {
      data = text;
    }
    if (response.ok) return data;
    if ((response.status === 429 || response.status >= 500) && attempt < retries) {
      await sleep(Math.min(retryAfterMs(response.headers.get("retry-after")) ?? 400 * 2 ** attempt, maxWaitMs));
      continue;
    }
    const detail = data && typeof data === "object" && data.error ? data.error.message || data.error : response.statusText;
    throw new HttpError(`${method} ${redact(url)} returned ${response.status}: ${detail}`, response.status, data);
  }
}

/** Retry-After as seconds or an HTTP date, in milliseconds. Null when absent or unreadable. */
export function retryAfterMs(value, now = Date.now()) {
  if (!value) return null;
  if (/^\d+(\.\d+)?$/.test(value.trim())) return Number(value) * 1000;
  const at = Date.parse(value);
  return Number.isFinite(at) ? Math.max(0, at - now) : null;
}

/** Drop the query string from URLs in error messages, so filters and tokens never end up in logs. */
function redact(url) {
  return String(url).split("?")[0];
}
