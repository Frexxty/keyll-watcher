/**
 * The watcher's local record of its own blocks, for providers whose keys can't carry a marker (Anthropic,
 * OpenAI, OpenRouter, Resend). Google Cloud keys carry the same record in their own annotations instead.
 *
 * It holds, per key the watcher blocked: the incident and command that blocked it, when, and what a restore
 * needs (for OpenAI, the key's permissions before the block, which never leave your environment). It also holds
 * the time of each recent block, for the blocks-per-hour rail, and the highest command sequence number run, so
 * a replayed command is refused. Never a key string. KEYLL_STATE_DIR/<provider>-ledger.json, mode 600.
 */
import fs from "node:fs";
import path from "node:path";

const HOUR = 3_600_000;

export function createLedger(config, name) {
  const file = path.join(config.stateDir, `${name}-ledger.json`);
  const empty = () => ({ v: 2, seq: 0, blocks: {}, recent: [] });
  return {
    file,
    load() {
      try {
        return { ...empty(), ...JSON.parse(fs.readFileSync(file, "utf8")) };
      } catch {
        return empty();
      }
    },
    save(st) {
      fs.mkdirSync(config.stateDir, { recursive: true });
      const tmp = `${file}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(st), { mode: 0o600 });
      fs.renameSync(tmp, file);
    },
  };
}

export const blocksInLastHour = (st, now = Date.now()) => st.recent.filter((at) => now - Date.parse(at) < HOUR).length;

export function recordBlock(st, uid, entry, now = new Date()) {
  st.blocks[uid] = { ...entry, blockedAt: now.toISOString() };
  st.recent = [...st.recent.filter((at) => now.getTime() - Date.parse(at) < HOUR), now.toISOString()];
}

/** The marker the heartbeat reports for a key this watcher blocked. */
export const blockMarker = (st, uid) => (st.blocks[uid] ? { incidentId: st.blocks[uid].incidentId, blockedAt: st.blocks[uid].blockedAt } : null);

/** Replay protection and the blocks-per-hour rail, from the ledger. One sequence counter per watcher. */
export function ledgerRails(ledger) {
  return {
    blocksLastHour: async () => blocksInLastHour(ledger.load()),
    lastSeq: async () => ledger.load().seq || 0,
    consumeSeq: async (_key, seq) => {
      const st = ledger.load();
      if (seq > (st.seq || 0)) {
        st.seq = seq;
        ledger.save(st);
      }
    },
  };
}
