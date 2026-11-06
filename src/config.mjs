/**
 * Configuration, from environment variables set where the watcher runs. Only someone with access to that
 * environment can change any of it: Keyll can't.
 *
 * Three kinds of setting: how to reach Keyll, the provider and its credentials, and the local safety rails.
 */
import fs from "node:fs";

export const VERSION = "0.2.0";
export const PROTOCOL = 2;

export const PROVIDERS = ["gcp", "resend", "anthropic", "openai", "openrouter"];

/** Settings earlier watcher versions read. They no longer do anything. */
const RETIRED = [
  "KEYLL_ALERT_MULTIPLIER",
  "KEYLL_BLOCK_MULTIPLIER",
  "KEYLL_BLOCK_AFTER_MINUTES",
  "KEYLL_MIN_RATE",
  "KEYLL_MULTIPLIER",
  "KEYLL_MULTIPLIER_FLOOR",
  "KEYLL_MIN_RATE_FLOOR",
  "KEYLL_BLOCK_AFTER_FLOOR",
  "KEYLL_WINDOW_MINUTES",
  "KEYLL_RECENT_MINUTES",
  "KEYLL_BASELINE_DAYS",
  "KEYLL_BASELINE_EXCLUDE_MINUTES",
  "KEYLL_NEW_SERVICE_ALERTS",
  "KEYLL_NEW_SERVICE_MIN_REQUESTS",
  "KEYLL_LEARNING_HOURS",
  "KEYLL_MAX_SNOOZE_MINUTES",
  "KEYLL_COST_SPIKE_MULTIPLIER",
  "KEYLL_COST_SPIKE_MIN_USD",
  "KEYLL_PUBLIC_KEY",
];

function num(env, name, fallback, { min = -Infinity, max = Infinity } = {}) {
  const raw = env[name];
  if (raw === undefined || raw === "") return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value) || value < min || value > max) throw new Error(`${name} must be a number between ${min} and ${max}`);
  return value;
}

function list(value) {
  return String(value || "")
    .split(/[\s,]+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

/** A secret from NAME, or from the file NAME_FILE points to (Docker and Kubernetes secrets). */
function secret(env, name) {
  if (env[name]) return String(env[name]).trim();
  const file = env[`${name}_FILE`];
  if (!file) return "";
  try {
    return fs.readFileSync(file, "utf8").trim();
  } catch (error) {
    throw new Error(`${name}_FILE: couldn't read ${file} (${error.code || error.message})`);
  }
}

const bool = (env, name) => {
  const v = env[name];
  if (v === undefined || v === "") return false;
  if (v === "true" || v === "false") return v === "true";
  throw new Error(`${name} must be true or false`);
};

export function loadConfig(env = process.env) {
  const mode = env.KEYLL_MODE || "dry-run";
  if (mode !== "dry-run" && mode !== "enforce") throw new Error("KEYLL_MODE must be dry-run or enforce");
  const keyllUrl = (env.KEYLL_URL || "").replace(/\/+$/, "");
  if (keyllUrl && !/^https:\/\//.test(keyllUrl) && !/^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(keyllUrl)) throw new Error("KEYLL_URL must use https");
  const provider = env.KEYLL_PROVIDER || "gcp";
  if (!PROVIDERS.includes(provider)) throw new Error(`KEYLL_PROVIDER must be one of ${PROVIDERS.join(", ")}`);
  const openaiBlock = env.KEYLL_OPENAI_BLOCK || "off";
  if (openaiBlock !== "off" && openaiBlock !== "recorded-scopes") throw new Error("KEYLL_OPENAI_BLOCK must be off or recorded-scopes");
  const retired = RETIRED.filter((name) => env[name] !== undefined && env[name] !== "");
  const config = {
    provider,
    keyllUrl,
    token: env.KEYLL_TOKEN || "",
    watcherId: env.KEYLL_WATCHER_ID || "",
    workspaceId: env.KEYLL_WORKSPACE_ID || "",
    // Extra public keys to trust, on top of src/trusted-keys.mjs. KEYLL_PUBLIC_KEY was the single-key name.
    publicKeys: [...list(env.KEYLL_PUBLIC_KEYS), ...list(env.KEYLL_PUBLIC_KEY)],
    retired: retired.filter((n) => n !== "KEYLL_PUBLIC_KEY"),
    stateDir: env.KEYLL_STATE_DIR || "/var/lib/keyll",
    scopeLabel: env.KEYLL_SCOPE_LABEL || "",

    // Local safety rails. See src/rails.mjs.
    mode,
    protectedKeys: list(env.KEYLL_PROTECTED_KEYS),
    maxBlocksPerHour: num(env, "KEYLL_MAX_BLOCKS_PER_HOUR", 3, { min: 0, max: 100 }),
    allowDelete: bool(env, "KEYLL_ALLOW_DELETE"),
    openaiBlock: openaiBlock === "recorded-scopes",

    // Provider credentials. Only the one for KEYLL_PROVIDER is read.
    project: env.GCP_PROJECT || env.GOOGLE_CLOUD_PROJECT || "",
    accessToken: env.GOOGLE_OAUTH_ACCESS_TOKEN || "",
    credentialsFile: env.GOOGLE_APPLICATION_CREDENTIALS || "",
    resendApiKey: provider === "resend" ? secret(env, "RESEND_API_KEY") : "",
    anthropicAdminKey: provider === "anthropic" ? secret(env, "ANTHROPIC_ADMIN_KEY") : "",
    openaiAdminKey: provider === "openai" ? secret(env, "OPENAI_ADMIN_KEY") : "",
    openrouterManagementKey: provider === "openrouter" ? secret(env, "OPENROUTER_MANAGEMENT_KEY") : "",

    // Milliseconds between calls to a provider's API. Unset: each provider's own default.
    requestGapMs: env.KEYLL_REQUEST_GAP_MS ? num(env, "KEYLL_REQUEST_GAP_MS", 0, { min: 0, max: 10_000 }) : null,
    endpoints: {
      monitoring: (env.KEYLL_GCP_MONITORING_URL || "https://monitoring.googleapis.com").replace(/\/+$/, ""),
      apikeys: (env.KEYLL_GCP_APIKEYS_URL || "https://apikeys.googleapis.com").replace(/\/+$/, ""),
      metadata: (env.KEYLL_GCP_METADATA_URL || "http://metadata.google.internal").replace(/\/+$/, ""),
      resend: (env.KEYLL_RESEND_API_URL || "https://api.resend.com").replace(/\/+$/, ""),
      anthropic: (env.KEYLL_ANTHROPIC_API_URL || "https://api.anthropic.com").replace(/\/+$/, ""),
      openai: (env.KEYLL_OPENAI_API_URL || "https://api.openai.com").replace(/\/+$/, ""),
      openrouter: (env.KEYLL_OPENROUTER_API_URL || "https://openrouter.ai/api").replace(/\/+$/, ""),
    },
  };
  if (provider === "resend" && !config.resendApiKey) throw new Error("Set RESEND_API_KEY (or RESEND_API_KEY_FILE) to a full-access Resend API key");
  if (provider === "anthropic" && !config.anthropicAdminKey) throw new Error("Set ANTHROPIC_ADMIN_KEY (or ANTHROPIC_ADMIN_KEY_FILE) to a Claude Console Admin API key");
  if (provider === "openai" && !config.openaiAdminKey) throw new Error("Set OPENAI_ADMIN_KEY (or OPENAI_ADMIN_KEY_FILE) to an OpenAI Admin API key");
  if (provider === "openrouter" && !config.openrouterManagementKey) throw new Error("Set OPENROUTER_MANAGEMENT_KEY (or OPENROUTER_MANAGEMENT_KEY_FILE) to an OpenRouter management key");
  return config;
}

/** The rails, as the heartbeat reports them to Keyll. */
export function railsSummary(config, blocksLastHour) {
  return {
    mode: config.mode,
    protectedKeys: config.protectedKeys,
    maxBlocksPerHour: config.maxBlocksPerHour,
    allowDestructive: config.allowDelete,
    blocksLastHour,
  };
}
