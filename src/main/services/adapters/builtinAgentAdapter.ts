import type { ProviderCapabilityStatus } from "../../../shared/modelProvider";
import type { AgentAdapter, AgentEvent, AgentRunInput } from "../../../shared/agentAdapter";
import { loadMainAgentConfig } from "../configService";
import {
  callLLM,
  callLLMWithToolSupport,
  callLLMStreamWithContinuation,
  LLMError
} from "../llmRouter";
import type {
  ChatMessage,
  LLMToolCall,
  LLMToolDefinition
} from "../llmProviderAdapters";
import {
  createWebToolCall,
  executeWebTool,
  WEB_TOOL_DEFINITIONS,
  type WebToolCall,
  type WebToolName
} from "../webToolService";

function buildMessages(input: AgentRunInput): ChatMessage[] {
  const messages = (input.contextMessages ?? []).map((message) => ({
    role:
      message.role === "agent"
        ? "assistant" as const
        : message.role,
    content: message.content
  }));
  const lastMessage = messages.at(-1);

  if (lastMessage?.role !== "user" || lastMessage.content !== input.userMessage) {
    messages.push({
      role: "user",
      content: input.userMessage
    });
  }

  return messages;
}

function hasToolPermission(input: AgentRunInput, toolName: "webSearch" | "webFetch"): boolean {
  const normalized = input.toolPermissions.join(",").toLowerCase();
  const aliases = toolName === "webSearch"
    ? new Set(["websearch", "web_search"])
    : new Set(["webfetch", "web_fetch"]);
  return normalized
    .split(",")
    .map((entry) => entry.trim())
    .some((entry) => {
      const [key, value] = entry.split("=").map((part) => part.trim());
      return aliases.has(key) && value === "true";
    });
}

function getWebToolDefinitions(input: AgentRunInput): LLMToolDefinition[] {
  const tools: LLMToolDefinition[] = [];
  if (hasToolPermission(input, "webSearch")) {
    tools.push(WEB_TOOL_DEFINITIONS.web_search);
  }
  if (hasToolPermission(input, "webFetch")) {
    tools.push(WEB_TOOL_DEFINITIONS.web_fetch);
  }
  return tools;
}

function getWebToolNames(tools: LLMToolDefinition[]): Set<WebToolName> {
  return new Set(
    tools
      .map((tool) => tool.name)
      .filter((name): name is WebToolName => name === "web_search" || name === "web_fetch")
  );
}

function buildWebToolSystemPrompt(systemPrompt: string, nativeToolCalling: boolean): string {
  const toolPolicy = nativeToolCalling
    ? [
        "Web access policy:",
        "Use the runtime web_search tool for current or external facts that are not in the conversation.",
        "Use web_fetch only when you need details from a specific public URL.",
        "If you cannot emit a native tool call, output exactly one JSON object instead: {\"action\":\"web_search\",\"query\":\"...\",\"maxResults\":5} or {\"action\":\"web_fetch\",\"url\":\"https://example.com\",\"maxChars\":12000}.",
        "Do not claim you searched or fetched a page unless a tool result was provided.",
        "After tool results are provided, answer normally and include source URLs when they support the answer."
      ]
    : [
        "Web access policy:",
        "This model API does not expose native tool calls. If you need web access, output exactly one JSON object and no prose.",
        "For search: {\"action\":\"web_search\",\"query\":\"...\",\"maxResults\":5}.",
        "For page fetch: {\"action\":\"web_fetch\",\"url\":\"https://example.com\",\"maxChars\":12000}.",
        "After a tool result is provided, answer normally and include source URLs when they support the answer.",
        "Do not claim you searched or fetched a page unless a tool result was provided."
      ];
  return [systemPrompt, toolPolicy.join("\n")].join("\n\n");
}

function stripJsonFence(text: string): string {
  const trimmed = text.trim();
  const fenced = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  return fenced ? fenced[1].trim() : trimmed;
}

function parseFallbackToolCall(
  text: string,
  allowedTools: Set<WebToolName>
): WebToolCall | null {
  const candidate = stripJsonFence(text);
  if (!candidate.startsWith("{") || !candidate.endsWith("}")) {
    return null;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(candidate) as unknown;
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return null;
  }
  const record = parsed as Record<string, unknown>;
  const action = typeof record.action === "string" ? record.action : "";
  if (action !== "web_search" && action !== "web_fetch") {
    return null;
  }
  if (!allowedTools.has(action)) {
    return null;
  }
  const { action: _action, ...args } = record;
  return createWebToolCall(action, args);
}

function normalizeNativeToolCalls(
  toolCalls: LLMToolCall[],
  allowedTools: Set<WebToolName>
): WebToolCall[] {
  return toolCalls
    .filter((toolCall) => allowedTools.has(toolCall.name as WebToolName))
    .map((toolCall) => ({
      id: toolCall.id,
      name: toolCall.name as WebToolName,
      arguments: toolCall.arguments
    }));
}

function createToolResultMessage(call: WebToolCall, result: unknown, ok: boolean, errorMessage?: string): ChatMessage {
  return {
    role: "user",
    content: [
      `Tool result for ${call.name} (${call.id}):`,
      JSON.stringify(
        {
          ok,
          ...(errorMessage ? { errorMessage } : {}),
          result
        },
        null,
        2
      ),
      "",
      "Use this tool result to continue. If more web information is needed, request one more tool call; otherwise answer the user directly."
    ].join("\n")
  };
}

function shouldFallbackFromNativeToolError(
  error: unknown,
  capability: ProviderCapabilityStatus | undefined
): boolean {
  if (capability === "supported") {
    return false;
  }
  const message = error instanceof Error ? error.message : String(error);
  return /tool|function|tool_choice|unsupported|invalid/i.test(message);
}

export class BuiltinAgentAdapter implements AgentAdapter {
  async *run(input: AgentRunInput): AsyncIterable<AgentEvent> {
    yield { type: "status", status: "running" };

    try {
      const config = loadMainAgentConfig(input.rootPath);
      const messages = buildMessages(input);
      const webTools = getWebToolDefinitions(input);
      if (webTools.length > 0) {
        yield* this.runWithWebTools(input, config, messages, webTools);
        return;
      }

      const disableStream = input.runOptions?.disableStream === true;
      const attemptStream = config.supportsStreaming && !disableStream;

      console.info("[AgentHub] BuiltinAgentAdapter.run", {
        agentId: input.agentId,
        mode: input.runOptions?.mode,
        providerId: config.providerId,
        apiFormat: config.provider,
        model: config.model,
        supportsStreaming: config.supportsStreaming,
        disableStream,
        attemptStream
      });

      if (attemptStream) {
        let receivedText = false;
        let accumulatedText = "";
        let outputTruncated = false;
        let finishReason: string | undefined;

        try {
          for await (const event of callLLMStreamWithContinuation(
            config,
            input.systemPrompt,
            messages
          )) {
            if (event.type === "text_delta") {
              receivedText = true;
              accumulatedText += event.text;
              yield { type: "text_delta", content: event.text };
            } else if (event.type === "reasoning_delta") {
              yield { type: "reasoning_delta", content: event.text };
            } else if (event.type === "error") {
              if (receivedText) {
                console.warn("[AgentHub] BuiltinAgentAdapter stream error after partial output", {
                  agentId: input.agentId,
                  rawTextLength: accumulatedText.length,
                  message: event.message
                });
                yield { type: "error", message: event.message };
                yield { type: "status", status: "failed" };
                return;
              }

              console.warn("Built-in model stream failed before output; using non-stream fallback.", event.message);
              break;
            } else if (event.type === "done") {
              if (event.finishReason) {
                finishReason = event.finishReason;
              }
              if (event.outputTruncated) {
                outputTruncated = true;
              }
              if (receivedText) {
                if (outputTruncated) {
                  console.warn("[AgentHub] BuiltinAgentAdapter stream output truncated", {
                    agentId: input.agentId,
                    rawTextLength: accumulatedText.length,
                    finishReason
                  });
                  yield {
                    type: "error",
                    message: `Model output was truncated before completion (${finishReason ?? "token budget reached"}).`
                  };
                  yield { type: "status", status: "failed" };
                  return;
                }
                yield { type: "status", status: "completed" };
                return;
              }
              break;
            }
          }
        } catch (streamError) {
          if (receivedText) {
            console.warn("[AgentHub] BuiltinAgentAdapter stream threw after partial output", {
              agentId: input.agentId,
              rawTextLength: accumulatedText.length,
              error: streamError instanceof Error ? streamError.message : String(streamError)
            });
            yield {
              type: "error",
              message: streamError instanceof Error ? streamError.message : "Stream error"
            };
            yield { type: "status", status: "failed" };
            return;
          }

          console.warn("Built-in model stream request failed; using non-stream fallback.", streamError);
        }
      }

      const responseText = await callLLM(config, input.systemPrompt, messages);
      yield { type: "text_delta", content: responseText };
      yield { type: "status", status: "completed" };
    } catch (error) {
      const telemetry = error instanceof LLMError ? error.telemetry : undefined;
      if (telemetry) {
        console.warn("[AgentHub] BuiltinAgentAdapter LLMError", {
          agentId: input.agentId,
          telemetry,
          message: error instanceof Error ? error.message : String(error)
        });
      }
      yield {
        type: "error",
        message: error instanceof Error ? error.message : "AgentHub built-in model call failed."
      };
      yield { type: "status", status: "failed" };
    }
  }

  private async *runWithWebTools(
    input: AgentRunInput,
    config: ReturnType<typeof loadMainAgentConfig>,
    initialMessages: ChatMessage[],
    webTools: LLMToolDefinition[]
  ): AsyncIterable<AgentEvent> {
    const allowedTools = getWebToolNames(webTools);
    const maxIterations = Math.max(1, Math.min(input.runOptions?.maxIterations ?? 6, 12));
    const messages = [...initialMessages];
    let useNativeToolCalling = config.toolCalling !== "unsupported";

    console.info("[AgentHub] BuiltinAgentAdapter web tools enabled", {
      agentId: input.agentId,
      providerId: config.providerId,
      toolCalling: config.toolCalling ?? "unknown",
      tools: webTools.map((tool) => tool.name),
      maxIterations
    });

    for (let iteration = 0; iteration < maxIterations; iteration += 1) {
      const systemPrompt = buildWebToolSystemPrompt(input.systemPrompt, useNativeToolCalling);
      let text = "";
      let toolCalls: WebToolCall[] = [];

      if (useNativeToolCalling) {
        try {
          const response = await callLLMWithToolSupport(
            config,
            systemPrompt,
            messages,
            webTools,
            { toolDefinitions: webTools }
          );
          text = response.text;
          toolCalls = normalizeNativeToolCalls(response.toolCalls, allowedTools);
        } catch (error) {
          if (!shouldFallbackFromNativeToolError(error, config.toolCalling)) {
            throw error;
          }
          console.warn("[AgentHub] Native tool calling failed; falling back to JSON web tool protocol.", {
            agentId: input.agentId,
            message: error instanceof Error ? error.message : String(error)
          });
          useNativeToolCalling = false;
          continue;
        }
      } else {
        text = await callLLM(config, systemPrompt, messages, {
          toolDefinitions: webTools
        });
      }

      if (toolCalls.length === 0) {
        const fallbackToolCall = parseFallbackToolCall(text, allowedTools);
        if (fallbackToolCall) {
          toolCalls = [fallbackToolCall];
        }
      }

      if (toolCalls.length === 0) {
        if (text.trim().length === 0) {
          throw new LLMError("Model returned empty response.");
        }
        yield { type: "text_delta", content: text };
        yield { type: "status", status: "completed" };
        return;
      }

      messages.push({
        role: "assistant",
        content: text.trim().length > 0
          ? text
          : `Requested web tools: ${toolCalls.map((toolCall) => toolCall.name).join(", ")}`
      });

      for (const toolCall of toolCalls) {
        yield {
          type: "structured_result",
          result: {
            toolCalls: [
              {
                id: toolCall.id,
                name: toolCall.name,
                arguments: toolCall.arguments
              }
            ]
          }
        };

        try {
          const result = await executeWebTool(toolCall, input.env);
          yield {
            type: "structured_result",
            result: {
              toolResults: [
                {
                  toolCallId: toolCall.id,
                  name: toolCall.name,
                  result,
                  ok: true
                }
              ]
            }
          };
          messages.push(createToolResultMessage(toolCall, result, true));
        } catch (error) {
          const errorMessage = error instanceof Error ? error.message : String(error);
          yield {
            type: "structured_result",
            result: {
              toolResults: [
                {
                  toolCallId: toolCall.id,
                  name: toolCall.name,
                  result: null,
                  ok: false,
                  errorMessage
                }
              ]
            }
          };
          messages.push(createToolResultMessage(toolCall, null, false, errorMessage));
        }
      }
    }

    yield {
      type: "error",
      message: `Agent reached web tool iteration limit (${maxIterations}) before producing a final answer.`
    };
    yield { type: "status", status: "iteration_limit_reached", iterationsUsed: maxIterations };
  }
}
