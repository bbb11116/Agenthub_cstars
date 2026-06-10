import type { Agent } from "../../shared/domain";
import type { ResolvedConfig, ModelProviderConfig } from "./agenthub-config-schema";
import { resolveApiKey } from "./secret-resolver";

const SAFE_WORKSPACE_ENV_OVERRIDES = new Set([
  "ANTHROPIC_BASE_URL",
  "ANTHROPIC_MODEL",
  "OPENAI_BASE_URL",
  "OPENAI_MODEL"
]);

function findProviderForAgent(
  agent: Agent,
  config: ResolvedConfig
): ModelProviderConfig | undefined {
  // Try modelProviderId first
  if (agent.modelProviderId) {
    const found = config.merged.modelProviders.find((p) => p.id === agent.modelProviderId);
    if (found) return found;
  }

  // Try matching by runtime provider type
  const providerType = agent.runtimeProvider;
  if (providerType === "claude_code") {
    return config.merged.modelProviders.find((p) => p.apiFormat === "anthropic_messages");
  }
  if (providerType === "codex_local" || providerType === "opencode") {
    return config.merged.modelProviders.find((p) => p.apiFormat === "openai_chat_completions");
  }

  return undefined;
}

export function resolveProviderEnv(
  agent: Agent,
  config: ResolvedConfig
): Record<string, string> | undefined {
  // Builtin providers use llmRouter directly, no env needed
  if (agent.runtimeProvider === "builtin_openai" || agent.runtimeProvider === "builtin_anthropic") {
    return undefined;
  }

  const provider = findProviderForAgent(agent, config);
  if (!provider) return undefined;

  const apiKey = resolveApiKey(provider.apiKeyRef, provider.id);
  if (!apiKey) return undefined;

  const model = agent.model ?? provider.model;
  const env: Record<string, string> = {};

  if (agent.runtimeProvider === "claude_code" || provider.apiFormat === "anthropic_messages") {
    if (provider.baseUrl) env.ANTHROPIC_BASE_URL = provider.baseUrl;
    env.ANTHROPIC_AUTH_TOKEN = apiKey;
    if (model) env.ANTHROPIC_MODEL = model;
  }

  if (agent.runtimeProvider === "codex_local" || agent.runtimeProvider === "opencode" || provider.apiFormat === "openai_chat_completions") {
    if (provider.baseUrl) env.OPENAI_BASE_URL = provider.baseUrl;
    env.OPENAI_API_KEY = apiKey;
    if (model) env.OPENAI_MODEL = model;
  }

  // Apply workspace-local env overrides
  const providerEnvOverrides = config.local.providerEnvOverrides;
  if (providerEnvOverrides) {
    const overrides = providerEnvOverrides[agent.runtimeProvider];
    if (overrides) {
      for (const [key, value] of Object.entries(overrides)) {
        if (SAFE_WORKSPACE_ENV_OVERRIDES.has(key) && typeof value === "string") {
          env[key] = value;
        }
      }
    }
  }

  return Object.keys(env).length > 0 ? env : undefined;
}
