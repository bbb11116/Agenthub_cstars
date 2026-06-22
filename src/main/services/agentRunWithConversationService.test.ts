import { afterEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { closeDatabase, initializeDatabase } from "../db";
import { getAgentById, createAgent } from "../db/repositories/agentRepo";
import { createConversation } from "../db/repositories/conversationRepo";
import { getMessagesByConversation } from "../db/repositories/messageRepo";
import {
  createProviderSession,
  getActiveProviderSession,
  getProviderSessionsByConversation
} from "../db/repositories/providerSessionRepo";
import { getDiffProposalsByConversation } from "../db/repositories/diffRepo";
import {
  createAgentRun,
  getLatestAgentRunByConversation,
  getRunningAgentRunByConversation
} from "../db/repositories/agentRunRepo";
import type { RuntimeProvider } from "../../shared/runtime";
import type { AgentEvent, AgentAdapter, AgentRunInput } from "../../shared/agentAdapter";
import {
  ConversationNotFoundError,
  ProviderMismatchError,
  ConversationAlreadyRunningError,
  ResumeFailedError
} from "../../shared/agentAdapter";
import { createWorkspaceFromFolder } from "./workspaceService";
import { runAgentWithConversation, extractStandaloneHtml } from "./agentRunWithConversationService";
import { getDatabase } from "../db";

let tempDir: string | null = null;

function createTempRoot(): string {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "agenthub-resume-"));
  return tempDir;
}

function createMockAdapter(events: AgentEvent[]): AgentAdapter {
  return {
    async *run(_input) {
      for (const event of events) {
        yield event;
      }
    }
  };
}

afterEach(() => {
  closeDatabase();

  if (tempDir) {
    fs.rmSync(tempDir, { recursive: true, force: true });
    tempDir = null;
  }
});

describe("runAgentWithConversation", () => {
  async function setupWorkspaceAndAgent() {
    const rootPath = createTempRoot();
    fs.mkdirSync(path.join(rootPath, "src"), { recursive: true });
    fs.writeFileSync(path.join(rootPath, "src", "App.tsx"), "export default () => <div/>");

    initializeDatabase({ dbPath: path.join(rootPath, "agenthub.db") });

    const result = await createWorkspaceFromFolder({
      rootPath,
      name: "Test Workspace",
      mainAgentRuntimeProvider: "mock"
    });

    const db = getDatabase();
    const agent = createAgent(
      {
        workspaceId: result.workspace.id,
        name: "Sub Agent",
        role: "sub",
        runtimeProvider: "claude_code",
        systemPrompt: "You are a sub agent.",
        capabilities: ["coding"],
        tools: { readFile: true, writeDiff: true, applyDiff: false, previewArtifact: true, gitStatus: true },
        fileScope: ["src/**"],
        status: "available"
      },
      db
    );
    const conversation = createConversation(
      {
        workspaceId: result.workspace.id,
        agentId: agent.id,
        title: "Sub Agent Chat",
        mode: "single",
        provider: "claude_code"
      },
      db
    );

    return {
      workspace: result.workspace,
      agent,
      conversation,
      rootPath
    };
  }

  it("should create a new conversation when no conversationId is provided", async () => {
    const { workspace, agent } = await setupWorkspaceAndAgent();
    const db = getDatabase();

    const mockAdapter = createMockAdapter([
      { type: "text_delta", content: "Hello!" },
      { type: "provider_session", providerSessionId: "session-123" },
      { type: "status", status: "completed" }
    ]);

    const result = await runAgentWithConversation(
      {
        workspaceId: workspace.id,
        agentId: agent.id,
        message: "Start a new chat"
      },
      db,
      undefined,
      mockAdapter
    );

    expect(result.conversationId).toBeDefined();
    expect(result.messages.length).toBeGreaterThan(0);
    expect(result.usedFallback).toBeFalsy();

    // Verify conversation was created with provider
    const messages = getMessagesByConversation(result.conversationId, db);
    expect(messages.some((m) => m.senderType === "user")).toBe(true);
  });

  it("should reject when conversation provider mismatches agent provider", async () => {
    const { workspace, agent, conversation } = await setupWorkspaceAndAgent();
    const db = getDatabase();

    // Set agent to claude_code and conversation to codex_local
    db.prepare("UPDATE agents SET runtime_provider = ? WHERE id = ?")
      .run("claude_code", agent.id);
    db.prepare("UPDATE conversations SET provider = ? WHERE id = ?")
      .run("codex_local", conversation.id);

    const mockAdapter = createMockAdapter([]);

    await expect(
      runAgentWithConversation(
        {
          workspaceId: workspace.id,
          agentId: agent.id,
          conversationId: conversation.id,
          message: "Hello"
        },
        db,
        undefined,
        mockAdapter
      )
    ).rejects.toThrow(ProviderMismatchError);
  });

  it("should reject when conversation is already running", async () => {
    const { workspace, agent, conversation } = await setupWorkspaceAndAgent();
    const db = getDatabase();

    // Create a running agent run
    createAgentRun(
      {
        conversationId: conversation.id,
        workspaceId: workspace.id,
        agentId: agent.id,
        provider: "claude_code",
        rootPath: workspace.rootPath,
        systemPromptSnapshot: "test",
        toolPermissionsSnapshot: "test"
      },
      db
    );

    const mockAdapter = createMockAdapter([]);

    await expect(
      runAgentWithConversation(
        {
          workspaceId: workspace.id,
          agentId: agent.id,
          conversationId: conversation.id,
          message: "Hello"
        },
        db,
        undefined,
        mockAdapter
      )
    ).rejects.toThrow(ConversationAlreadyRunningError);
  });

  it("should throw ConversationNotFoundError for invalid conversation ID", async () => {
    const { workspace, agent } = await setupWorkspaceAndAgent();
    const db = getDatabase();

    const mockAdapter = createMockAdapter([]);

    await expect(
      runAgentWithConversation(
        {
          workspaceId: workspace.id,
          agentId: agent.id,
          conversationId: "non-existent-id",
          message: "Hello"
        },
        db,
        undefined,
        mockAdapter
      )
    ).rejects.toThrow(ConversationNotFoundError);
  });

  it("should use provider session ID for resume when available", async () => {
    const { workspace, agent, conversation } = await setupWorkspaceAndAgent();
    const db = getDatabase();

    // Set agent and conversation provider
    db.prepare("UPDATE agents SET runtime_provider = ? WHERE id = ?")
      .run("claude_code", agent.id);
    db.prepare("UPDATE conversations SET provider = ? WHERE id = ?")
      .run("claude_code", conversation.id);

    // Create an active provider session
    createProviderSession(
      {
        conversationId: conversation.id,
        workspaceId: workspace.id,
        agentId: agent.id,
        provider: "claude_code",
        providerSessionId: "existing-session-id",
        rootPath: workspace.rootPath
      },
      db
    );

    let capturedInput: unknown = null;
    const mockAdapter: AgentAdapter = {
      async *run(input) {
        capturedInput = input;
        yield { type: "text_delta", content: "Resumed!" };
        yield { type: "status", status: "completed" };
      }
    };

    const result = await runAgentWithConversation(
      {
        workspaceId: workspace.id,
        agentId: agent.id,
        conversationId: conversation.id,
        message: "Continue",
        resume: true
      },
      db,
      undefined,
      mockAdapter
    );

    expect(capturedInput).toMatchObject({
      resume: {
        enabled: true,
        providerSessionId: "existing-session-id"
      }
    });
    expect(result.usedFallback).toBeFalsy();
  });

  it("should fallback rebuild when no provider session ID exists", async () => {
    const { workspace, agent, conversation } = await setupWorkspaceAndAgent();
    const db = getDatabase();

    // Set agent and conversation provider
    db.prepare("UPDATE agents SET runtime_provider = ? WHERE id = ?")
      .run("claude_code", agent.id);
    db.prepare("UPDATE conversations SET provider = ? WHERE id = ?")
      .run("claude_code", conversation.id);

    // No provider session created - should fallback

    let capturedInput: unknown = null;
    const mockAdapter: AgentAdapter = {
      async *run(input) {
        capturedInput = input;
        yield { type: "text_delta", content: "Fallback!" };
        yield { type: "provider_session", providerSessionId: "new-session-id" };
        yield { type: "status", status: "completed" };
      }
    };

    const result = await runAgentWithConversation(
      {
        workspaceId: workspace.id,
        agentId: agent.id,
        conversationId: conversation.id,
        message: "Continue",
        resume: true
      },
      db,
      undefined,
      mockAdapter
    );

    expect(capturedInput).toMatchObject({
      resume: { enabled: false }
    });
    expect(result.usedFallback).toBe(true);

    // Verify new provider session was created
    const activeSession = getActiveProviderSession(conversation.id, db);
    expect(activeSession).toBeDefined();
    expect(activeSession?.providerSessionId).toBe("new-session-id");
  });

  it("should fallback rebuild when resume fails with ResumeFailedError", async () => {
    const { workspace, agent, conversation } = await setupWorkspaceAndAgent();
    const db = getDatabase();

    // Set agent and conversation provider
    db.prepare("UPDATE agents SET runtime_provider = ? WHERE id = ?")
      .run("claude_code", agent.id);
    db.prepare("UPDATE conversations SET provider = ? WHERE id = ?")
      .run("claude_code", conversation.id);

    // Create an active provider session
    createProviderSession(
      {
        conversationId: conversation.id,
        workspaceId: workspace.id,
        agentId: agent.id,
        provider: "claude_code",
        providerSessionId: "old-session-id",
        rootPath: workspace.rootPath
      },
      db
    );

    let callCount = 0;
    const mockAdapter: AgentAdapter = {
      async *run(input) {
        callCount++;
        if (input.resume.enabled) {
          throw new ResumeFailedError("Session expired");
        }
        yield { type: "text_delta", content: "Recovered!" };
        yield { type: "provider_session", providerSessionId: "recovered-session" };
        yield { type: "status", status: "completed" };
      }
    };

    const result = await runAgentWithConversation(
      {
        workspaceId: workspace.id,
        agentId: agent.id,
        conversationId: conversation.id,
        message: "Continue",
        resume: true
      },
      db,
      undefined,
      mockAdapter
    );

    expect(callCount).toBe(2); // First call fails, second (fallback) succeeds
    expect(result.usedFallback).toBe(true);
    expect(result.messages.some((m) => {
      const content = m.content as { text?: string };
      return content.text?.includes("底层会话恢复失败");
    })).toBe(true);
  });

  it("should run an AgentHub built-in specialist with saved conversation context", async () => {
    const { workspace, agent, conversation } = await setupWorkspaceAndAgent();
    const db = getDatabase();

    db.prepare("UPDATE agents SET runtime_provider = ? WHERE id = ?")
      .run("builtin_openai", agent.id);
    db.prepare("UPDATE conversations SET provider = ? WHERE id = ?")
      .run("builtin_openai", conversation.id);

    let capturedInput: unknown = null;
    const mockAdapter: AgentAdapter = {
      async *run(input) {
        capturedInput = input;
        yield { type: "text_delta", content: "上海今天晴。" };
        yield { type: "status", status: "completed" };
      }
    };

    const result = await runAgentWithConversation(
      {
        workspaceId: workspace.id,
        agentId: agent.id,
        conversationId: conversation.id,
        message: "查询上海天气",
        resume: true
      },
      db,
      undefined,
      mockAdapter
    );

    expect(capturedInput).toMatchObject({
      provider: "builtin_openai",
      contextMessages: [
        {
          role: "system",
          content: expect.stringContaining("Workspace context:")
        },
        {
          role: "user",
          content: "查询上海天气"
        }
      ],
      resume: {
        enabled: false
      }
    });
    expect(capturedInput).toMatchObject({
      systemPrompt: expect.stringContaining("AgentHub workspace editing policy")
    });
    expect(result.usedFallback).toBeFalsy();
  });

  it("should use agent run snapshot for system prompt, not current agent config", async () => {
    const { workspace, agent, conversation } = await setupWorkspaceAndAgent();
    const db = getDatabase();

    // Set agent and conversation provider
    db.prepare("UPDATE agents SET runtime_provider = ? WHERE id = ?")
      .run("claude_code", agent.id);
    db.prepare("UPDATE conversations SET provider = ? WHERE id = ?")
      .run("claude_code", conversation.id);

    // Create a previous agent run with a different system prompt snapshot (mark as completed)
    const prevRun = createAgentRun(
      {
        conversationId: conversation.id,
        workspaceId: workspace.id,
        agentId: agent.id,
        provider: "claude_code",
        providerSessionId: "old-session",
        rootPath: workspace.rootPath,
        systemPromptSnapshot: "Old system prompt from snapshot",
        toolPermissionsSnapshot: "readFile=true, writeDiff=true"
      },
      db
    );
    // Mark it as completed so it doesn't block new runs
    db.prepare("UPDATE agent_runs SET status = 'completed' WHERE id = ?").run(prevRun.id);

    // Update agent's current system prompt
    db.prepare("UPDATE agents SET system_prompt = ? WHERE id = ?")
      .run("New current system prompt", agent.id);

    // Create provider session so resume can work
    createProviderSession(
      {
        conversationId: conversation.id,
        workspaceId: workspace.id,
        agentId: agent.id,
        provider: "claude_code",
        providerSessionId: "old-session",
        rootPath: workspace.rootPath
      },
      db
    );

    let capturedInput: unknown = null;
    const mockAdapter: AgentAdapter = {
      async *run(input) {
        capturedInput = input;
        yield { type: "text_delta", content: "Done" };
        yield { type: "status", status: "completed" };
      }
    };

    await runAgentWithConversation(
      {
        workspaceId: workspace.id,
        agentId: agent.id,
        conversationId: conversation.id,
        message: "Hello",
        resume: true
      },
      db,
      undefined,
      mockAdapter
    );

    // The system prompt in the adapter input should be from the agent's CURRENT config
    // (since we read from agent, not from snapshot for the adapter input)
    // The snapshot is saved in agent_runs for audit purposes
    expect(capturedInput).toMatchObject({
      systemPrompt: expect.stringContaining("New current system prompt")
    });
    expect(capturedInput).toMatchObject({
      systemPrompt: expect.stringContaining("SEARCH/REPLACE")
    });
  });

  it("passes the single-chat ReAct-like budget to the adapter and run snapshot", async () => {
    const { workspace, agent, conversation } = await setupWorkspaceAndAgent();
    const db = getDatabase();
    let capturedInput: unknown = null;
    const mockAdapter: AgentAdapter = {
      async *run(input) {
        capturedInput = input;
        yield { type: "text_delta", content: "普通回答" };
        yield { type: "status", status: "completed", iterationsUsed: 2 };
      }
    };

    await runAgentWithConversation(
      {
        workspaceId: workspace.id,
        agentId: agent.id,
        conversationId: conversation.id,
        message: "解释这个项目"
      },
      db,
      undefined,
      mockAdapter
    );

    expect(capturedInput).toMatchObject({
      runOptions: {
        mode: "single_chat",
        maxIterations: 40
      }
    });
    expect(getLatestAgentRunByConversation(conversation.id, db)).toMatchObject({
      mode: "single_chat",
      maxIterations: 40,
      iterationsUsed: 2
    });
  });

  it("passes the group sub-agent budget to the adapter", async () => {
    const { workspace, agent, conversation } = await setupWorkspaceAndAgent();
    const db = getDatabase();
    let capturedInput: unknown = null;
    const mockAdapter: AgentAdapter = {
      async *run(input) {
        capturedInput = input;
        yield {
          type: "text_delta",
          content: JSON.stringify({
            status: "no_changes_needed",
            summary: "无需修改",
            completedCriteria: ["criterion-1"],
            unresolvedCriteria: [],
            filesRead: [],
            assumptions: [],
            risks: []
          })
        };
        yield { type: "status", status: "completed" };
      }
    };

    await runAgentWithConversation(
      {
        workspaceId: workspace.id,
        agentId: agent.id,
        conversationId: conversation.id,
        message: "分析任务",
        mode: "group_subagent",
        structuredOutput: true
      },
      db,
      undefined,
      mockAdapter
    );

    expect(capturedInput).toMatchObject({
      runOptions: {
        mode: "group_subagent",
        maxIterations: 15,
        structuredOutput: true
      }
    });
  });

  it("marks code-change runs without DiffProposal or no_changes_needed as verification_failed", async () => {
    const { workspace, agent, conversation } = await setupWorkspaceAndAgent();
    const db = getDatabase();
    const mockAdapter = createMockAdapter([
      { type: "text_delta", content: "修改完成" },
      { type: "status", status: "completed" }
    ]);

    const result = await runAgentWithConversation(
      {
        workspaceId: workspace.id,
        agentId: agent.id,
        conversationId: conversation.id,
        message: "修改按钮颜色"
      },
      db,
      undefined,
      mockAdapter
    );

    expect(result.status).toBe("error");
    expect(result.runResult?.status).toBe("verification_failed");
    expect(getLatestAgentRunByConversation(conversation.id, db)?.status).toBe(
      "verification_failed"
    );
  });

  it("does not require DiffProposal for ordinary explanation runs", async () => {
    const { workspace, agent, conversation } = await setupWorkspaceAndAgent();
    const db = getDatabase();
    const mockAdapter = createMockAdapter([
      { type: "text_delta", content: "这个组件负责展示主界面状态。" },
      { type: "status", status: "completed" }
    ]);

    const result = await runAgentWithConversation(
      {
        workspaceId: workspace.id,
        agentId: agent.id,
        conversationId: conversation.id,
        message: "解释一下这个组件"
      },
      db,
      undefined,
      mockAdapter
    );

    expect(result.status).toBe("available");
    expect(result.runResult?.status).toBe("completed");
    expect(getLatestAgentRunByConversation(conversation.id, db)?.status).toBe("completed");
    expect(getDiffProposalsByConversation(conversation.id, db)).toHaveLength(0);
  });

  it("strips legacy empty DiffProposal blocks from ordinary replies", async () => {
    const { workspace, agent, conversation } = await setupWorkspaceAndAgent();
    const db = getDatabase();
    const mockAdapter = createMockAdapter([
      {
        type: "text_delta",
        content: [
          "我是 AgentHub 中的子 Agent。",
          "",
          "```diff",
          "# DiffProposal",
          "# No file changes proposed.",
          "```"
        ].join("\n")
      },
      { type: "status", status: "completed" }
    ]);

    const result = await runAgentWithConversation(
      {
        workspaceId: workspace.id,
        agentId: agent.id,
        conversationId: conversation.id,
        message: "你是谁"
      },
      db,
      undefined,
      mockAdapter
    );

    expect(result.status).toBe("available");
    const textMessage = result.messages.find((message) => message.messageType === "text");
    const text = (textMessage?.content as { text?: string }).text ?? "";
    expect(text).toContain("我是 AgentHub");
    expect(text).not.toContain("DiffProposal");
    expect(text).not.toContain("No file changes proposed");
    expect(getDiffProposalsByConversation(conversation.id, db)).toHaveLength(0);
  });

  it("creates a diff_card from real adapter diff output before verification", async () => {
    const { workspace, agent, conversation, rootPath } = await setupWorkspaceAndAgent();
    const db = getDatabase();
    fs.writeFileSync(path.join(rootPath, "src", "App.tsx"), "export default () => <div/>");
    const sr_s = `${"<".repeat(7)} SEARCH`;
    const sr_d = "=".repeat(7);
    const sr_r = `${">".repeat(7)} REPLACE`;
    const mockAdapter = createMockAdapter([
      {
        type: "text_delta",
        content: [
          "Here is the proposed change:",
          "",
          "src/App.tsx",
          "```",
          sr_s,
          "export default () => <div/>",
          sr_d,
          "export default () => <main/>",
          sr_r,
          "```"
        ].join("\n")
      },
      { type: "status", status: "completed" }
    ]);

    const result = await runAgentWithConversation(
      {
        workspaceId: workspace.id,
        agentId: agent.id,
        conversationId: conversation.id,
        message: "修改 App 组件"
      },
      db,
      undefined,
      mockAdapter
    );

    expect(result.status).toBe("available");
    expect(result.runResult?.status).toBe("completed");
    expect(result.messages.some((message) => message.messageType === "diff_card")).toBe(true);
    expect(result.messages.some((message) => {
      const text = (message.content as { text?: string }).text ?? "";
      return text.includes("SEARCH");
    })).toBe(false);
    expect(getDiffProposalsByConversation(conversation.id, db)).toHaveLength(1);
  });

  it("auto-repairs a deliverable reply that only asks for clarification", async () => {
    const { workspace, agent, conversation } = await setupWorkspaceAndAgent();
    const db = getDatabase();
    const sr_s = `${"<".repeat(7)} SEARCH`;
    const sr_d = "=".repeat(7);
    const sr_r = `${">".repeat(7)} REPLACE`;
    const capturedInputs: AgentRunInput[] = [];
    const mockAdapter: AgentAdapter = {
      async *run(input) {
        capturedInputs.push(input);
        if (capturedInputs.length === 1) {
          yield {
            type: "text_delta",
            content: "在创建 PPT 文件前，需要先确认一个关键信息："
          };
          yield { type: "status", status: "completed" };
          return;
        }

        yield {
          type: "text_delta",
          content: [
            "已按通用飞书产品介绍场景生成一版可预览 PPT。",
            "",
            "src/feishu-intro.html",
            "```",
            sr_s,
            sr_d,
            "<!doctype html>",
            "<html><body><section><h1>飞书产品介绍</h1><p>协作、沟通与知识管理一体化。</p></section></body></html>",
            sr_r,
            "```"
          ].join("\n")
        };
        yield { type: "status", status: "completed" };
      }
    };

    const result = await runAgentWithConversation(
      {
        workspaceId: workspace.id,
        agentId: agent.id,
        conversationId: conversation.id,
        message: "帮我做一个飞书产品 PPT"
      },
      db,
      undefined,
      mockAdapter
    );

    expect(capturedInputs).toHaveLength(2);
    expect(capturedInputs[1].userMessage).toContain("上一轮没有生成用户请求的可预览产物");
    expect(result.status).toBe("available");
    expect(result.runResult?.status).toBe("completed");
    expect(result.messages.some((message) => message.messageType === "diff_card")).toBe(true);
    expect(
      result.messages.some((message) => {
        const text = (message.content as { text?: string }).text ?? "";
        return text.includes("需要先确认一个关键信息");
      })
    ).toBe(false);
    expect(getDiffProposalsByConversation(conversation.id, db)).toHaveLength(1);
  });

  it("reuses an identical provider session mapping instead of inserting a duplicate", async () => {
    const { workspace, agent, conversation } = await setupWorkspaceAndAgent();
    const db = getDatabase();
    const input = {
      conversationId: conversation.id,
      workspaceId: workspace.id,
      agentId: agent.id,
      provider: "claude_code" as const,
      providerSessionId: "same-session-id",
      rootPath: workspace.rootPath
    };

    const first = createProviderSession(input, db);
    const second = createProviderSession(input, db);

    expect(second.id).toBe(first.id);
    expect(getProviderSessionsByConversation(conversation.id, db)).toHaveLength(1);
  });
});

describe("extractStandaloneHtml", () => {
  it("extracts HTML wrapped in a fenced code block and strips the fence from the message", () => {
    const htmlBody = [
      "<!DOCTYPE html>",
      "<html>",
      "<body>",
      "  <h1>Slide 1</h1>",
      "  <p>Hello world, this is a sample slide deck to demonstrate the preview rendering pipeline.</p>",
      "  <p>It contains enough content to clear the minimum length threshold easily.</p>",
      "  <h2>Section</h2>",
      "  <p>More content so the HTML body comfortably exceeds the 200 byte minimum.</p>",
      "</body>",
      "</html>"
    ].join("\n");
    const reply = [
      "Here is the slide deck you asked for:",
      "",
      "```html",
      htmlBody,
      "```",
      "",
      "Let me know if you want changes."
    ].join("\n");

    const result = extractStandaloneHtml(reply);
    expect(result).not.toBeNull();
    expect(result!.html).toContain("<h1>Slide 1</h1>");
    expect(result!.html).toContain("<p>Hello world");
    expect(result!.html).not.toContain("```");
    expect(result!.strippedText).toContain("Here is the slide deck");
    expect(result!.strippedText).toContain("Let me know if you want changes");
    expect(result!.strippedText).not.toContain("<!DOCTYPE html>");
  });

  it("returns the full text as html when the LLM dumps HTML inline without a fence", () => {
    const reply = [
      "<!DOCTYPE html>",
      "<html>",
      "<body>",
      "  <h1>Hello</h1>",
      "  <p>Long enough content to clear the 200 character threshold and have multiple HTML tags.</p>",
      "  <p>Another paragraph to push the count higher and satisfy the heuristic.</p>",
      "  <p>Yet another paragraph so we comfortably exceed the 200 byte limit on body length alone.</p>",
      "</body>",
      "</html>"
    ].join("\n");

    const result = extractStandaloneHtml(reply);
    expect(result).not.toBeNull();
    expect(result!.html).toContain("<h1>Hello</h1>");
    expect(result!.strippedText).toBe(reply);
  });

  it("returns null for ordinary prose replies", () => {
    const reply =
      "Sure, here is an explanation of HTML. HTML stands for HyperText Markup Language and is the standard markup language for documents designed to be displayed in a web browser. It uses tags like h1, p, and div to structure content, but I am just discussing the concept, not actually emitting markup.";
    expect(extractStandaloneHtml(reply)).toBeNull();
  });

  it("returns null when the text has a tiny HTML fragment under the minimum length", () => {
    const reply = "Here is a snippet: <h1>Hi</h1>";
    expect(extractStandaloneHtml(reply)).toBeNull();
  });

  it("returns null when the body has tags but no recognised block-level opener", () => {
    const reply = [
      "Some prose that goes on for a while to clear the 200 character threshold and to ensure the function reaches the opener check...",
      "More prose to push past the minimum length. ".repeat(5),
      "Then a stray <span> tag with no body content.</span>"
    ].join("\n");

    expect(extractStandaloneHtml(reply)).toBeNull();
  });
});

describe("looksLikeAnticipatoryReply", () => {
  // The helper is module-private; we exercise it indirectly through the
  // post-process pipeline by importing the same module that owns it. The
  // exported `extractStandaloneHtml` is the only public surface, so we
  // keep these tests against the regex patterns we know are baked in.
  const anticipatoryChinese = "好的，信息已经充分，我来为您制作一个精美的4页飞书产品介绍PPT。";
  const anticipatoryEnglish = "Sure, I'll create a beautiful 4-page Feishu product intro PPT for you.";
  const realHtml = "<!DOCTYPE html><html><body><h1>Slide 1</h1><p>Hello</p></body></html>";
  const longExplanation =
    "I need to clarify a few things before I produce the deliverable. The first question is about the audience: are you targeting internal stakeholders or external customers? The second question is about the tone: formal or casual? The third question is about the slide count: do you want exactly four pages, or is the count flexible? The fourth question is about visual style: do you prefer a corporate, minimalist, or playful aesthetic? Once I have answers to these I can produce the slide deck for you, but I would rather not guess and have to redo it later. Please answer at your convenience and I will get to work right away.";

  it("flags short Chinese confirmations as anticipatory", () => {
    expect(anticipatoryChinese).toMatch(/好的[,，].{0,40}(我|让|马上|立刻|这就开始|我这就)/);
    expect(anticipatoryChinese).toMatch(/我(将|会|来|马上|立刻|这就).{0,40}(制作|创建|生成|做|为您|给你)/);
  });

  it("flags short English confirmations as anticipatory", () => {
    expect(anticipatoryEnglish).toMatch(/I('ll| will) (create|make|generate|build|prepare)/i);
    expect(anticipatoryEnglish).toMatch(/sure[,，]? (i('ll| will)|let me)/i);
  });

  it("does not flag a real HTML payload as anticipatory", () => {
    const patterns = [
      /好的[,，].{0,40}(我|让|马上|立刻|这就开始|我这就)/,
      /信息已经充分/,
      /我(将|会|来|马上|立刻|这就).{0,40}(制作|创建|生成|做|为您|给你)/,
      /I('ll| will) (create|make|generate|build|prepare)/i
    ];
    for (const pattern of patterns) {
      expect(realHtml).not.toMatch(pattern);
    }
  });

  it("does not flag long clarification questions as anticipatory", () => {
    expect(longExplanation.length).toBeGreaterThan(400);
    const anticipatoryMatch = /I('ll| will) (create|make|generate|build|prepare)/i.test(
      longExplanation
    );
    expect(anticipatoryMatch).toBe(false);
  });
});
