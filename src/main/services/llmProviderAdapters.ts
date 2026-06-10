import type { MainAgentModelConfig, MainAgentModelProvider } from "./configService";
import {
  parseAnthropicStreamFrame,
  parseOpenAIStreamFrame,
  type LlmStreamEvent,
  type LlmTokenUsage,
  type SseFrame
} from "./sseParser";

export type ChatMessage = {
  role: "user" | "assistant" | "system";
  content: string;
};

export type RequestBodyTokenFields = {
  max_completion_tokens?: number;
  max_tokens?: number;
};

export type NormalizedLLMRequest = {
  config: MainAgentModelConfig;
  systemPrompt: string;
  messages: ChatMessage[];
  tokenFields: RequestBodyTokenFields;
  stream: boolean;
  tools?: LLMToolDefinition[];
};

export type LLMToolDefinition = {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
};

export type LLMToolCall = {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
};

export type ProviderResponseMetadata = {
  finishReason?: string;
  stopReason?: string;
  usage?: LlmTokenUsage;
};

export type LLMProviderAdapter = {
  apiFormat: MainAgentModelProvider;
  label: string;
  endpointSuffix: string;
  maxTokensField: keyof RequestBodyTokenFields;
  buildHeaders: (config: MainAgentModelConfig) => Record<string, string>;
  buildRequestBody: (request: NormalizedLLMRequest) => Record<string, unknown>;
  readResponseText: (data: unknown) => string | undefined;
  readToolCalls: (data: unknown) => LLMToolCall[];
  readResponseMetadata: (data: unknown) => ProviderResponseMetadata;
  parseStreamFrame: (frame: SseFrame) => LlmStreamEvent | null;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
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

function getOpenAIChoice(data: unknown): Record<string, unknown> | undefined {
  if (!isRecord(data) || !Array.isArray(data.choices) || !isRecord(data.choices[0])) {
    return undefined;
  }
  return data.choices[0];
}

function parseToolArguments(value: unknown): Record<string, unknown> {
  if (isRecord(value)) {
    return value;
  }
  if (typeof value !== "string" || value.trim().length === 0) {
    return {};
  }
  try {
    const parsed = JSON.parse(value) as unknown;
    return isRecord(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function getToolDefinitions(
  tools: LLMToolDefinition[] | undefined
): LLMToolDefinition[] {
  return Array.isArray(tools) ? tools.filter((tool) => tool.name.trim().length > 0) : [];
}

function buildOpenAIBody(request: NormalizedLLMRequest): Record<string, unknown> {
  const tools = getToolDefinitions(request.tools);
  return {
    model: request.config.model,
    messages: [
      { role: "system", content: request.systemPrompt },
      ...request.messages
    ],
    temperature: 0.3,
    reasoning_split: true,
    ...request.tokenFields,
    ...(tools.length > 0
      ? {
          tools: tools.map((tool) => ({
            type: "function",
            function: {
              name: tool.name,
              description: tool.description,
              parameters: tool.inputSchema
            }
          })),
          tool_choice: "auto"
        }
      : {}),
    ...(request.stream
      ? {
          stream: true,
          stream_options: { include_usage: true }
        }
      : {})
  };
}

function readOpenAIResponseText(data: unknown): string | undefined {
  const choice = getOpenAIChoice(data);
  const message = isRecord(choice?.message) ? choice.message : undefined;
  return typeof message?.content === "string" ? message.content : undefined;
}

function readOpenAIToolCalls(data: unknown): LLMToolCall[] {
  const choice = getOpenAIChoice(data);
  const message = isRecord(choice?.message) ? choice.message : undefined;
  if (!Array.isArray(message?.tool_calls)) {
    return [];
  }
  return message.tool_calls
    .map((toolCall, index) => {
      if (!isRecord(toolCall) || !isRecord(toolCall.function)) {
        return null;
      }
      const name = typeof toolCall.function.name === "string"
        ? toolCall.function.name
        : "";
      if (!name) {
        return null;
      }
      return {
        id: typeof toolCall.id === "string" ? toolCall.id : `tool-${index + 1}`,
        name,
        arguments: parseToolArguments(toolCall.function.arguments)
      };
    })
    .filter((toolCall): toolCall is LLMToolCall => toolCall !== null);
}

function readOpenAIResponseMetadata(data: unknown): ProviderResponseMetadata {
  const choice = getOpenAIChoice(data);
  const finishReason = typeof choice?.finish_reason === "string"
    ? choice.finish_reason
    : undefined;
  return {
    ...(finishReason ? { finishReason } : {}),
    ...(isRecord(data) ? { usage: normalizeOpenAIUsage(data.usage) } : {})
  };
}

function buildAnthropicBody(request: NormalizedLLMRequest): Record<string, unknown> {
  const tools = getToolDefinitions(request.tools);
  return {
    model: request.config.model,
    system: request.systemPrompt,
    messages: request.messages.map((message) => ({
      role: message.role === "system" ? "user" : message.role,
      content: message.content
    })),
    ...request.tokenFields,
    ...(tools.length > 0
      ? {
          tools: tools.map((tool) => ({
            name: tool.name,
            description: tool.description,
            input_schema: tool.inputSchema
          }))
        }
      : {}),
    ...(request.stream ? { stream: true } : {})
  };
}

function readAnthropicResponseText(data: unknown): string | undefined {
  if (!isRecord(data) || !Array.isArray(data.content)) {
    return undefined;
  }
  const textBlock = data.content.find((block) =>
    isRecord(block) && block.type === "text" && typeof block.text === "string"
  );
  return isRecord(textBlock) && typeof textBlock.text === "string"
    ? textBlock.text
    : undefined;
}

function readAnthropicToolCalls(data: unknown): LLMToolCall[] {
  if (!isRecord(data) || !Array.isArray(data.content)) {
    return [];
  }
  return data.content
    .map((block, index) => {
      if (!isRecord(block) || block.type !== "tool_use") {
        return null;
      }
      const name = typeof block.name === "string" ? block.name : "";
      if (!name) {
        return null;
      }
      return {
        id: typeof block.id === "string" ? block.id : `tool-${index + 1}`,
        name,
        arguments: parseToolArguments(block.input)
      };
    })
    .filter((toolCall): toolCall is LLMToolCall => toolCall !== null);
}

function readAnthropicResponseMetadata(data: unknown): ProviderResponseMetadata {
  if (!isRecord(data)) {
    return {};
  }
  const stopReason = typeof data.stop_reason === "string" ? data.stop_reason : undefined;
  return {
    ...(stopReason ? { stopReason } : {}),
    usage: normalizeAnthropicUsage(data.usage)
  };
}

const openAICompatibleAdapter: LLMProviderAdapter = {
  apiFormat: "openai_chat_completions",
  label: "OpenAI",
  endpointSuffix: "/chat/completions",
  maxTokensField: "max_completion_tokens",
  buildHeaders: (config) => ({
    "Content-Type": "application/json",
    Authorization: `Bearer ${config.apiKey}`
  }),
  buildRequestBody: buildOpenAIBody,
  readResponseText: readOpenAIResponseText,
  readToolCalls: readOpenAIToolCalls,
  readResponseMetadata: readOpenAIResponseMetadata,
  parseStreamFrame: parseOpenAIStreamFrame
};

const anthropicCompatibleAdapter: LLMProviderAdapter = {
  apiFormat: "anthropic_messages",
  label: "Anthropic",
  endpointSuffix: "/messages",
  maxTokensField: "max_tokens",
  buildHeaders: (config) => ({
    "Content-Type": "application/json",
    "x-api-key": config.apiKey,
    "anthropic-version": "2023-06-01"
  }),
  buildRequestBody: buildAnthropicBody,
  readResponseText: readAnthropicResponseText,
  readToolCalls: readAnthropicToolCalls,
  readResponseMetadata: readAnthropicResponseMetadata,
  parseStreamFrame: parseAnthropicStreamFrame
};

const PROVIDER_ADAPTERS: Record<MainAgentModelProvider, LLMProviderAdapter> = {
  openai_chat_completions: openAICompatibleAdapter,
  anthropic_messages: anthropicCompatibleAdapter
};

export function getLLMProviderAdapter(
  apiFormat: MainAgentModelProvider
): LLMProviderAdapter {
  return PROVIDER_ADAPTERS[apiFormat];
}

export function buildTokenFields(
  adapter: LLMProviderAdapter,
  effectiveMaxOutputTokens: number
): RequestBodyTokenFields {
  return adapter.maxTokensField === "max_completion_tokens"
    ? { max_completion_tokens: effectiveMaxOutputTokens, max_tokens: undefined }
    : { max_tokens: effectiveMaxOutputTokens, max_completion_tokens: undefined };
}
