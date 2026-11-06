/**
 * One watcher run:
 *
 *   1. List the provider's keys (metadata only).
 *   2. Send Keyll a heartbeat: version, provider, local rails, trusted signing keys, the keys.
 *      Keyll answers with what to read and any signed commands.
 *   3. Run the commands that pass verification and the local rails. Report every outcome.
 *   4. Read what Keyll asked for, within the watcher's own limits, and send the raw numbers.
 *   5. Run any commands that came back.
 *
 * If Keyll can't be reached, the run ends after step 2. The watcher never blocks a key on its own: it has no
 * way to decide that. Keyll notices the missing heartbeats and tells you.
 *
 * Each provider implements:
 *   id, unit, capabilities    capabilities.block: how it blocks ("none" if it can't or isn't allowed to)
 *   scopeId()                 the project or account being watched
 *   listKeys()                the keys, with their block marker
 *   read(requests, keys)      the readings Keyll asked for
 *   block(key, command)       stop the key; restore(key, command) undo this watcher's own block
 *   lastSeq(key), blocksLastHour(keys), consumeSeq(key, seq)   replay protection and the blocks-per-hour rail
 *   isSelf(key)               the watcher's own credential, never blocked
 */
import { PROTOCOL, VERSION, railsSummary } from "./config.mjs";
import { railsCheck } from "./rails.mjs";
import { CommandRejected, verifyCommand } from "./signing.mjs";

const MINUTE = 60_000;
const HOUR = 3_600_000;
const DAY = 86_400_000;

/** The most the watcher reads in one run, whatever Keyll asks for. */
export const LIMITS = { minutesBack: DAY, hourlyBack: 35 * DAY, activityKeys: 10, costsBack: 31 * DAY };

export function log(severity, message, fields = {}) {
  process.stdout.write(`${JSON.stringify({ severity, message, component: "keyll-watcher", ...fields })}\n`);
}

/** Keyll's requests, clamped to the watcher's limits. Anything malformed is dropped. */
export function capRequests(requests = {}, now = Date.now()) {
  const out = {};
  const range = (r, back) => {
    const from = Date.parse(r?.from);
    const to = Date.parse(r?.to);
    if (!Number.isFinite(from) || !Number.isFinite(to)) return null;
    const end = Math.min(to, now + MINUTE);
    const start = Math.max(from, end - back);
    return start < end ? { from: new Date(start).toISOString(), to: new Date(end).toISOString() } : null;
  };
  const minutes = range(requests.minutes, LIMITS.minutesBack);
  if (minutes) out.minutes = minutes;
  const hourly = range(requests.hourly, LIMITS.hourlyBack);
  if (hourly) out.hourly = hourly;
  if (requests.counters === true) out.counters = true;
  if (Array.isArray(requests.activity)) out.activity = requests.activity.filter((k) => typeof k === "string").slice(0, LIMITS.activityKeys);
  if (requests.costs && Number.isFinite(Date.parse(requests.costs.from))) out.costs = { from: new Date(Math.max(Date.parse(requests.costs.from), now - LIMITS.costsBack)).toISOString() };
  if (requests.scopes === true) out.scopes = true;
  if (requests.logs && (requests.logs.after === null || typeof requests.logs.after === "string")) out.logs = { after: requests.logs.after };
  return out;
}

/** What the heartbeat says about a key. Never a key string: providers only hand over these fields. */
const publicKey = (k) => ({
  uid: k.uid,
  keyId: k.keyId,
  displayName: k.displayName,
  createdAt: k.createdAt,
  restrictions: k.restrictions,
  details: k.details || null,
  blocked: k.blocked,
  self: !!k.self,
});

/**
 * @param {{ config: object, provider: object, keyll: object, trusted: { kid: string }[], now?: number }} deps
 */
export async function runOnce({ config, provider, keyll, trusted, now = Date.now() }) {
  const summary = { ranAt: new Date(now).toISOString(), keys: 0, executed: 0, refused: 0, rejected: 0, errors: [] };
  let keys = [];
  let listed = true;
  try {
    keys = await provider.listKeys();
  } catch (error) {
    listed = false;
    summary.errors.push(`Couldn't list keys: ${error.message}`);
    log("ERROR", "list failed", { error: error.message });
  }
  summary.keys = keys.length;

  let response;
  try {
    response = await keyll.hello({
      protocol: PROTOCOL,
      version: VERSION,
      provider: provider.id,
      unit: provider.unit,
      capabilities: provider.capabilities,
      scope: { projectId: await provider.scopeId().catch(() => "") },
      ranAt: summary.ranAt,
      errors: summary.errors,
      rails: railsSummary(config, await provider.blocksLastHour(keys)),
      trustedKeys: trusted.map((k) => k.kid),
      keys: keys.map(publicKey),
    });
  } catch (error) {
    summary.errors.push(`Couldn't reach Keyll: ${error.message}`);
    log("WARNING", "Keyll unreachable; nothing to do until it answers", { error: error.message });
    return summary;
  }

  await runCommands(response?.commands || [], keys, { config, provider, keyll, trusted, now }, summary);
  if (!listed) return summary;

  const requests = capRequests(response?.requests, now);
  let readings = { errors: [] };
  try {
    readings = { errors: [], ...(await provider.read(requests, keys, { now })) };
  } catch (error) {
    readings.errors.push(`Couldn't read usage: ${error.message}`);
    log("ERROR", "read failed", { error: error.message });
  }
  summary.errors.push(...readings.errors);
  try {
    const back = await keyll.readings({ protocol: PROTOCOL, ranAt: summary.ranAt, ...readings });
    // Keys may have changed (a block just ran): list them again before running more commands.
    if (back.commands?.length) await runCommands(back.commands, await provider.listKeys(), { config, provider, keyll, trusted, now }, summary);
  } catch (error) {
    summary.errors.push(`Couldn't send readings: ${error.message}`);
    log("WARNING", "readings not sent", { error: error.message });
  }
  return summary;
}

/** Verifies, checks and runs each command, and reports what happened to every one of them. */
export async function runCommands(envelopes, keys, { config, provider, keyll, trusted, now }, summary) {
  for (const envelope of envelopes) {
    let command;
    try {
      command = verifyCommand(envelope, trusted, { watcherId: config.watcherId, workspaceId: config.workspaceId, now });
    } catch (error) {
      const reason = error instanceof CommandRejected ? error.reason : "malformed";
      summary.rejected++;
      log("WARNING", "rejected command", { reason });
      if (error.commandId) await report(keyll, error.commandId, { ok: false, reason });
      continue;
    }
    const key = keys.find((k) => k.uid === command.key.uid);
    const refusal = railsCheck(command, key, { config, provider, blocksLastHour: await provider.blocksLastHour(keys), lastSeq: key ? await provider.lastSeq(key) : 0 });
    // A verified command's number is used up whatever happens, so it can't be replayed later.
    if (key && refusal !== "replayed") await provider.consumeSeq(key, command.seq);
    if (refusal) {
      summary.refused++;
      log("NOTICE", "refused command", { action: command.action, key: key?.displayName || command.key.keyId, reason: refusal });
      await report(keyll, command.commandId, { ok: false, reason: refusal });
      continue;
    }
    try {
      if (command.action === "block") {
        const done = await provider.block(key, { incidentId: command.incidentId, commandId: command.commandId, seq: command.seq, now: new Date(now) });
        if (done.alreadyBlocked || done.refused) {
          if (done.refused) summary.refused++;
          await report(keyll, command.commandId, { ok: false, reason: done.refused || "already-blocked" });
          continue;
        }
        summary.executed++;
        log("ALERT", "blocked key", { key: key.displayName || key.keyId, incidentId: command.incidentId, method: done.method });
        await report(keyll, command.commandId, { ok: true, blockedAt: done.blockedAt, method: done.method });
      } else {
        const done = await provider.restore(key, { incidentId: command.incidentId, commandId: command.commandId, seq: command.seq, now: new Date(now) });
        if (done.ok) summary.executed++;
        else summary.refused++;
        log(done.ok ? "NOTICE" : "WARNING", "restore", { key: key.displayName || key.keyId, ...done });
        await report(keyll, command.commandId, done);
      }
    } catch (error) {
      log("ERROR", `${command.action} failed`, { key: key.displayName || key.keyId, error: error.message });
      await report(keyll, command.commandId, { ok: false, reason: `${command.action}-failed`, error: error.message.slice(0, 900) });
    }
  }
}

async function report(keyll, commandId, result) {
  await keyll.commandResult(commandId, result).catch((error) => log("WARNING", "couldn't report a command result", { error: error.message }));
}
