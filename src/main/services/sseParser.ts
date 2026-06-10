export type SseFrame = {
  event?: string;
  data: string;
};

export type SseParseResult = {
  frames: SseFrame[];
  remaining: string;
};

export type LlmTokenUsage = {
  promptTokens?: number;
  completionTokens?: number;
  totalTokens?: number;
};

export type LlmStreamEvent =
  | {
      type: "text_delta";
      text: string;
      finishReason?: string;
      stopReason?: string;
      usage?: LlmTokenUsage;
    }
  | {
      type: "reasoning_delta";
      text: string;
      finishReason?: string;
      stopReason?: string;
      usage?: LlmTokenUsage;
    }
  | {
      type: "response_metadata";
      finishReason?: string;
      stopReason?: string;
      usage?: LlmTokenUsage;
    }
  | {
      type: "done";
      usage?: LlmTokenUsage;
      finishReason?: string;
      stopReason?: string;
      rawResponseComplete?: boolean;
      outputTruncated?: boolean;
    }
  | { type: "error"; message: string };

function parseFrame(rawFrame: string): SseFrame | null {
  const dataLines: string[] = [];
  let event: string | undefined;

  for (const line of rawFrame.split(/\r?\n/)) {
    if (!line || line.startsWith(":")) {
      continue;
    }

    const separatorIndex = line.indexOf(":");
    const field = separatorIndex === -1 ? line : line.slice(0, separatorIndex);
    const rawValue = separatorIndex === -1 ? "" : line.slice(separatorIndex + 1);
    const value = rawValue.startsWith(" ") ? rawValue.slice(1) : rawValue;

    if (field === "event") {
      event = value;
    } else if (field === "data") {
      dataLines.push(value);
    }
  }

  if (dataLines.length === 0) {
    return null;
  }

  return {
    ...(event ? { event } : {}),
    data: dataLines.join("\n")
  };
}

export function parseSseFrames(
  buffer: string,
  chunk = "",
  flush = false
): SseParseResult {
  const combined = buffer + chunk;
  const frames: SseFrame[] = [];
  const separator = /\r?\n\r?\n/g;
  let consumedLength = 0;
  let match: RegExpExecArray | null;

  while ((match = separator.exec(combined)) !== null) {
    const frame = parseFrame(combined.slice(consumedLength, match.index));
    if (frame) {
      frames.push(frame);
    }
    consumedLength = match.index + match[0].length;
  }

  let remaining = combined.slice(consumedLength);
  if (flush && remaining.length > 0) {
    const frame = parseFrame(remaining);
    if (frame) {
      frames.push(frame);
    }
    remaining = "";
  }

  return { frames, remaining };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function getErrorMessage(payload: unknown, fallback: string): string {
  if (!isRecord(payload)) {
    return fallback;
  }

  const error = payload.error;
  if (typeof error === "string") {
    return error;
  }
  if (isRecord(error) && typeof error.message === "string") {
    return error.message;
  }
  if (typeof payload.message === "string") {
    return payload.message;
  }

  return fallback;
}

function parseJsonPayload(frame: SseFrame): unknown | LlmStreamEvent {
  try {
    return JSON.parse(frame.data) as unknown;
  } catch {
    return {
      type: "error",
      message: "Model stream returned an invalid SSE JSON payload."
    };
  }
}

function readNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function normalizeOpenAIUsage(value: unknown): LlmTokenUsage | undefined {
  if (!isRecord(value)) {
    return undefined;
  }

  const promptTokens = readNumber(value.prompt_tokens);
  const completionTokens = readNumber(value.completion_tokens);
  const totalTokens = readNumber(value.total_tokens);
  const usage: LlmTokenUsage = {
    ...(typeof promptTokens === "number" ? { promptTokens } : {}),
    ...(typeof completionTokens === "number" ? { completionTokens } : {}),
    ...(typeof totalTokens === "number" ? { totalTokens } : {})
  };

  return Object.values(usage).some((item) => typeof item === "number")
    ? usage
    : undefined;
}

function normalizeAnthropicUsage(value: unknown): LlmTokenUsage | undefined {
  if (!isRecord(value)) {
    return undefined;
  }

  const promptTokens = readNumber(value.input_tokens);
  const completionTokens = readNumber(value.output_tokens);
  const usage: LlmTokenUsage = {
    ...(typeof promptTokens === "number" ? { promptTokens } : {}),
    ...(typeof completionTokens === "number" ? { completionTokens } : {}),
    ...(typeof promptTokens === "number" && typeof completionTokens === "number"
      ? { totalTokens: promptTokens + completionTokens }
      : {})
  };

  return Object.values(usage).some((item) => typeof item === "number")
    ? usage
    : undefined;
}

export function parseOpenAIStreamFrame(frame: SseFrame): LlmStreamEvent | null {
  if (frame.data.trim() === "[DONE]") {
    return { type: "done" };
  }

  const payload = parseJsonPayload(frame);
  if (isRecord(payload) && payload.type === "error" && typeof payload.message === "string") {
    return payload as LlmStreamEvent;
  }
  if (!isRecord(payload)) {
    return null;
  }
  if ("error" in payload) {
    return {
      type: "error",
      message: getErrorMessage(payload, "OpenAI-compatible stream returned an error.")
    };
  }

  const choices = payload.choices;
  const usage = normalizeOpenAIUsage(payload.usage);
  if (!Array.isArray(choices) || !isRecord(choices[0])) {
    return usage ? { type: "response_metadata", usage } : null;
  }

  const finishReason = typeof choices[0].finish_reason === "string"
    ? choices[0].finish_reason
    : undefined;
  const eventBase = {
    ...(finishReason ? { finishReason } : {}),
    ...(usage ? { usage } : {})
  };
  const delta = choices[0].delta;
  if (!isRecord(delta)) {
    return finishReason || usage
      ? { type: "response_metadata", ...eventBase }
      : null;
  }

  const reasoningText = typeof delta.reasoning_content === "string"
    ? delta.reasoning_content
    : typeof delta.reasoning === "string"
      ? delta.reasoning
      : "";
  const contentText = typeof delta.content === "string" ? delta.content : "";

  if (reasoningText.length > 0) {
    return { type: "reasoning_delta", text: reasoningText, ...eventBase };
  }

  if (contentText.length === 0) {
    return finishReason || usage
      ? { type: "response_metadata", ...eventBase }
      : null;
  }

  return { type: "text_delta", text: contentText, ...eventBase };
}

export function parseAnthropicStreamFrame(frame: SseFrame): LlmStreamEvent | null {
  if (
    frame.event &&
    frame.event !== "message_start" &&
    frame.event !== "content_block_delta" &&
    frame.event !== "message_delta" &&
    frame.event !== "message_stop" &&
    frame.event !== "error"
  ) {
    return null;
  }

  const payload = parseJsonPayload(frame);
  if (isRecord(payload) && payload.type === "error" && typeof payload.message === "string") {
    return payload as LlmStreamEvent;
  }
  if (!isRecord(payload)) {
    return null;
  }

  const eventType = frame.event ?? (typeof payload.type === "string" ? payload.type : "");
  if (eventType === "error") {
    return {
      type: "error",
      message: getErrorMessage(payload, "Anthropic-compatible stream returned an error.")
    };
  }
  if (eventType === "message_start") {
    const usage = normalizeAnthropicUsage(isRecord(payload.message) ? payload.message.usage : payload.usage);
    return usage ? { type: "response_metadata", usage } : null;
  }
  if (eventType === "message_delta") {
    const delta = payload.delta;
    const stopReason = isRecord(delta) && typeof delta.stop_reason === "string"
      ? delta.stop_reason
      : undefined;
    const usage = normalizeAnthropicUsage(payload.usage);
    return stopReason || usage
      ? {
          type: "response_metadata",
          ...(stopReason ? { stopReason } : {}),
          ...(usage ? { usage } : {})
        }
      : null;
  }
  if (eventType === "message_stop") {
    return { type: "done", usage: normalizeAnthropicUsage(payload.usage) };
  }
  if (eventType !== "content_block_delta") {
    return null;
  }

  const delta = payload.delta;
  if (!isRecord(delta) || delta.type !== "text_delta" || typeof delta.text !== "string" || delta.text.length === 0) {
    return null;
  }

  return { type: "text_delta", text: delta.text };
}
