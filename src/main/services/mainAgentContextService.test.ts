import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Message } from "../../shared/domain";
import { createModelProviderLimits } from "../../shared/modelProvider";
import { closeDatabase, initializeDatabase } from "../db";
import { createAgent } from "../db/repositories/agentRepo";
import {
  createConversationCompactSummary,
  getConversationCompactSummaries,
  type ConversationCompactSummary
} from "../db/repositories/conversationCompactSummaryRepo";
import { createConversation } from "../db/repositories/conversationRepo";
import { createMessage } from "../db/repositories/messageRepo";
import { createWorkspace } from "../db/repositories/workspaceRepo";
import type { MainAgentModelConfig } from "./configService";
import {
  buildMainAgentContextPayload,
  buildMainAgentConversationMessages,
  prepareMainAgentContext,
  RECENT_RAW_MESSAGE_LIMIT
} from "./mainAgentContextService";

let tempDir: string | null = null;

function createTempDb() {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "agenthub-main-context-"));
  return initializeDatabase({ dbPath: path.join(tempDir, "agenthub.db") });
}

function createConfig(enableOneMillionContext = false): MainAgentModelConfig {
  return {
    provider: "openai_chat_completions",
    baseUrl: "https://provider.example.test",
    apiKey: "secret",
    model: "model",
    limits: createModelProviderLimits(enableOneMillionContext)
  };
}

function createSyntheticMessage(index: number): Message {
  return {
    id: `message-${index}`,
    workspaceId: "workspace",
    conversationId: "conversation",
    senderType: index % 2 === 0 ? "user" : "agent",
    senderId: index % 2 === 0 ? "local-user" : "main-agent",
    messageType: "text",
    content: { text: `message body ${index}` },
    createdAt: new Date(index * 1000).toISOString()
  };
}

function setupConversation() {
  const db = createTempDb();
  const workspace = createWorkspace(
    {
      name: "Context Workspace",
      rootPath: tempDir!,
      gitEnabled: false
    },
    db
  );
  const agent = createAgent(
    {
      workspaceId: workspace.id,
      name: "Main Agent",
      role: "main",
      type: "orchestrator",
      runtimeProvider: "builtin_openai",
      status: "available"
    },
    db
  );
  const conversation = createConversation(
    {
      workspaceId: workspace.id,
      agentId: agent.id,
      title: "Main Conversation",
      mode: "single"
    },
    db
  );

  return { db, workspace, agent, conversation };
}

afterEach(() => {
  closeDatabase();

  if (tempDir) {
    fs.rmSync(tempDir, { recursive: true, force: true });
    tempDir = null;
  }
});

describe("mainAgentContextService", () => {
  it("uses a summary without dropping the latest 20 raw messages", () => {
    const allMessages = Array.from({ length: 25 }, (_, index) =>
      createSyntheticMessage(index)
    );
    const summary: ConversationCompactSummary = {
      id: "summary",
      conversationId: "conversation",
      coveredMessageStartId: "message-0",
      coveredMessageEndId: "message-9",
      summary: "# Conversation Compact Summary\n\nOlder context.",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    };

    const messages = buildMainAgentConversationMessages(allMessages, summary);

    expect(messages).toHaveLength(RECENT_RAW_MESSAGE_LIMIT + 1);
    expect(messages[0]).toMatchObject({
      role: "system",
      content: expect.stringContaining("Older context.")
    });
    expect(messages.slice(1).map((message) => message.content)).toEqual(
      allMessages.slice(-RECENT_RAW_MESSAGE_LIMIT).map((message) => `message body ${allMessages.indexOf(message)}`)
    );
  });

  it("compacts old history, persists the summary, and rebuilds from summary plus recent raw messages", async () => {
    const { db, workspace, conversation } = setupConversation();
    const body = "x".repeat(128_000);
    const savedMessages = Array.from({ length: 30 }, (_, index) =>
      createMessage(
        {
          workspaceId: workspace.id,
          conversationId: conversation.id,
          senderType: index % 2 === 0 ? "user" : "agent",
          senderId: index % 2 === 0 ? "local-user" : "main-agent",
          messageType: "text",
          content: { text: `${index}:${body}` }
        },
        db
      )
    );
    const callModel = vi.fn().mockResolvedValue(
      "# Conversation Compact Summary\n\n## User Goal\n\nPreserve the implementation task."
    );

    const payload = await prepareMainAgentContext(
      {
        conversationId: conversation.id,
        config: createConfig(true),
        systemPrompt: "system"
      },
      db,
      callModel
    );

    expect(callModel).toHaveBeenCalledTimes(1);
    expect(payload.usage.contextRatio).toBeLessThan(0.95);
    expect(payload.messages).toHaveLength(RECENT_RAW_MESSAGE_LIMIT + 1);
    expect(payload.messages[0].role).toBe("system");
    expect(payload.messages.slice(1).map((message) => message.content)).toEqual(
      savedMessages.slice(-RECENT_RAW_MESSAGE_LIMIT).map((message) =>
        (message.content as { text: string }).text
      )
    );

    const summaries = getConversationCompactSummaries(conversation.id, db);
    expect(summaries).toHaveLength(1);
    expect(summaries[0]).toMatchObject({
      conversationId: conversation.id,
      coveredMessageStartId: savedMessages[0].id,
      coveredMessageEndId: savedMessages[9].id
    });

    const reusedPayload = buildMainAgentContextPayload(
      {
        conversationId: conversation.id,
        config: createConfig(true),
        systemPrompt: "system"
      },
      db
    );
    expect(reusedPayload.messages).toEqual(payload.messages);

    createConversationCompactSummary(
      {
        conversationId: conversation.id,
        coveredMessageStartId: "missing-start",
        coveredMessageEndId: "missing-end",
        summary: "invalid newer summary"
      },
      db
    );

    const fallbackPayload = buildMainAgentContextPayload(
      {
        conversationId: conversation.id,
        config: createConfig(),
        systemPrompt: "system"
      },
      db
    );
    expect(fallbackPayload.messages).toEqual(payload.messages);
  });

  it("blocks an oversized recent tail after at most two compact attempts", async () => {
    const { db, workspace, conversation } = setupConversation();
    const body = "x".repeat(55_000);

    for (let index = 0; index < 30; index += 1) {
      createMessage(
        {
          workspaceId: workspace.id,
          conversationId: conversation.id,
          senderType: index % 2 === 0 ? "user" : "agent",
          senderId: index % 2 === 0 ? "local-user" : "main-agent",
          messageType: "text",
          content: { text: `${index}:${body}` }
        },
        db
      );
    }

    const callModel = vi.fn().mockResolvedValue(
      "# Conversation Compact Summary\n\n## User Goal\n\nPreserve the implementation task."
    );

    await expect(
      prepareMainAgentContext(
        {
          conversationId: conversation.id,
          config: createConfig(),
          systemPrompt: "system"
        },
        db,
        callModel
      )
    ).rejects.toThrow(
      "当前上下文已超过模型配置的上下文窗口限制，自动压缩后仍无法放入 256K context。"
    );

    expect(callModel).toHaveBeenCalledTimes(2);
    expect(getConversationCompactSummaries(conversation.id, db)).toHaveLength(2);
  });
});
