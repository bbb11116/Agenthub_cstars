import { afterEach, describe, expect, it, vi } from "vitest";
import type { SaveModelProviderInput } from "../../shared/types";
import { testConnection } from "./modelProviderService";

function createInput(
  overrides: Partial<SaveModelProviderInput> = {}
): SaveModelProviderInput {
  return {
    name: "Provider",
    apiFormat: "openai_chat_completions",
    baseUrl: "https://provider.example.test",
    isFullUrl: false,
    model: "model",
    apiKey: "secret",
    supportsVision: false,
    supportsStreaming: true,
    isDefaultForMainAgent: true,
    enableOneMillionContext: false,
    ...overrides
  };
}

function createJsonResponse(data: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => data,
    text: async () => JSON.stringify(data)
  } as Response;
}

function createStreamResponse(): Response {
  const encoder = new TextEncoder();
  return {
    ok: true,
    status: 200,
    body: new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode("data: {\"choices\":[{\"delta\":{\"content\":\"ok\"}}]}\n\n"));
        controller.close();
      }
    }),
    text: async () => ""
  } as Response;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("modelProviderService testConnection", () => {
  it("returns probed OpenAI-compatible capabilities", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(createJsonResponse({
        choices: [{ message: { content: "pong" } }]
      }))
      .mockResolvedValueOnce(createStreamResponse())
      .mockResolvedValueOnce(createJsonResponse({
        choices: [{ message: { content: "{\"ok\":true}" } }]
      }))
      .mockResolvedValueOnce(createJsonResponse({
        choices: [{ message: { tool_calls: [{ id: "call-1" }] } }]
      }));
    vi.stubGlobal("fetch", fetchMock);

    const result = await testConnection(createInput());

    expect(result.ok).toBe(true);
    expect(result.capabilities).toMatchObject({
      chat: "supported",
      streaming: "supported",
      vision: "unsupported",
      toolCalling: "supported",
      jsonMode: "supported",
      source: "connection_probe"
    });
    expect(fetchMock).toHaveBeenCalledTimes(4);
    expect(JSON.parse((fetchMock.mock.calls[2]?.[1] as { body: string }).body))
      .toMatchObject({ response_format: { type: "json_object" } });
  });
});
