import type { MainAgentModelConfig } from "./configService";
import {
  ONE_MILLION_CONTEXT_WINDOW_TOKENS,
  normalizeModelProviderLimits,
  resolveEffectiveMaxOutputTokens,
  type ContextBudgetStatus,
  type ContextUsage,
  type ContextUsageLevel
} from "../../shared/modelProvider";
import {
  parseSseFrames,
  type LlmStreamEvent,
  type LlmTokenUsage,
  type SseFrame
} from "./sseParser";
import {
  buildTokenFields,
  getLLMProviderAdapter,
  type ChatMessage,
  type LLMToolCall,
  type LLMToolDefinition,
  type RequestBodyTokenFields
} from "./llmProviderAdapters";
import { estimateTokens } from "./tokenEstimator";

export type { LlmStreamEvent } from "./sseParser";

const REQUEST_TIMEOUT_MS = 300_000;
const STREAM_IDLE_TIMEOUT_MS = 120_000;
const DEFAULT_MAX_CONTINUATION_ATTEMPTS = 3;
const DEFAULT_CONTINUATION_PROMPT = [
  "继续上一条回答，直接从中断处接着写。",
  "不要重复已经输出的内容。",
  "如果上一条内容是 JSON、Markdown、代码块或表格，保持原格式并补齐剩余内容。",
  "只输出续写内容。"
].join("\n");

export type LlmCallTelemetry = {
  providerId: string;
  apiFormat: MainAgentModelConfig["provider"];
  model: string;
  stream: boolean;
  requestBody: {
    max_completion_tokens?: number;
    max_tokens?: number;
  };
  effectiveMaxOutputTokens: number;
  finishReason: string | null;
  stopReason: string | null;
  promptTokens: number | null;
  completionTokens: number | null;
  totalTokens: number | null;
  outputTruncated: boolean;
  timeoutTriggered: boolean;
  streamError?: string;
};

export class LLMError extends Error {
  telemetry?: LlmCallTelemetry;
  constructor(message: string, telemetry?: LlmCallTelemetry) {
    super(message);
    this.name = "LLMError";
    if (telemetry) {
      this.telemetry = telemetry;
    }
  }
}

export type LLMContextExtras = {
  developerPrompt?: string;
  toolDefinitions?: unknown;
  toolResults?: unknown;
  workspaceContext?: unknown;
};

export type LLMContinuationOptions = {
  maxContinuationAttempts?: number;
  continuationPrompt?: string;
};

export type LLMToolSupportResponse = {
  text: string;
  toolCalls: LLMToolCall[];
};

type LlmCallDiagnostics = {
  providerId: string;
  model: string;
  apiFormat: MainAgentModelConfig["provider"];
  requestedMaxOutputTokens: number;
  effectiveMaxOutputTokens: number;
  estimatedInputTokens: number;
  finishReason: string | null;
  stopReason: string | null;
  promptTokens: number | null;
  completionTokens: number | null;
  totalTokens: number | null;
  stream: boolean;
  rawResponseComplete: boolean;
  outputTruncated: boolean;
  streamError?: string;
  requestBody: RequestBodyTokenFields;
  timeoutTriggered: boolean;
};

function getContextBudgetStatus(contextRatio: number): ContextBudgetStatus {
  if (contextRatio >= 1) {
    return "overflow";
  }
  if (contextRatio >= 0.95) {
    return "danger";
  }
  if (contextRatio >= 0.8) {
    return "warning";
  }
  return "normal";
}

function getLegacyContextUsageLevel(status: ContextBudgetStatus): ContextUsageLevel {
  return status === "overflow" ? "over_limit" : status;
}

function createDiagnostics(
  config: MainAgentModelConfig,
  usage: ContextUsage,
  stream: boolean
): LlmCallDiagnostics {
  const budget = resolveEffectiveMaxOutputTokens(config.limits);
  const adapter = getLLMProviderAdapter(config.provider);
  return {
    providerId: config.providerId ?? "unknown",
    model: config.model,
    apiFormat: config.provider,
    requestedMaxOutputTokens: budget.requestedMaxOutputTokens,
    effectiveMaxOutputTokens: budget.effectiveMaxOutputTokens,
    estimatedInputTokens: usage.inputTokens,
    finishReason: null,
    stopReason: null,
    promptTokens: null,
    completionTokens: null,
    totalTokens: null,
    stream,
    rawResponseComplete: false,
    outputTruncated: false,
    requestBody: buildTokenFields(adapter, budget.effectiveMaxOutputTokens),
    timeoutTriggered: false
  };
}

export function diagnosticsToTelemetry(diagnostics: LlmCallDiagnostics): LlmCallTelemetry {
  return {
    providerId: diagnostics.providerId,
    apiFormat: diagnostics.apiFormat,
    model: diagnostics.model,
    stream: diagnostics.stream,
    requestBody: { ...diagnostics.requestBody },
    effectiveMaxOutputTokens: diagnostics.effectiveMaxOutputTokens,
    finishReason: diagnostics.finishReason,
    stopReason: diagnostics.stopReason,
    promptTokens: diagnostics.promptTokens,
    completionTokens: diagnostics.completionTokens,
    totalTokens: diagnostics.totalTokens,
    outputTruncated: diagnostics.outputTruncated,
    timeoutTriggered: diagnostics.timeoutTriggered,
    ...(diagnostics.streamError ? { streamError: diagnostics.streamError } : {})
  };
}

function applyTokenUsage(
  diagnostics: LlmCallDiagnostics,
  usage: LlmTokenUsage | undefined
): void {
  if (!usage) {
    return;
  }
  if (typeof usage.promptTokens === "number") {
    diagnostics.promptTokens = usage.promptTokens;
  }
  if (typeof usage.completionTokens === "number") {
    diagnostics.completionTokens = usage.completionTokens;
  }
  if (typeof usage.totalTokens === "number") {
    diagnostics.totalTokens = usage.totalTokens;
  } else if (
    typeof diagnostics.promptTokens === "number" &&
    typeof diagnostics.completionTokens === "number"
  ) {
    diagnostics.totalTokens = diagnostics.promptTokens + diagnostics.completionTokens;
  }
}

function finalizeDiagnostics(diagnostics: LlmCallDiagnostics): void {
  diagnostics.outputTruncated =
    diagnostics.finishReason === "length" ||
    diagnostics.stopReason === "max_tokens" ||
    diagnostics.timeoutTriggered ||
    (
      typeof diagnostics.completionTokens === "number" &&
      (
        diagnostics.completionTokens >= diagnostics.requestedMaxOutputTokens * 0.98 ||
        diagnostics.completionTokens >= diagnostics.effectiveMaxOutputTokens * 0.98
      )
    );
}

function logModelCallDiagnostics(diagnostics: LlmCallDiagnostics): void {
  console.info("[AgentHub] LLM call diagnostics", diagnostics);
}

function logOutgoingRequest(diagnostics: LlmCallDiagnostics): void {
  console.info("[AgentHub] LLM outgoing request", {
    providerId: diagnostics.providerId,
    model: diagnostics.model,
    apiFormat: diagnostics.apiFormat,
    effectiveMaxOutputTokens: diagnostics.effectiveMaxOutputTokens,
    "requestBody.max_completion_tokens": diagnostics.requestBody.max_completion_tokens,
    "requestBody.max_tokens": diagnostics.requestBody.max_tokens,
    stream: diagnostics.stream
  });
}

function getTruncationMessage(diagnostics: LlmCallDiagnostics): string {
  const reason = diagnostics.finishReason ?? diagnostics.stopReason ?? "token budget reached";
  return `Model output was truncated before completion (${reason}).`;
}

function getEventUsage(diagnostics: LlmCallDiagnostics): LlmTokenUsage | undefined {
  const usage: LlmTokenUsage = {
    ...(typeof diagnostics.promptTokens === "number"
      ? { promptTokens: diagnostics.promptTokens }
      : {}),
    ...(typeof diagnostics.completionTokens === "number"
      ? { completionTokens: diagnostics.completionTokens }
      : {}),
    ...(typeof diagnostics.totalTokens === "number"
      ? { totalTokens: diagnostics.totalTokens }
      : {})
  };

  return Object.values(usage).some((item) => typeof item === "number")
    ? usage
    : undefined;
}

export function estimateInputTokens(value: unknown): number {
  const serialized = typeof value === "string" ? value : JSON.stringify(value) ?? String(value);
  return estimateTokens(serialized);
}

export function calculateContextUsage(
  config: MainAgentModelConfig,
  systemPrompt: string,
  messages: ChatMessage[],
  extras: LLMContextExtras = {}
): ContextUsage {
  const limits = normalizeModelProviderLimits(config.limits);
  const requestedOutputTokens = resolveEffectiveMaxOutputTokens(limits).effectiveMaxOutputTokens;
  const inputTokens = estimateInputTokens({
    systemPrompt,
    developerPrompt: extras.developerPrompt ?? "",
    messages,
    toolDefinitions: extras.toolDefinitions ?? [],
    toolResults: extras.toolResults ?? [],
    workspaceContext: extras.workspaceContext ?? {}
  });
  const totalRequestedTokens = inputTokens + requestedOutputTokens;
  const utilizationRatio = totalRequestedTokens / limits.contextWindowTokens;
  const status = getContextBudgetStatus(utilizationRatio);

  return {
    inputTokens,
    reservedOutputTokens: requestedOutputTokens,
    requestedOutputTokens,
    contextWindowTokens: limits.contextWindowTokens,
    totalRequestedTokens,
    contextRatio: utilizationRatio,
    utilizationRatio,
    contextPercent: utilizationRatio * 100,
    status,
    level: getLegacyContextUsageLevel(status)
  };
}

function assertContextWithinBudget(usage: ContextUsage): void {
  if (usage.level !== "over_limit") {
    return;
  }

  if (usage.contextWindowTokens >= ONE_MILLION_CONTEXT_WINDOW_TOKENS) {
    throw new LLMError("当前上下文已超过 1M tokens 配置上限，请压缩上下文或新建会话。");
  }

  throw new LLMError(
    "当前上下文已超过模型配置的上下文窗口限制。请压缩上下文、减少文件内容、清理终端输出，或在模型配置中启用 1M 上下文。"
  );
}

function resolveUrl(config: MainAgentModelConfig, suffix: string): string {
  if (config.isFullUrl) {
    return config.baseUrl;
  }
  const base = config.baseUrl.replace(/\/+$/, "");
  if (base.endsWith("/v1")) {
    return `${base}${suffix}`;
  }
  return `${base}/v1${suffix}`;
}

type AbortableTimer = {
  reset: () => void;
  clear: () => void;
};

function createAbortableTimer(
  controller: AbortController,
  ms: number,
  diagnostics: LlmCallDiagnostics
): AbortableTimer {
  let handle: ReturnType<typeof setTimeout> | null = setTimeout(() => {
    diagnostics.timeoutTriggered = true;
    controller.abort();
  }, ms);
  return {
    reset: () => {
      if (handle !== null) {
        clearTimeout(handle);
      }
      handle = setTimeout(() => {
        diagnostics.timeoutTriggered = true;
        controller.abort();
      }, ms);
    },
    clear: () => {
      if (handle !== null) {
        clearTimeout(handle);
        handle = null;
      }
    }
  };
}

async function callProviderCompatible(
  config: MainAgentModelConfig,
  systemPrompt: string,
  messages: ChatMessage[],
  usage: ContextUsage
): Promise<string> {
  const adapter = getLLMProviderAdapter(config.provider);
  const url = resolveUrl(config, adapter.endpointSuffix);
  const diagnostics = createDiagnostics(config, usage, false);
  const body = adapter.buildRequestBody({
    config,
    systemPrompt,
    messages,
    tokenFields: diagnostics.requestBody,
    stream: false
  });

  logOutgoingRequest(diagnostics);

  const controller = new AbortController();
  const timer = createAbortableTimer(controller, REQUEST_TIMEOUT_MS, diagnostics);

  try {
    const response = await fetch(url, {
      method: "POST",
      headers: adapter.buildHeaders(config),
      body: JSON.stringify(body),
      signal: controller.signal
    });

    if (!response.ok) {
      const errorText = await response.text().catch(() => "");
      throw new LLMError(
        `${adapter.label} API error ${response.status}: ${errorText.slice(0, 500)}`,
        diagnosticsToTelemetry(diagnostics)
      );
    }

    const data = await response.json() as unknown;
    const metadata = adapter.readResponseMetadata(data);

    diagnostics.rawResponseComplete = true;
    diagnostics.finishReason = metadata.finishReason ?? null;
    diagnostics.stopReason = metadata.stopReason ?? null;
    applyTokenUsage(diagnostics, metadata.usage);
    finalizeDiagnostics(diagnostics);

    const content = adapter.readResponseText(data);
    if (!content || content.trim().length === 0) {
      throw new LLMError(
        `${adapter.label} API returned empty response.`,
        diagnosticsToTelemetry(diagnostics)
      );
    }
    if (diagnostics.outputTruncated) {
      throw new LLMError(
        getTruncationMessage(diagnostics),
        diagnosticsToTelemetry(diagnostics)
      );
    }

    return content;
  } catch (error) {
    if (error instanceof LLMError) {
      throw error;
    }
    if (error instanceof Error && error.name === "AbortError") {
      throw new LLMError(
        `${adapter.label} API request timed out after ${REQUEST_TIMEOUT_MS / 1000}s.`,
        diagnosticsToTelemetry(diagnostics)
      );
    }
    const causeCode = (error as { cause?: { code?: string } })?.cause?.code;
    console.error(`[llmRouter] ${adapter.label} fetch failed:`, {
      message: error instanceof Error ? error.message : "unknown error",
      causeCode,
      cause: (error as { cause?: unknown })?.cause
    });
    throw new LLMError(
      `${adapter.label} API request failed: ${error instanceof Error ? error.message : "unknown error"}${causeCode ? ` (cause: ${causeCode})` : ""}`,
      diagnosticsToTelemetry(diagnostics)
    );
  } finally {
    finalizeDiagnostics(diagnostics);
    logModelCallDiagnostics(diagnostics);
    timer.clear();
  }
}

async function callProviderCompatibleWithTools(
  config: MainAgentModelConfig,
  systemPrompt: string,
  messages: ChatMessage[],
  tools: LLMToolDefinition[],
  usage: ContextUsage
): Promise<LLMToolSupportResponse> {
  const adapter = getLLMProviderAdapter(config.provider);
  const url = resolveUrl(config, adapter.endpointSuffix);
  const diagnostics = createDiagnostics(config, usage, false);
  const body = adapter.buildRequestBody({
    config,
    systemPrompt,
    messages,
    tokenFields: diagnostics.requestBody,
    stream: false,
    tools
  });

  logOutgoingRequest(diagnostics);

  const controller = new AbortController();
  const timer = createAbortableTimer(controller, REQUEST_TIMEOUT_MS, diagnostics);

  try {
    const response = await fetch(url, {
      method: "POST",
      headers: adapter.buildHeaders(config),
      body: JSON.stringify(body),
      signal: controller.signal
    });

    if (!response.ok) {
      const errorText = await response.text().catch(() => "");
      throw new LLMError(
        `${adapter.label} API error ${response.status}: ${errorText.slice(0, 500)}`,
        diagnosticsToTelemetry(diagnostics)
      );
    }

    const data = await response.json() as unknown;
    const metadata = adapter.readResponseMetadata(data);

    diagnostics.rawResponseComplete = true;
    diagnostics.finishReason = metadata.finishReason ?? null;
    diagnostics.stopReason = metadata.stopReason ?? null;
    applyTokenUsage(diagnostics, metadata.usage);
    finalizeDiagnostics(diagnostics);

    const content = adapter.readResponseText(data) ?? "";
    const toolCalls = adapter.readToolCalls(data);
    if (content.trim().length === 0 && toolCalls.length === 0) {
      throw new LLMError(
        `${adapter.label} API returned empty response.`,
        diagnosticsToTelemetry(diagnostics)
      );
    }
    if (diagnostics.outputTruncated) {
      throw new LLMError(
        getTruncationMessage(diagnostics),
        diagnosticsToTelemetry(diagnostics)
      );
    }

    return { text: content, toolCalls };
  } catch (error) {
    if (error instanceof LLMError) {
      throw error;
    }
    if (error instanceof Error && error.name === "AbortError") {
      throw new LLMError(
        `${adapter.label} API request timed out after ${REQUEST_TIMEOUT_MS / 1000}s.`,
        diagnosticsToTelemetry(diagnostics)
      );
    }
    const causeCode = (error as { cause?: { code?: string } })?.cause?.code;
    console.error(`[llmRouter] ${adapter.label} fetch failed:`, {
      message: error instanceof Error ? error.message : "unknown error",
      causeCode,
      cause: (error as { cause?: unknown })?.cause
    });
    throw new LLMError(
      `${adapter.label} API request failed: ${error instanceof Error ? error.message : "unknown error"}${causeCode ? ` (cause: ${causeCode})` : ""}`,
      diagnosticsToTelemetry(diagnostics)
    );
  } finally {
    finalizeDiagnostics(diagnostics);
    logModelCallDiagnostics(diagnostics);
    timer.clear();
  }
}

async function* readSseEvents(
  response: Response,
  parseFrame: (frame: SseFrame) => LlmStreamEvent | null,
  onChunkReceived?: () => void
): AsyncIterable<LlmStreamEvent> {
  if (!response.body) {
    throw new LLMError("Model stream response body is unavailable.");
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let remaining = "";
  let reachedTerminalEvent = false;

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (!done && value && value.byteLength > 0) {
        onChunkReceived?.();
      }
      const parsed = parseSseFrames(
        remaining,
        done ? decoder.decode() : decoder.decode(value, { stream: true }),
        done
      );
      remaining = parsed.remaining;

      for (const frame of parsed.frames) {
        const event = parseFrame(frame);
        if (!event) {
          continue;
        }

        yield event;
        if (event.type === "done" || event.type === "error") {
          reachedTerminalEvent = true;
        }
      }

      if (done) {
        break;
      }
    }
  } finally {
    reader.releaseLock();
  }

  if (!reachedTerminalEvent) {
    yield { type: "done" };
  }
}

async function* callProviderCompatibleStream(
  config: MainAgentModelConfig,
  systemPrompt: string,
  messages: ChatMessage[],
  usage: ContextUsage
): AsyncIterable<LlmStreamEvent> {
  const adapter = getLLMProviderAdapter(config.provider);
  const url = resolveUrl(config, adapter.endpointSuffix);
  const diagnostics = createDiagnostics(config, usage, true);
  const controller = new AbortController();
  const timer = createAbortableTimer(controller, STREAM_IDLE_TIMEOUT_MS, diagnostics);
  const body = adapter.buildRequestBody({
    config,
    systemPrompt,
    messages,
    tokenFields: diagnostics.requestBody,
    stream: true
  });

  logOutgoingRequest(diagnostics);

  try {
    const response = await fetch(url, {
      method: "POST",
      headers: adapter.buildHeaders(config),
      body: JSON.stringify(body),
      signal: controller.signal
    });

    if (!response.ok) {
      const errorText = await response.text().catch(() => "");
      throw new LLMError(
        `${adapter.label} API error ${response.status}: ${errorText.slice(0, 500)}`,
        diagnosticsToTelemetry(diagnostics)
      );
    }

    for await (const event of readSseEvents(
      response,
      adapter.parseStreamFrame,
      () => timer.reset()
    )) {
      if (event.type === "text_delta") {
        diagnostics.finishReason = event.finishReason ?? diagnostics.finishReason;
        diagnostics.stopReason = event.stopReason ?? diagnostics.stopReason;
        applyTokenUsage(diagnostics, event.usage);
        yield { type: "text_delta", text: event.text };
      } else if (event.type === "reasoning_delta") {
        diagnostics.finishReason = event.finishReason ?? diagnostics.finishReason;
        diagnostics.stopReason = event.stopReason ?? diagnostics.stopReason;
        applyTokenUsage(diagnostics, event.usage);
        yield { type: "reasoning_delta", text: event.text };
      } else if (event.type === "response_metadata") {
        diagnostics.finishReason = event.finishReason ?? diagnostics.finishReason;
        diagnostics.stopReason = event.stopReason ?? diagnostics.stopReason;
        applyTokenUsage(diagnostics, event.usage);
      } else if (event.type === "done") {
        diagnostics.finishReason = event.finishReason ?? diagnostics.finishReason;
        diagnostics.stopReason = event.stopReason ?? diagnostics.stopReason;
        applyTokenUsage(diagnostics, event.usage);
      } else {
        diagnostics.streamError = event.message;
        console.warn("[AgentHub] LLM stream error", {
          providerId: diagnostics.providerId,
          model: diagnostics.model,
          apiFormat: diagnostics.apiFormat,
          streamError: event.message
        });
        yield event;
      }
    }

    diagnostics.rawResponseComplete = true;
    finalizeDiagnostics(diagnostics);
    if (diagnostics.streamError) {
      return;
    }
    yield {
      type: "done",
      ...(diagnostics.finishReason ? { finishReason: diagnostics.finishReason } : {}),
      ...(diagnostics.stopReason ? { stopReason: diagnostics.stopReason } : {}),
      ...(getEventUsage(diagnostics) ? { usage: getEventUsage(diagnostics) } : {}),
      ...(diagnostics.outputTruncated ? { outputTruncated: true } : {})
    };
  } catch (error) {
    diagnostics.streamError = error instanceof Error ? error.message : "unknown error";
    if (error instanceof LLMError) {
      throw error;
    }
    if (error instanceof Error && error.name === "AbortError") {
      const reason = diagnostics.timeoutTriggered
        ? `${adapter.label} API stream idle for more than ${STREAM_IDLE_TIMEOUT_MS / 1000}s.`
        : `${adapter.label} API stream aborted.`;
      throw new LLMError(reason, diagnosticsToTelemetry(diagnostics));
    }
    const causeCode = (error as { cause?: { code?: string } })?.cause?.code;
    console.error(`[llmRouter] ${adapter.label} fetch failed:`, {
      message: error instanceof Error ? error.message : "unknown error",
      causeCode,
      cause: (error as { cause?: unknown })?.cause
    });
    throw new LLMError(
      `${adapter.label} API request failed: ${error instanceof Error ? error.message : "unknown error"}${causeCode ? ` (cause: ${causeCode})` : ""}`,
      diagnosticsToTelemetry(diagnostics)
    );
  } finally {
    finalizeDiagnostics(diagnostics);
    logModelCallDiagnostics(diagnostics);
    timer.clear();
  }
}

export async function callLLM(
  config: MainAgentModelConfig,
  systemPrompt: string,
  messages: ChatMessage[],
  extras: LLMContextExtras = {}
): Promise<string> {
  const usage = calculateContextUsage(config, systemPrompt, messages, extras);
  assertContextWithinBudget(usage);

  return callProviderCompatible(config, systemPrompt, messages, usage);
}

export async function callLLMWithToolSupport(
  config: MainAgentModelConfig,
  systemPrompt: string,
  messages: ChatMessage[],
  tools: LLMToolDefinition[],
  extras: LLMContextExtras = {}
): Promise<LLMToolSupportResponse> {
  const usage = calculateContextUsage(config, systemPrompt, messages, {
    ...extras,
    toolDefinitions: tools
  });
  assertContextWithinBudget(usage);

  return callProviderCompatibleWithTools(config, systemPrompt, messages, tools, usage);
}

export async function* callLLMStream(
  config: MainAgentModelConfig,
  systemPrompt: string,
  messages: ChatMessage[],
  extras: LLMContextExtras = {}
): AsyncIterable<LlmStreamEvent> {
  const usage = calculateContextUsage(config, systemPrompt, messages, extras);
  assertContextWithinBudget(usage);

  yield* callProviderCompatibleStream(config, systemPrompt, messages, usage);
}

function getContinuationMessages(
  messages: ChatMessage[],
  accumulatedText: string,
  continuationPrompt: string,
  attempt: number,
  maxAttempts: number
): ChatMessage[] {
  return [
    ...messages,
    {
      role: "assistant",
      content: accumulatedText
    },
    {
      role: "user",
      content: [
        continuationPrompt,
        "",
        `续写轮次: ${attempt}/${maxAttempts}`
      ].join("\n")
    }
  ];
}

export async function* callLLMStreamWithContinuation(
  config: MainAgentModelConfig,
  systemPrompt: string,
  messages: ChatMessage[],
  extras: LLMContextExtras = {},
  options: LLMContinuationOptions = {}
): AsyncIterable<LlmStreamEvent> {
  const maxAttempts =
    options.maxContinuationAttempts ?? DEFAULT_MAX_CONTINUATION_ATTEMPTS;
  const continuationPrompt =
    options.continuationPrompt ?? DEFAULT_CONTINUATION_PROMPT;
  const accumulated: string[] = [];
  let currentMessages = messages;
  let continuationAttempts = 0;

  while (true) {
    let sawDone = false;

    for await (const event of callLLMStream(
      config,
      systemPrompt,
      currentMessages,
      extras
    )) {
      if (event.type === "text_delta") {
        accumulated.push(event.text);
        yield event;
        continue;
      }

      if (event.type === "done") {
        sawDone = true;

        if (event.outputTruncated && continuationAttempts < maxAttempts) {
          continuationAttempts += 1;
          currentMessages = getContinuationMessages(
            messages,
            accumulated.join(""),
            continuationPrompt,
            continuationAttempts,
            maxAttempts
          );
          break;
        }

        yield event;
        return;
      }

      yield event;
      if (event.type === "error") {
        return;
      }
    }

    if (!sawDone) {
      return;
    }
  }
}

export async function callLLMWithContinuation(
  config: MainAgentModelConfig,
  systemPrompt: string,
  messages: ChatMessage[],
  extras: LLMContextExtras = {},
  options: LLMContinuationOptions = {}
): Promise<string> {
  if (!config.supportsStreaming) {
    return callLLM(config, systemPrompt, messages, extras);
  }

  let text = "";
  let truncated = false;
  let truncationReason = "token budget reached";

  for await (const event of callLLMStreamWithContinuation(
    config,
    systemPrompt,
    messages,
    extras,
    options
  )) {
    if (event.type === "text_delta") {
      text += event.text;
    } else if (event.type === "error") {
      throw new LLMError(event.message);
    } else if (event.type === "done" && event.outputTruncated) {
      truncated = true;
      truncationReason = event.finishReason ?? event.stopReason ?? truncationReason;
    }
  }

  if (!text.trim()) {
    throw new LLMError("Model returned empty response.");
  }

  if (truncated) {
    throw new LLMError(
      `Model output was truncated before completion (${truncationReason}).`
    );
  }

  return text;
}
