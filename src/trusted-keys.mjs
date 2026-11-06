/**
 * Keyll's public signing keys. The watcher only runs a command signed by one of these, or by a key given in
 * KEYLL_PUBLIC_KEYS at install time. Each key is base64 SPKI DER (Ed25519).
 *
 * Rotation: a new key is added here in a release before Keyll starts signing with it, and an old key is
 * removed only after Keyll has stopped using it. The heartbeat tells Keyll which keys this watcher trusts.
 */
export const TRUSTED_KEYS = [
  // Keyll production signing key (kid c1082a765ec70f16).
  "MCowBQYDK2VwAyEAEMLN1PwhOQCY4r36du9mAIRjcMWieucVH1xcFhKLc0A=",
];
