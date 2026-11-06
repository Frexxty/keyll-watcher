/** Small helpers the provider modules share. */

/** Model names go to Keyll as service names, which are limited to lowercase letters, digits, dots and dashes. */
export function serviceFor(model) {
  const s = String(model || "")
    .toLowerCase()
    .replace(/[^a-z0-9.-]+/g, "-")
    .replace(/^[^a-z0-9]+/, "")
    .replace(/-+$/, "")
    .slice(0, 190);
  return s || "unknown-model";
}

/** Spacing between calls to one API, so a run never bursts. */
export function pacer(minGapMs) {
  let last = 0;
  return async () => {
    const wait = last + minGapMs - Date.now();
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    last = Date.now();
  };
}

/** [[key, service, time, ...values]] grouped into one series per key and service, oldest point first. */
export function toSeries(cells, point) {
  const byId = new Map();
  for (const c of cells.values()) {
    const id = `${c[0]}|${c[1]}`;
    const s = byId.get(id) || { key: c[0], service: c[1], points: [] };
    s.points.push(point(c));
    byId.set(id, s);
  }
  for (const s of byId.values()) s.points.sort((a, b) => a[0] - b[0]);
  return [...byId.values()];
}

/** Minute cells rolled up into hours: total and the busiest minute. */
export function hoursOf(minuteCells) {
  const HOUR = 3_600_000;
  const out = new Map();
  for (const [key, service, minute, total] of minuteCells.values()) {
    const hour = Math.floor(minute / HOUR) * HOUR;
    const id = `${key}|${service}|${hour}`;
    const cell = out.get(id) || [key, service, hour, 0, 0];
    cell[3] += total;
    cell[4] = Math.max(cell[4], total);
    out.set(id, cell);
  }
  return out;
}
