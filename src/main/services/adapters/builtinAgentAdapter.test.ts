import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentRunInput } from "../../../shared/agentAdapter";

const {
  callLLM,
  callLLMStream,
  callLLMWithToolSupport,
  callLLMStreamWithContinuation,
  createArtifact,
  executeWebTool,
  loadMainAgentConfig
} = vi.hoisted(() => ({
  callLLM: vi.fn(),
  callLLMStream: vi.fn(),
  callLLMWithToolSupport: vi.fn(),
  callLLMStreamWithContinuation: vi.fn(),
  createArtifact: vi.fn(),
  executeWebTool: vi.fn(),
  loadMainAgentConfig: vi.fn()
}));

vi.mock("../configService", () => ({
  loadMainAgentConfig
}));

vi.mock("../llmRouter", () => ({
  callLLM,
  callLLMStream,
  callLLMWithToolSupport,
  callLLMStreamWithContinuation
}));

vi.mock("../artifactService", () => ({
  createArtifact
}));

vi.mock("../webToolService", () => ({
  WEB_TOOL_DEFINITIONS: {
    web_search: {
      name: "web_search",
      description: "Search the web.",
      inputSchema: { type: "object", properties: { query: { type: "string" } } }
    },
    web_fetch: {
      name: "web_fetch",
      description: "Fetch a page.",
      inputSchema: { type: "object", properties: { url: { type: "string" } } }
    }
  },
  createWebToolCall: (name: string, args: Record<string, unknown>) => ({
    id: "fallback-call",
    name,
    arguments: args
  }),
  executeWebTool
}));

import { BuiltinAgentAdapter } from "./builtinAgentAdapter";

describe("BuiltinAgentAdapter", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    callLLMStreamWithContinuation.mockImplementation((...args) =>
      callLLMStream(...args)
    );
  });

  it("uses the configured Model Provider and preserves conversation context", async () => {
    const config = {
      provider: "openai_chat_completions" as const,
      baseUrl: "https://example.test",
      apiKey: "secret",
      model: "mimo-v2.5-pro"
    };
    const input: AgentRunInput = {
      workspaceId: "workspace-1",
      conversationId: "conversation-1",
      agentId: "agent-1",
      provider: "builtin_openai",
      rootPath: "/workspace",
      systemPrompt: "You answer weather questions.",
      userMessage: "上海今天天气如何？",
      contextMessages: [
        { role: "user", content: "你是谁？" },
        { role: "agent", content: "我是天气助手。" },
        { role: "user", content: "上海今天天气如何？" }
      ],
      toolPermissions: [],
      runOptions: {
        mode: "single_chat",
        maxIterations: 40,
        conversationId: "conversation-1",
        agentId: "agent-1",
        workspaceRoot: "/workspace",
        prompt: "上海今天天气如何？"
      },
      resume: { enabled: false }
    };

    loadMainAgentConfig.mockReturnValue(config);
    callLLM.mockResolvedValue("上海今天晴。");

    const events = [];
    for await (const event of new BuiltinAgentAdapter().run(input)) {
      events.push(event);
    }

    expect(loadMainAgentConfig).toHaveBeenCalledWith("/workspace");
    expect(callLLM).toHaveBeenCalledWith(
      config,
      input.systemPrompt,
      [
        { role: "user", content: "你是谁？" },
        { role: "assistant", content: "我是天气助手。" },
        { role: "user", content: "上海今天天气如何？" }
      ]
    );
    expect(events).toEqual([
      { type: "status", status: "running" },
      { type: "text_delta", content: "上海今天晴。" },
      { type: "status", status: "completed" }
    ]);
  });

  it("yields configured provider stream deltas incrementally", async () => {
    const input: AgentRunInput = {
      workspaceId: "workspace-1",
      conversationId: "conversation-1",
      agentId: "agent-1",
      provider: "builtin_openai",
      rootPath: "/workspace",
      systemPrompt: "Answer concisely.",
      userMessage: "hello",
      toolPermissions: [],
      runOptions: {
        mode: "single_chat",
        maxIterations: 40,
        conversationId: "conversation-1",
        agentId: "agent-1",
        workspaceRoot: "/workspace",
        prompt: "hello"
      },
      resume: { enabled: false }
    };
    const config = {
      provider: "openai_chat_completions" as const,
      baseUrl: "https://example.test",
      apiKey: "secret",
      model: "model",
      supportsStreaming: true
    };

    loadMainAgentConfig.mockReturnValue(config);
    callLLMStream.mockImplementation(async function* () {
      yield { type: "text_delta", text: "hel" };
      yield { type: "text_delta", text: "lo" };
      yield { type: "done" };
    });

    const events = [];
    for await (const event of new BuiltinAgentAdapter().run(input)) {
      events.push(event);
    }

    expect(callLLM).not.toHaveBeenCalled();
    expect(events).toEqual([
      { type: "status", status: "running" },
      { type: "text_delta", content: "hel" },
      { type: "text_delta", content: "lo" },
      { type: "status", status: "completed" }
    ]);
  });

  it("falls back to the non-stream call when streaming fails before output", async () => {
    const input: AgentRunInput = {
      workspaceId: "workspace-1",
      conversationId: "conversation-1",
      agentId: "agent-1",
      provider: "builtin_openai",
      rootPath: "/workspace",
      systemPrompt: "Answer concisely.",
      userMessage: "hello",
      toolPermissions: [],
      runOptions: {
        mode: "single_chat",
        maxIterations: 40,
        conversationId: "conversation-1",
        agentId: "agent-1",
        workspaceRoot: "/workspace",
        prompt: "hello"
      },
      resume: { enabled: false }
    };

    loadMainAgentConfig.mockReturnValue({
      provider: "openai_chat_completions",
      baseUrl: "https://example.test",
      apiKey: "secret",
      model: "model",
      supportsStreaming: true
    });
    callLLMStream.mockImplementation(async function* () {
      yield { type: "error", message: "stream unavailable" };
    });
    callLLM.mockResolvedValue("fallback response");

    const events = [];
    for await (const event of new BuiltinAgentAdapter().run(input)) {
      events.push(event);
    }

    expect(events).toEqual([
      { type: "status", status: "running" },
      { type: "text_delta", content: "fallback response" },
      { type: "status", status: "completed" }
    ]);
  });

  it("marks a streamed truncated model output as failed", async () => {
    const input: AgentRunInput = {
      workspaceId: "workspace-1",
      conversationId: "conversation-1",
      agentId: "agent-1",
      provider: "builtin_openai",
      rootPath: "/workspace",
      systemPrompt: "Answer concisely.",
      userMessage: "hello",
      toolPermissions: [],
      runOptions: {
        mode: "single_chat",
        maxIterations: 40,
        conversationId: "conversation-1",
        agentId: "agent-1",
        workspaceRoot: "/workspace",
        prompt: "hello"
      },
      resume: { enabled: false }
    };

    loadMainAgentConfig.mockReturnValue({
      provider: "openai_chat_completions",
      baseUrl: "https://example.test",
      apiKey: "secret",
      model: "model",
      supportsStreaming: true
    });
    callLLMStream.mockImplementation(async function* () {
      yield { type: "text_delta", text: "partial" };
      yield { type: "done", outputTruncated: true };
    });

    const events = [];
    for await (const event of new BuiltinAgentAdapter().run(input)) {
      events.push(event);
    }

    expect(callLLM).not.toHaveBeenCalled();
    expect(events).toEqual([
      { type: "status", status: "running" },
      { type: "text_delta", content: "partial" },
      { type: "error", message: "Model output was truncated before completion (token budget reached)." },
      { type: "status", status: "failed" }
    ]);
  });

  it("runs native web tool calls and feeds the result back to the model", async () => {
    const input: AgentRunInput = {
      workspaceId: "workspace-1",
      conversationId: "conversation-1",
      agentId: "agent-1",
      provider: "builtin_openai",
      rootPath: "/workspace",
      systemPrompt: "Answer with sources.",
      userMessage: "MiniMax 3.0 有联网吗？",
      toolPermissions: ["webSearch=true, webFetch=false"],
      runOptions: {
        mode: "single_chat",
        maxIterations: 6,
        conversationId: "conversation-1",
        agentId: "agent-1",
        workspaceRoot: "/workspace",
        prompt: "MiniMax 3.0 有联网吗？"
      },
      resume: { enabled: false }
    };
    const config = {
      provider: "openai_chat_completions" as const,
      baseUrl: "https://example.test",
      apiKey: "secret",
      model: "model",
      supportsStreaming: true,
      toolCalling: "supported" as const
    };

    loadMainAgentConfig.mockReturnValue(config);
    callLLMWithToolSupport
      .mockResolvedValueOnce({
        text: "",
        toolCalls: [
          {
            id: "call-1",
            name: "web_search",
            arguments: { query: "MiniMax 3.0 web search" }
          }
        ]
      })
      .mockResolvedValueOnce({
        text: "MiniMax API 本身不内置联网，AgentHub 通过 web_search 工具补齐。",
        toolCalls: []
      });
    executeWebTool.mockResolvedValue({
      query: "MiniMax 3.0 web search",
      provider: "mock",
      results: [
        {
          title: "MiniMax docs",
          url: "https://example.test/minimax",
          snippet: "OpenAI-compatible API."
        }
      ]
    });

    const events = [];
    for await (const event of new BuiltinAgentAdapter().run(input)) {
      events.push(event);
    }

    expect(callLLM).not.toHaveBeenCalled();
    expect(callLLMWithToolSupport).toHaveBeenCalledTimes(2);
    expect(executeWebTool).toHaveBeenCalledWith(
      {
        id: "call-1",
        name: "web_search",
        arguments: { query: "MiniMax 3.0 web search" }
      },
      undefined
    );
    expect(events).toEqual([
      { type: "status", status: "running" },
      {
        type: "structured_result",
        result: {
          toolCalls: [
            {
              id: "call-1",
              name: "web_search",
              arguments: { query: "MiniMax 3.0 web search" }
            }
          ]
        }
      },
      {
        type: "structured_result",
        result: {
          toolResults: [
            {
              toolCallId: "call-1",
              name: "web_search",
              result: {
                query: "MiniMax 3.0 web search",
                provider: "mock",
                results: [
                  {
                    title: "MiniMax docs",
                    url: "https://example.test/minimax",
                    snippet: "OpenAI-compatible API."
                  }
                ]
              },
              ok: true
            }
          ]
        }
      },
      {
        type: "text_delta",
        content: "MiniMax API 本身不内置联网，AgentHub 通过 web_search 工具补齐。"
      },
      { type: "status", status: "completed" }
    ]);
  });

  it("uses the JSON web tool protocol when native tool calling is unsupported", async () => {
    const input: AgentRunInput = {
      workspaceId: "workspace-1",
      conversationId: "conversation-1",
      agentId: "agent-1",
      provider: "builtin_openai",
      rootPath: "/workspace",
      systemPrompt: "Answer with sources.",
      userMessage: "查一下 AgentHub",
      toolPermissions: ["webSearch=true"],
      runOptions: {
        mode: "single_chat",
        maxIterations: 6,
        conversationId: "conversation-1",
        agentId: "agent-1",
        workspaceRoot: "/workspace",
        prompt: "查一下 AgentHub"
      },
      resume: { enabled: false }
    };

    loadMainAgentConfig.mockReturnValue({
      provider: "openai_chat_completions",
      baseUrl: "https://example.test",
      apiKey: "secret",
      model: "model",
      supportsStreaming: true,
      toolCalling: "unsupported"
    });
    callLLM
      .mockResolvedValueOnce("{\"action\":\"web_search\",\"query\":\"AgentHub\",\"maxResults\":3}")
      .mockResolvedValueOnce("AgentHub 是一个 agent 工作台。");
    executeWebTool.mockResolvedValue({
      query: "AgentHub",
      provider: "mock",
      results: []
    });

    const events = [];
    for await (const event of new BuiltinAgentAdapter().run(input)) {
      events.push(event);
    }

    expect(callLLMWithToolSupport).not.toHaveBeenCalled();
    expect(callLLM).toHaveBeenCalledTimes(2);
    expect(events.at(-2)).toEqual({
      type: "text_delta",
      content: "AgentHub 是一个 agent 工作台。"
    });
    expect(events.at(-1)).toEqual({ type: "status", status: "completed" });
  });

  it("registers create_artifact when previewArtifact=true and runs the tool call end-to-end", async () => {
    const input: AgentRunInput = {
      workspaceId: "workspace-1",
      conversationId: "conversation-1",
      agentId: "agent-1",
      provider: "builtin_openai",
      rootPath: "/workspace",
      systemPrompt: "You produce preview cards.",
      userMessage: "给我做一个 PPT 大纲",
      toolPermissions: ["previewArtifact=true"],
      runOptions: {
        mode: "group_subagent",
        maxIterations: 6,
        conversationId: "conversation-1",
        agentId: "agent-1",
        workspaceRoot: "/workspace",
        prompt: "给我做一个 PPT 大纲"
      },
      resume: { enabled: false }
    };
    const config = {
      provider: "openai_chat_completions" as const,
      baseUrl: "https://example.test",
      apiKey: "secret",
      model: "model",
      supportsStreaming: true,
      toolCalling: "supported" as const
    };
    const fakeArtifact = {
      id: "artifact-1",
      workspaceId: input.workspaceId,
      conversationId: input.conversationId,
      agentId: input.agentId,
      type: "html",
      title: "PPT 大纲",
      content: "<h1>Slide 1</h1>",
      language: "html",
      version: 1,
      createdAt: "2026-01-01T00:00:00.000Z"
    };

    loadMainAgentConfig.mockReturnValue(config);
    callLLMWithToolSupport
      .mockResolvedValueOnce({
        text: "",
        toolCalls: [
          {
            id: "c1",
            name: "create_artifact",
            arguments: {
              title: "PPT 大纲",
              content: "<h1>Slide 1</h1>",
              type: "presentation"
            }
          }
        ]
      })
      .mockResolvedValueOnce({
        text: "已生成 PPT 大纲预览卡。",
        toolCalls: []
      });
    createArtifact.mockReturnValue(fakeArtifact);

    const events = [];
    for await (const event of new BuiltinAgentAdapter().run(input)) {
      events.push(event);
    }

    const firstCallArgs = callLLMWithToolSupport.mock.calls[0];
    expect(firstCallArgs[1]).toContain("vertical scrolling only");
    expect(firstCallArgs[1]).toContain("do not add JavaScript navigation");
    const passedToolNames = (firstCallArgs[3] as Array<{ name: string }>).map((tool) => tool.name);
    expect(passedToolNames).toContain("create_artifact");

    expect(createArtifact).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceId: input.workspaceId,
        conversationId: input.conversationId,
        agentId: input.agentId,
        type: "html",
        title: "PPT 大纲",
        content: "<h1>Slide 1</h1>",
        language: "html",
        render: expect.objectContaining({ mode: "html_iframe", status: "none" })
      })
    );

    expect(events).toEqual([
      { type: "status", status: "running" },
      {
        type: "structured_result",
        result: {
          toolCalls: [
            {
              id: "c1",
              name: "create_artifact",
              arguments: {
                title: "PPT 大纲",
                content: "<h1>Slide 1</h1>",
                type: "presentation"
              }
            }
          ]
        }
      },
      {
        type: "structured_result",
        result: {
          artifacts: [
            {
              artifactId: "artifact-1",
              title: "PPT 大纲",
              type: "html",
              filePath: undefined,
              language: "html",
              sizeBytes: 16,
              renderStatus: "none"
            }
          ]
        }
      },
      {
        type: "structured_result",
        result: {
          toolResults: [
            {
              toolCallId: "c1",
              name: "create_artifact",
              result: { artifactId: "artifact-1", status: "created" },
              ok: true
            }
          ]
        }
      },
      { type: "text_delta", content: "已生成 PPT 大纲预览卡。" },
      { type: "status", status: "completed" }
    ]);
  });

  it("does not register create_artifact when previewArtifact=false", async () => {
    const input: AgentRunInput = {
      workspaceId: "workspace-1",
      conversationId: "conversation-1",
      agentId: "agent-1",
      provider: "builtin_openai",
      rootPath: "/workspace",
      systemPrompt: "You answer questions.",
      userMessage: "hi",
      toolPermissions: ["previewArtifact=false", "webSearch=true"],
      runOptions: {
        mode: "single_chat",
        maxIterations: 6,
        conversationId: "conversation-1",
        agentId: "agent-1",
        workspaceRoot: "/workspace",
        prompt: "hi"
      },
      resume: { enabled: false }
    };
    const config = {
      provider: "openai_chat_completions" as const,
      baseUrl: "https://example.test",
      apiKey: "secret",
      model: "model",
      supportsStreaming: true,
      toolCalling: "supported" as const
    };

    loadMainAgentConfig.mockReturnValue(config);
    callLLMWithToolSupport.mockResolvedValue({
      text: "ok",
      toolCalls: []
    });

    const events = [];
    for await (const event of new BuiltinAgentAdapter().run(input)) {
      events.push(event);
    }

    const passedToolNames = (callLLMWithToolSupport.mock.calls[0][3] as Array<{ name: string }>).map(
      (tool) => tool.name
    );
    expect(passedToolNames).not.toContain("create_artifact");
    expect(passedToolNames).toContain("web_search");
  });

  it("does not register create_artifact when mode is single_chat (ephemeral only for group subagents)", async () => {
    const input: AgentRunInput = {
      workspaceId: "workspace-1",
      conversationId: "conversation-1",
      agentId: "agent-1",
      provider: "builtin_openai",
      rootPath: "/workspace",
      systemPrompt: "You answer questions.",
      userMessage: "hi",
      toolPermissions: ["previewArtifact=true", "webSearch=true"],
      runOptions: {
        mode: "single_chat",
        maxIterations: 6,
        conversationId: "conversation-1",
        agentId: "agent-1",
        workspaceRoot: "/workspace",
        prompt: "hi"
      },
      resume: { enabled: false }
    };
    const config = {
      provider: "openai_chat_completions" as const,
      baseUrl: "https://example.test",
      apiKey: "secret",
      model: "model",
      supportsStreaming: true,
      toolCalling: "supported" as const
    };

    loadMainAgentConfig.mockReturnValue(config);
    callLLMWithToolSupport.mockResolvedValue({
      text: "ok",
      toolCalls: []
    });

    const events = [];
    for await (const event of new BuiltinAgentAdapter().run(input)) {
      events.push(event);
    }

    const passedToolNames = (callLLMWithToolSupport.mock.calls[0][3] as Array<{ name: string }>).map(
      (tool) => tool.name
    );
    expect(passedToolNames).not.toContain("create_artifact");
    expect(passedToolNames).toContain("web_search");
  });

  it("rejects create_artifact with content over 1MB and does not call createArtifact", async () => {
    const input: AgentRunInput = {
      workspaceId: "workspace-1",
      conversationId: "conversation-1",
      agentId: "agent-1",
      provider: "builtin_openai",
      rootPath: "/workspace",
      systemPrompt: "You produce preview cards.",
      userMessage: "big content",
      toolPermissions: ["previewArtifact=true"],
      runOptions: {
        mode: "group_subagent",
        maxIterations: 6,
        conversationId: "conversation-1",
        agentId: "agent-1",
        workspaceRoot: "/workspace",
        prompt: "big content"
      },
      resume: { enabled: false }
    };
    const config = {
      provider: "openai_chat_completions" as const,
      baseUrl: "https://example.test",
      apiKey: "secret",
      model: "model",
      supportsStreaming: true,
      toolCalling: "supported" as const
    };

    loadMainAgentConfig.mockReturnValue(config);
    callLLMWithToolSupport
      .mockResolvedValueOnce({
        text: "",
        toolCalls: [
          {
            id: "c2",
            name: "create_artifact",
            arguments: {
              title: "too big",
              content: "x".repeat(1_000_001),
              type: "html"
            }
          }
        ]
      })
      .mockResolvedValueOnce({
        text: "抱歉内容太大。",
        toolCalls: []
      });

    const events = [];
    for await (const event of new BuiltinAgentAdapter().run(input)) {
      events.push(event);
    }

    expect(createArtifact).not.toHaveBeenCalled();
    const errorResult = events.find(
      (event) =>
        event.type === "structured_result" &&
        Array.isArray((event.result as { toolResults?: unknown[] }).toolResults) &&
        ((event.result as { toolResults: Array<{ ok: boolean; errorMessage?: string }> })
          .toolResults[0]?.ok === false)
    ) as { type: "structured_result"; result: { toolResults: Array<{ ok: boolean; errorMessage?: string }> } };
    expect(errorResult).toBeDefined();
    expect(errorResult.result.toolResults[0].errorMessage).toMatch(/exceeds/);
  });

  it("rejects create_artifact with an out-of-whitelist type", async () => {
    const input: AgentRunInput = {
      workspaceId: "workspace-1",
      conversationId: "conversation-1",
      agentId: "agent-1",
      provider: "builtin_openai",
      rootPath: "/workspace",
      systemPrompt: "You produce preview cards.",
      userMessage: "bad type",
      toolPermissions: ["previewArtifact=true"],
      runOptions: {
        mode: "group_subagent",
        maxIterations: 6,
        conversationId: "conversation-1",
        agentId: "agent-1",
        workspaceRoot: "/workspace",
        prompt: "bad type"
      },
      resume: { enabled: false }
    };
    const config = {
      provider: "openai_chat_completions" as const,
      baseUrl: "https://example.test",
      apiKey: "secret",
      model: "model",
      supportsStreaming: true,
      toolCalling: "supported" as const
    };

    loadMainAgentConfig.mockReturnValue(config);
    callLLMWithToolSupport
      .mockResolvedValueOnce({
        text: "",
        toolCalls: [
          {
            id: "c3",
            name: "create_artifact",
            arguments: {
              title: "bad",
              content: "stuff",
              type: "pdf"
            }
          }
        ]
      })
      .mockResolvedValueOnce({
        text: "ok",
        toolCalls: []
      });

    const events = [];
    for await (const event of new BuiltinAgentAdapter().run(input)) {
      events.push(event);
    }

    expect(createArtifact).not.toHaveBeenCalled();
    const errorResult = events.find(
      (event) =>
        event.type === "structured_result" &&
        Array.isArray((event.result as { toolResults?: unknown[] }).toolResults) &&
        ((event.result as { toolResults: Array<{ ok: boolean; errorMessage?: string }> })
          .toolResults[0]?.ok === false)
    ) as { type: "structured_result"; result: { toolResults: Array<{ ok: boolean; errorMessage?: string }> } };
    expect(errorResult).toBeDefined();
    expect(errorResult.result.toolResults[0].errorMessage).toMatch(/html, markdown, document, presentation/);
  });

  it("rejects create_artifact with missing or non-string content", async () => {
    const input: AgentRunInput = {
      workspaceId: "workspace-1",
      conversationId: "conversation-1",
      agentId: "agent-1",
      provider: "builtin_openai",
      rootPath: "/workspace",
      systemPrompt: "You produce preview cards.",
      userMessage: "missing",
      toolPermissions: ["previewArtifact=true"],
      runOptions: {
        mode: "group_subagent",
        maxIterations: 6,
        conversationId: "conversation-1",
        agentId: "agent-1",
        workspaceRoot: "/workspace",
        prompt: "missing"
      },
      resume: { enabled: false }
    };
    const config = {
      provider: "openai_chat_completions" as const,
      baseUrl: "https://example.test",
      apiKey: "secret",
      model: "model",
      supportsStreaming: true,
      toolCalling: "supported" as const
    };

    loadMainAgentConfig.mockReturnValue(config);
    callLLMWithToolSupport
      .mockResolvedValueOnce({
        text: "",
        toolCalls: [
          {
            id: "c4",
            name: "create_artifact",
            arguments: {
              title: "missing content",
              type: "html"
            }
          }
        ]
      })
      .mockResolvedValueOnce({
        text: "ok",
        toolCalls: []
      });

    const events = [];
    for await (const event of new BuiltinAgentAdapter().run(input)) {
      events.push(event);
    }

    expect(createArtifact).not.toHaveBeenCalled();
  });
});
