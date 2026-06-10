import { afterEach, describe, expect, it, vi } from "vitest";
import {
  DEFAULT_MAX_OUTPUT_TOKENS,
  createModelProviderLimits
} from "../../shared/modelProvider";
import type { MainAgentModelConfig } from "./configService";
import {
  calculateContextUsage,
  callLLM,
  callLLMStream,
  callLLMWithToolSupport,
  callLLMStreamWithContinuation
} from "./llmRouter";

function createConfig(
  limits = createModelProviderLimits(false)
): MainAgentModelConfig {
  return {
    provider: "openai_chat_completions",
    baseUrl: "https://provider.example.test",
    apiKey: "secret",
    model: "model",
    isFullUrl: false,
    limits
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

function createStreamResponse(chunks: string[]) {
  const encoder = new TextEncoder();

  return {
    ok: true,
    body: new ReadableStream<Uint8Array>({
      start(controller) {
        for (const chunk of chunks) {
          controller.enqueue(encoder.encode(chunk));
        }
        controller.close();
      }
    })
  };
}

async function collectStream(config: MainAgentModelConfig): Promise<unknown[]> {
  const events = [];
  for await (const event of callLLMStream(config, "system", [])) {
    events.push(event);
  }
  return events;
}

async function collectContinuationStream(
  config: MainAgentModelConfig
): Promise<unknown[]> {
  const events = [];
  for await (const event of callLLMStreamWithContinuation(config, "system", [])) {
    events.push(event);
  }
  return events;
}

describe("llmRouter context budget", () => {
  it("uses the configured maximum output budget when present", () => {
    const usage = calculateContextUsage(
      createConfig({
        ...createModelProviderLimits(false),
        maxOutputTokens: 4_096
      }),
      "system",
      []
    );

    expect(usage.requestedOutputTokens).toBe(4_096);
  });

  it("sends the default output budget when the provider does not override it", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        choices: [{ message: { content: "ok" } }]
      })
    });
    vi.stubGlobal("fetch", fetchMock);

    await expect(callLLM(createConfig(), "system", [])).resolves.toBe("ok");

    const request = fetchMock.mock.calls[0]?.[1] as { body: string };
    expect(JSON.parse(request.body).max_completion_tokens).toBe(DEFAULT_MAX_OUTPUT_TOKENS);
    expect(JSON.parse(request.body).max_tokens).toBeUndefined();
  });

  it("clamps the output budget to the configured hard maximum", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        choices: [{ message: { content: "ok" } }]
      })
    });
    vi.stubGlobal("fetch", fetchMock);

    await expect(callLLM(createConfig({
      ...createModelProviderLimits(false),
      maxOutputTokens: 200_000,
      hardMaxOutputTokens: 100_000
    }), "system", [])).resolves.toBe("ok");

    const request = fetchMock.mock.calls[0]?.[1] as { body: string };
    expect(JSON.parse(request.body).max_completion_tokens).toBe(100_000);
  });

  it("sends OpenAI-compatible tool definitions and parses tool calls", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        choices: [
          {
            message: {
              content: "",
              tool_calls: [
                {
                  id: "call-1",
                  type: "function",
                  function: {
                    name: "web_search",
                    arguments: "{\"query\":\"AgentHub\"}"
                  }
                }
              ]
            }
          }
        ]
      })
    });
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      callLLMWithToolSupport(
        createConfig(),
        "system",
        [],
        [
          {
            name: "web_search",
            description: "Search the web.",
            inputSchema: {
              type: "object",
              properties: { query: { type: "string" } },
              required: ["query"]
            }
          }
        ]
      )
    ).resolves.toEqual({
      text: "",
      toolCalls: [
        {
          id: "call-1",
          name: "web_search",
          arguments: { query: "AgentHub" }
        }
      ]
    });

    const body = JSON.parse((fetchMock.mock.calls[0]?.[1] as { body: string }).body);
    expect(body.tools).toEqual([
      {
        type: "function",
        function: {
          name: "web_search",
          description: "Search the web.",
          parameters: {
            type: "object",
            properties: { query: { type: "string" } },
            required: ["query"]
          }
        }
      }
    ]);
    expect(body.tool_choice).toBe("auto");
  });

  it("blocks a request above the default context limit before fetch", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      callLLM(createConfig(), "x".repeat(1_100_000), [])
    ).rejects.toThrow(
      "当前上下文已超过模型配置的上下文窗口限制。请压缩上下文、减少文件内容、清理终端输出，或在模型配置中启用 1M 上下文。"
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("uses the specific 1M error when that configured limit is exceeded", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      callLLM(
        createConfig(createModelProviderLimits(true)),
        "x".repeat(4_300_000),
        []
      )
    ).rejects.toThrow("当前上下文已超过 1M tokens 配置上限，请压缩上下文或新建会话。");
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("llmRouter streaming", () => {
  it("streams OpenAI-compatible text across split chunks and recognizes DONE", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(createStreamResponse([
      "data: {\"choices\":[{\"delta\":{\"content\":\"hel",
      "lo\"}}]}\n\ndata: {\"choices\":[{\"delta\":{}}]}\n\n",
      "data: {\"choices\":[{\"delta\":{\"content\":\" world\"}}]}\n\ndata: [DONE]\n\n"
    ])));

    await expect(collectStream(createConfig())).resolves.toEqual([
      { type: "text_delta", text: "hello" },
      { type: "text_delta", text: " world" },
      { type: "done" }
    ]);
  });

  it("waits for stream completion before reporting OpenAI truncation", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(createStreamResponse([
      "data: {\"choices\":[{\"delta\":{\"content\":\"partial\"}}]}\n\n",
      "data: {\"choices\":[{\"delta\":{},\"finish_reason\":\"length\"}]}\n\n",
      "data: [DONE]\n\n"
    ])));

    await expect(collectStream(createConfig())).resolves.toEqual([
      { type: "text_delta", text: "partial" },
      { type: "done", finishReason: "length", outputTruncated: true }
    ]);
  });

  it("continues OpenAI-compatible streams when output is truncated", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(createStreamResponse([
        "data: {\"choices\":[{\"delta\":{\"content\":\"partial\"}}]}\n\n",
        "data: {\"choices\":[{\"delta\":{},\"finish_reason\":\"length\"}]}\n\n",
        "data: [DONE]\n\n"
      ]))
      .mockResolvedValueOnce(createStreamResponse([
        "data: {\"choices\":[{\"delta\":{\"content\":\" rest\"}}]}\n\n",
        "data: [DONE]\n\n"
      ]));
    vi.stubGlobal("fetch", fetchMock);

    await expect(collectContinuationStream(createConfig())).resolves.toEqual([
      { type: "text_delta", text: "partial" },
      { type: "text_delta", text: " rest" },
      { type: "done" }
    ]);

    const secondRequest = JSON.parse(
      (fetchMock.mock.calls[1]?.[1] as { body: string }).body
    );
    expect(secondRequest.messages).toEqual([
      { role: "system", content: "system" },
      { role: "assistant", content: "partial" },
      expect.objectContaining({
        role: "user",
        content: expect.stringContaining("继续上一条回答")
      })
    ]);
  });

  it("streams Anthropic-compatible deltas and surfaces error events", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(createStreamResponse([
      "event: ping\r\ndata: {\"type\":\"ping\"}\r\n\r\n",
      "event: content_block_delta\r\ndata: {\"type\":\"content_block_delta\",\"delta\":{\"type\":\"text_delta\",\"text\":\"hello\"}}\r\n\r\n",
      "event: error\r\ndata: {\"type\":\"error\",\"error\":{\"message\":\"provider failed\"}}\r\n\r\n"
    ])));

    await expect(collectStream({
      ...createConfig(),
      provider: "anthropic_messages"
    })).resolves.toEqual([
      { type: "text_delta", text: "hello" },
      { type: "error", message: "provider failed" }
    ]);
  });

  it("reports Anthropic max_tokens stop as truncated", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(createStreamResponse([
      "event: content_block_delta\r\ndata: {\"type\":\"content_block_delta\",\"delta\":{\"type\":\"text_delta\",\"text\":\"partial\"}}\r\n\r\n",
      "event: message_delta\r\ndata: {\"type\":\"message_delta\",\"delta\":{\"stop_reason\":\"max_tokens\"},\"usage\":{\"output_tokens\":65536}}\r\n\r\n",
      "event: message_stop\r\ndata: {\"type\":\"message_stop\"}\r\n\r\n"
    ])));

    await expect(collectStream({
      ...createConfig(),
      provider: "anthropic_messages"
    })).resolves.toEqual([
      { type: "text_delta", text: "partial" },
      {
        type: "done",
        stopReason: "max_tokens",
        usage: { completionTokens: 65536 },
        outputTruncated: true
      }
    ]);
  });
});
