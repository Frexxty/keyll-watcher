import { createAnthropicProvider } from "./anthropic.mjs";
import { createGcpProvider } from "./gcp.mjs";
import { createOpenAIProvider } from "./openai.mjs";
import { createOpenRouterProvider } from "./openrouter.mjs";
import { createResendProvider } from "./resend.mjs";

/** The provider named by KEYLL_PROVIDER. */
export function createProvider(config) {
  if (config.provider === "resend") return createResendProvider(config);
  if (config.provider === "anthropic") return createAnthropicProvider(config);
  if (config.provider === "openai") return createOpenAIProvider(config);
  if (config.provider === "openrouter") return createOpenRouterProvider(config);
  return createGcpProvider(config);
}
