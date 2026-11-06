/**
 * The local safety rails. They run after a command's signature checks out and before anything touches a key, and
 * they only depend on settings made where the watcher runs. Keyll can't change them, so they protect your keys
 * even if Keyll's servers are compromised:
 *
 *   dry run                   KEYLL_MODE=dry-run (the default): no block runs at all
 *   never block               KEYLL_PROTECTED_KEYS: these keys are never blocked
 *   blocks per hour           KEYLL_MAX_BLOCKS_PER_HOUR (default 3): no more blocks than that in any hour
 *   reversible only           a block that can't be undone (Resend deletes keys) needs KEYLL_ALLOW_DELETE=true
 *   OpenAI                    blocks need KEYLL_OPENAI_BLOCK=recorded-scopes
 *   the watcher's own key     never blocked
 *   restore never widens      a restore only undoes this watcher's own block of that key, for that incident, back
 *                             to exactly what the key had (checked by each provider)
 *   replays                   a command whose sequence number isn't newer than the last one run for that key
 *                             (or that watcher) is refused
 */

/** Matches a key by uid, key ID or display name. */
export const matchesKey = (list, key) => list.some((id) => id === key.uid || id === key.keyId || id === key.displayName);

/**
 * Null if the command may run, otherwise the reason it may not.
 * @param {object} command a verified command
 * @param {object | undefined} key the key as the provider lists it now
 * @param {{ config: object, provider: object, blocksLastHour: number, lastSeq: number }} context
 */
export function railsCheck(command, key, { config, provider, blocksLastHour, lastSeq }) {
  if (!key) return "unknown-key";
  if (command.key.keyId !== key.keyId) return "key-mismatch";
  if (command.seq <= lastSeq) return "replayed";
  if (command.action === "restore") return null;
  if (config.mode !== "enforce") return "dry-run";
  if (matchesKey(config.protectedKeys, key)) return "protected";
  if (key.self || provider.isSelf(key)) return "watcher-key";
  if (provider.capabilities.block === "none") return provider.capabilities.destructive ? "destructive-not-allowed" : "alert-only-provider";
  if (provider.capabilities.destructive && !config.allowDelete) return "destructive-not-allowed";
  if (blocksLastHour >= config.maxBlocksPerHour) return "block-limit";
  return null;
}
