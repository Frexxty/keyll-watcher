/**
 * Verifies the commands Keyll sends. A command is a signed JSON payload for one action (block or restore) on
 * one key, for one workspace and one watcher, with a sequence number and a short validity window.
 *
 * The watcher checks, in order: the envelope's shape, the signature against a trusted public key, the version,
 * audience and type, the workspace and watcher IDs, the action, the key and incident IDs, and the validity
 * window. Anything that fails is rejected with a reason and never touches a key. A valid signature only means
 * the command came from Keyll; the local rails in rails.mjs still decide whether it runs.
 */
import { createHash, createPublicKey, verify } from "node:crypto";
import { TRUSTED_KEYS } from "./trusted-keys.mjs";

const MAX_CLOCK_SKEW_MS = 2 * 60_000;
/** The longest validity window the watcher accepts on a command. */
export const MAX_VALIDITY_MS = 15 * 60_000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** A key's ID: the first 16 hex characters of the SHA-256 of its public key (SPKI DER). */
export const kidOf = (der) => createHash("sha256").update(der).digest("hex").slice(0, 16);

/** @param {string} value base64 SPKI DER, or a PEM block */
export function loadPublicKey(value) {
  const text = String(value || "").trim();
  if (!text) throw new Error("empty public key");
  const key = text.includes("BEGIN PUBLIC KEY") ? createPublicKey(text) : createPublicKey({ key: Buffer.from(text, "base64"), format: "der", type: "spki" });
  if (key.asymmetricKeyType !== "ed25519") throw new Error("Keyll's public keys must be Ed25519");
  return { kid: kidOf(key.export({ type: "spki", format: "der" })), key };
}

/** The built-in keys plus any given at install. Duplicates are dropped. */
export function trustedKeys(extra = []) {
  const all = [...TRUSTED_KEYS, ...extra].map(loadPublicKey);
  return [...new Map(all.map((k) => [k.kid, k])).values()];
}

export class CommandRejected extends Error {
  constructor(reason, commandId = null) {
    super(reason);
    this.reason = reason;
    this.commandId = commandId;
  }
}

/**
 * Returns the verified command, or throws CommandRejected with the reason.
 * @param {{ payload: string, signature: string, kid?: string }} envelope
 * @param {{ kid: string, key: import("node:crypto").KeyObject }[]} keys
 * @param {{ watcherId: string, workspaceId: string, now?: number }} expect
 */
export function verifyCommand(envelope, keys, { watcherId, workspaceId, now = Date.now() }) {
  if (!envelope || typeof envelope.payload !== "string" || typeof envelope.signature !== "string") throw new CommandRejected("malformed");
  let claimed = null;
  try {
    claimed = JSON.parse(envelope.payload);
  } catch {
    throw new CommandRejected("malformed");
  }
  const id = typeof claimed?.commandId === "string" && UUID.test(claimed.commandId) ? claimed.commandId : null;
  const candidates = envelope.kid ? keys.filter((k) => k.kid === envelope.kid) : keys;
  const signature = Buffer.from(envelope.signature, "base64");
  if (!candidates.some((k) => verify(null, Buffer.from(envelope.payload, "utf8"), k.key, signature))) throw new CommandRejected(candidates.length ? "bad-signature" : "unknown-signing-key", id);
  const c = claimed;
  if (c.v !== 2) throw new CommandRejected("unsupported-version", id);
  if (c.aud !== "keyll-watcher" || c.type !== "command") throw new CommandRejected("wrong-audience", id);
  if (c.watcherId !== watcherId) throw new CommandRejected("wrong-watcher", id);
  if (c.workspaceId !== workspaceId) throw new CommandRejected("wrong-workspace", id);
  if (c.action !== "block" && c.action !== "restore") throw new CommandRejected("unknown-action", id);
  if (!id || !UUID.test(String(c.incidentId))) throw new CommandRejected("malformed", id);
  if (!c.key || typeof c.key.uid !== "string" || typeof c.key.keyId !== "string") throw new CommandRejected("malformed", id);
  if (!Number.isSafeInteger(c.seq) || c.seq < 1) throw new CommandRejected("malformed", id);
  const issued = Date.parse(c.issuedAt);
  const expires = Date.parse(c.expiresAt);
  if (!Number.isFinite(issued) || !Number.isFinite(expires)) throw new CommandRejected("malformed", id);
  if (issued > now + MAX_CLOCK_SKEW_MS) throw new CommandRejected("issued-in-future", id);
  if (expires < now) throw new CommandRejected("expired", id);
  if (expires - issued > MAX_VALIDITY_MS) throw new CommandRejected("validity-too-long", id);
  return c;
}
