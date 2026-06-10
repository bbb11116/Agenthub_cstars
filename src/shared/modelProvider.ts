export const DEFAULT_CONTEXT_WINDOW_TOKENS = 262_144;
export const ONE_MILLION_CONTEXT_WINDOW_TOKENS = 1_048_576;
export const DEFAULT_MAX_OUTPUT_TOKENS = 65_536;
export const DEFAULT_HARD_MAX_OUTPUT_TOKENS = 128_000;

export type ModelProviderApiFormat = "openai_chat_completions" | "anthropic_messages";

export type ModelProviderLimits = {
  contextWindowTokens: number;
  maxOutputTokens: number;
  hardMaxOutputTokens?: number;
  source: "default_256k" | "user_enabled_1m";
};

export type ProviderCapabilityStatus = "supported" | "unsupported" | "unknown";

export type ProviderCapabilities = {
  chat: ProviderCapabilityStatus;
  streaming: ProviderCapabilityStatus;
  vision: ProviderCapabilityStatus;
  toolCalling: ProviderCapabilityStatus;
  jsonMode: ProviderCapabilityStatus;
  contextWindowTokens: number;
  maxOutputTokens: number;
  source: "user_configured" | "connection_probe" | "default";
  detectedAt?: string;
  notes?: string[];
};

export type ContextBudgetStatus = "normal" | "warning" | "danger" | "overflow";
export type ContextUsageLevel = "normal" | "warning" | "danger" | "over_limit";

export type ContextUsage = {
  inputTokens: number;
  reservedOutputTokens: number;
  requestedOutputTokens: number;
  contextWindowTokens: number;
  totalRequestedTokens: number;
  contextRatio: number;
  utilizationRatio: number;
  contextPercent: number;
  status: ContextBudgetStatus;
  level: ContextUsageLevel;
};

export function createModelProviderLimits(
  enableOneMillionContext: boolean
): ModelProviderLimits {
  return enableOneMillionContext
    ? {
        contextWindowTokens: ONE_MILLION_CONTEXT_WINDOW_TOKENS,
        maxOutputTokens: DEFAULT_MAX_OUTPUT_TOKENS,
        source: "user_enabled_1m"
      }
    : {
        contextWindowTokens: DEFAULT_CONTEXT_WINDOW_TOKENS,
        maxOutputTokens: DEFAULT_MAX_OUTPUT_TOKENS,
        source: "default_256k"
      };
}

export function normalizeModelProviderLimits(
  value: Partial<ModelProviderLimits> | null | undefined
): ModelProviderLimits {
  if (
    value?.contextWindowTokens === ONE_MILLION_CONTEXT_WINDOW_TOKENS &&
    value.source === "user_enabled_1m"
  ) {
    return {
      ...createModelProviderLimits(true),
      ...(typeof value.maxOutputTokens === "number" && value.maxOutputTokens > 0
        ? { maxOutputTokens: value.maxOutputTokens }
        : {}),
      ...(typeof value.hardMaxOutputTokens === "number" && value.hardMaxOutputTokens > 0
        ? { hardMaxOutputTokens: value.hardMaxOutputTokens }
        : {})
    };
  }

  return {
    ...createModelProviderLimits(false),
    ...(typeof value?.maxOutputTokens === "number" && value.maxOutputTokens > 0
      ? { maxOutputTokens: value.maxOutputTokens }
      : {}),
    ...(typeof value?.hardMaxOutputTokens === "number" && value.hardMaxOutputTokens > 0
      ? { hardMaxOutputTokens: value.hardMaxOutputTokens }
      : {})
  };
}

export function createDefaultProviderCapabilities(input: {
  supportsVision?: boolean;
  supportsStreaming?: boolean;
  limits?: Partial<ModelProviderLimits> | null;
}): ProviderCapabilities {
  const limits = normalizeModelProviderLimits(input.limits);
  return {
    chat: "unknown",
    streaming: input.supportsStreaming === false ? "unsupported" : "unknown",
    vision: input.supportsVision ? "unknown" : "unsupported",
    toolCalling: "unknown",
    jsonMode: "unknown",
    contextWindowTokens: limits.contextWindowTokens,
    maxOutputTokens: limits.maxOutputTokens,
    source: "default"
  };
}

export function createConfiguredProviderCapabilities(input: {
  supportsVision: boolean;
  supportsStreaming: boolean;
  limits: Partial<ModelProviderLimits> | null | undefined;
}): ProviderCapabilities {
  const limits = normalizeModelProviderLimits(input.limits);
  return {
    chat: "unknown",
    streaming: input.supportsStreaming ? "unknown" : "unsupported",
    vision: input.supportsVision ? "unknown" : "unsupported",
    toolCalling: "unknown",
    jsonMode: "unknown",
    contextWindowTokens: limits.contextWindowTokens,
    maxOutputTokens: limits.maxOutputTokens,
    source: "user_configured"
  };
}

export function normalizeProviderCapabilities(
  value: Partial<ProviderCapabilities> | null | undefined,
  fallback: {
    supportsVision?: boolean;
    supportsStreaming?: boolean;
    limits?: Partial<ModelProviderLimits> | null;
  } = {}
): ProviderCapabilities {
  const defaults = createDefaultProviderCapabilities(fallback);
  const limits = normalizeModelProviderLimits(fallback.limits);
  const contextWindowTokens =
    typeof value?.contextWindowTokens === "number" && value.contextWindowTokens > 0
      ? value.contextWindowTokens
      : limits.contextWindowTokens;
  const maxOutputTokens =
    typeof value?.maxOutputTokens === "number" && value.maxOutputTokens > 0
      ? value.maxOutputTokens
      : limits.maxOutputTokens;

  return {
    ...defaults,
    ...value,
    contextWindowTokens,
    maxOutputTokens,
    source:
      value?.source === "connection_probe" || value?.source === "user_configured"
        ? value.source
        : defaults.source,
    ...(Array.isArray(value?.notes) ? { notes: value.notes } : {})
  };
}

export function resolveEffectiveMaxOutputTokens(
  limits: Partial<ModelProviderLimits> | null | undefined
): {
  requestedMaxOutputTokens: number;
  effectiveMaxOutputTokens: number;
  hardMaxOutputTokens: number;
} {
  const normalized = normalizeModelProviderLimits(limits);
  const hardMaxOutputTokens =
    typeof normalized.hardMaxOutputTokens === "number" && normalized.hardMaxOutputTokens > 0
      ? normalized.hardMaxOutputTokens
      : DEFAULT_HARD_MAX_OUTPUT_TOKENS;

  return {
    requestedMaxOutputTokens: normalized.maxOutputTokens,
    effectiveMaxOutputTokens: Math.min(normalized.maxOutputTokens, hardMaxOutputTokens),
    hardMaxOutputTokens
  };
}
