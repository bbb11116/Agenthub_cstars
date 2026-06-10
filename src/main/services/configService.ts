import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { loadGlobalSettings, resolveProviderApiKey } from "../config/agenthub-config-loader";
import type { ResolvedConfig } from "../config/agenthub-config-schema";
import { buildResolvedConfig } from "../config/agenthub-config-merge";
import {
  loadGlobalSettings as loadGlobal,
  loadWorkspaceSettings,
  loadWorkspaceLocalSettings
} from "../config/agenthub-config-loader";
import {
  createModelProviderLimits,
  normalizeModelProviderLimits,
  normalizeProviderCapabilities,
  type ModelProviderApiFormat,
  type ModelProviderLimits,
  type ProviderCapabilityStatus
} from "../../shared/modelProvider";

export type MainAgentModelProvider = ModelProviderApiFormat;

export type MainAgentModelConfig = {
  providerId?: string;
  provider: MainAgentModelProvider;
  baseUrl: string;
  apiKey: string;
  model: string;
  isFullUrl?: boolean;
  supportsStreaming?: boolean;
  toolCalling?: ProviderCapabilityStatus;
  limits: ModelProviderLimits;
};

const LEGACY_CONFIG_FILE = path.join(os.homedir(), ".agenthub", "config.json");

const DEFAULT_CONFIGS: Record<MainAgentModelProvider, Omit<MainAgentModelConfig, "apiKey">> = {
  openai_chat_completions: {
    provider: "openai_chat_completions",
    baseUrl: "https://api.openai.com",
    model: "gpt-4o-mini",
    limits: createModelProviderLimits(false)
  },
  anthropic_messages: {
    provider: "anthropic_messages",
    baseUrl: "https://api.anthropic.com",
    model: "claude-sonnet-4-20250514",
    limits: createModelProviderLimits(false)
  }
};

function isValidProvider(value: unknown): value is MainAgentModelProvider {
  return value === "openai_chat_completions" || value === "anthropic_messages";
}

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigError";
  }
}

export function loadMainAgentConfig(rootPath?: string): MainAgentModelConfig {
  // Try new settings.json system first
  const globalSettings = loadGlobalSettings();
  const workspaceMainAgent = rootPath
    ? loadWorkspaceSettings(rootPath).mainAgent
    : undefined;
  if (globalSettings.modelProviders && globalSettings.modelProviders.length > 0) {
    // Find default by isDefaultForMainAgent flag first, then by defaults.mainAgentProviderId, then first provider
    let provider = workspaceMainAgent?.modelProviderId
      ? globalSettings.modelProviders.find((p) => p.id === workspaceMainAgent.modelProviderId)
      : undefined;
    if (!provider) {
      provider = globalSettings.modelProviders.find((p) => p.isDefaultForMainAgent);
    }
    if (!provider) {
      const providerId = globalSettings.defaults?.mainAgentProviderId;
      provider = providerId
        ? globalSettings.modelProviders.find((p) => p.id === providerId)
        : undefined;
    }
    if (!provider) {
      provider = globalSettings.modelProviders[0];
    }

    const apiKey = resolveProviderApiKey(provider.id, globalSettings.modelProviders);
    if (!apiKey) {
      throw new ConfigError(
        `API key not found for provider '${provider.id}'. ` +
        `Set it via apiKeyRef in settings.json or environment variable.`
      );
    }

    const providerType = provider.apiFormat as MainAgentModelProvider;
    const defaults = DEFAULT_CONFIGS[providerType] ?? DEFAULT_CONFIGS.openai_chat_completions;
    const capabilities = normalizeProviderCapabilities(provider.capabilities, {
      supportsVision: provider.supportsVision,
      supportsStreaming: provider.supportsStreaming,
      limits: provider.limits
    });

    return {
      providerId: provider.id,
      provider: providerType,
      baseUrl: provider.baseUrl || defaults.baseUrl,
      apiKey,
      model: workspaceMainAgent?.model || provider.model || defaults.model,
      isFullUrl: provider.isFullUrl,
      supportsStreaming:
        capabilities.streaming === "unsupported"
          ? false
          : provider.supportsStreaming,
      toolCalling: capabilities.toolCalling,
      limits: normalizeModelProviderLimits(provider.limits)
    };
  }

  // Fall back to legacy config.json
  if (!fs.existsSync(LEGACY_CONFIG_FILE)) {
    throw new ConfigError(
      `Model config not found. Please configure a model provider in Settings.`
    );
  }

  let raw: unknown;
  try {
    const content = fs.readFileSync(LEGACY_CONFIG_FILE, "utf-8");
    raw = JSON.parse(content);
  } catch (error) {
    throw new ConfigError(
      `Failed to read config file: ${error instanceof Error ? error.message : "parse error"}`
    );
  }

  if (!raw || typeof raw !== "object" || !("mainAgent" in raw)) {
    throw new ConfigError('Config file missing "mainAgent" key.');
  }

  const mainAgent = (raw as Record<string, unknown>).mainAgent;
  if (!mainAgent || typeof mainAgent !== "object") {
    throw new ConfigError('"mainAgent" must be an object.');
  }

  const config = mainAgent as Record<string, unknown>;

  // Map legacy provider names
  let provider: MainAgentModelProvider;
  if (config.provider === "openai_compatible") {
    provider = "openai_chat_completions";
  } else if (config.provider === "anthropic_compatible") {
    provider = "anthropic_messages";
  } else if (isValidProvider(config.provider)) {
    provider = config.provider;
  } else {
    throw new ConfigError(
      `"mainAgent.provider" must be "openai_chat_completions" or "anthropic_messages", got: ${String(config.provider)}`
    );
  }

  if (typeof config.apiKey !== "string" || config.apiKey.trim().length === 0) {
    throw new ConfigError('"mainAgent.apiKey" is required.');
  }

  const defaults = DEFAULT_CONFIGS[provider];

  return {
    providerId: `legacy-${provider}`,
    provider,
    baseUrl: typeof config.baseUrl === "string" && config.baseUrl.trim().length > 0
      ? config.baseUrl.trim()
      : defaults.baseUrl,
    apiKey: config.apiKey.trim(),
    model: typeof config.model === "string" && config.model.trim().length > 0
      ? config.model.trim()
      : defaults.model,
    supportsStreaming: false,
    toolCalling: "unknown",
    limits: createModelProviderLimits(false)
  };
}

// Cache for resolved configs per workspace
const configCache = new Map<string, ResolvedConfig>();

export function getResolvedConfig(rootPath: string): ResolvedConfig {
  const cached = configCache.get(rootPath);
  if (cached) return cached;

  const global = loadGlobal();
  const workspace = loadWorkspaceSettings(rootPath);
  const local = loadWorkspaceLocalSettings(rootPath);
  const resolved = buildResolvedConfig(global, workspace, local);

  configCache.set(rootPath, resolved);
  return resolved;
}

export function clearConfigCache(rootPath?: string): void {
  if (rootPath) {
    configCache.delete(rootPath);
  } else {
    configCache.clear();
  }
}
