import { describe, expect, it } from "vitest";
import type { Message } from "../../shared/domain";
import type { ConversationCompactSummary } from "../db/repositories/conversationCompactSummaryRepo";
import {
  buildConversationContext,
  estimateTokens
} from "./conversationContextService";

function createMessage(index: number, text: string): Message {
  return {
    id: `message-${index}`,
    workspaceId: "workspace",
    conversationId: "conversation",
    senderType: index % 2 === 0 ? "user" : "agent",
    senderId: index % 2 === 0 ? "local-user" : "agent",
    messageType: "text",
    content: { text },
    createdAt: new Date(index * 1_000).toISOString()
  };
}

const budget = {
  contextWindowTokens: 500,
  reservedOutputTokens: 50,
  safetyMarginTokens: 20
};

describe("conversationContextService", () => {
  it("does not significantly underestimate CJK text", () => {
    expect(estimateTokens("中文上下文预算管理")).toBeGreaterThanOrEqual(8);
    expect(estimateTokens("abcdefgh")).toBe(2);
  });

  it("always preserves the current user message when the budget is exceeded", () => {
    const currentUserMessage = "必须保留".repeat(100);
    const result = buildConversationContext({
      messages: [],
      currentUserMessage,
      systemPrompt: "system",
      workspaceInfo: "workspace".repeat(100),
      budget: {
        contextWindowTokens: 20,
        reservedOutputTokens: 10,
        safetyMarginTokens: 5
      }
    });

    expect(result.contextMessages.at(-1)).toEqual({
      role: "user",
      content: currentUserMessage
    });
  });

  it("includes the latest summary and favors newer history", () => {
    const messages = Array.from({ length: 30 }, (_, index) =>
      createMessage(index, `history-${index}-${"x".repeat(28)}`)
    );
    const summary: ConversationCompactSummary = {
      id: "summary",
      conversationId: "conversation",
      coveredMessageStartId: "message-0",
      coveredMessageEndId: "message-9",
      summary: "Earlier decisions.",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    };
    const result = buildConversationContext({
      messages,
      summary,
      currentUserMessage: "current request",
      systemPrompt: "system",
      workspaceInfo: "workspace",
      budget: {
        contextWindowTokens: 250,
        reservedOutputTokens: 50,
        safetyMarginTokens: 20
      }
    });
    const contents = result.contextMessages.map((message) => message.content);

    expect(contents.some((content) => content.includes("Earlier decisions."))).toBe(true);
    expect(contents).toContain("history-29-" + "x".repeat(28));
    expect(contents).not.toContain("history-10-" + "x".repeat(28));
    expect(contents.at(-1)).toBe("current request");
  });

  it("can include more than 20 short history messages", () => {
    const messages = Array.from({ length: 30 }, (_, index) =>
      createMessage(index, `m${index}`)
    );
    const result = buildConversationContext({
      messages,
      currentUserMessage: "current",
      budget: {
        contextWindowTokens: 1_000,
        reservedOutputTokens: 50,
        safetyMarginTokens: 20
      }
    });

    expect(result.contextMessages).toHaveLength(31);
  });

  it("truncates workspace or summary context before dropping the current user message", () => {
    const result = buildConversationContext({
      messages: [],
      currentUserMessage: "current",
      workspaceInfo: "w".repeat(500),
      summary: {
        id: "summary",
        conversationId: "conversation",
        coveredMessageStartId: "message-0",
        coveredMessageEndId: "message-0",
        summary: "s".repeat(500),
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString()
      },
      budget: {
        contextWindowTokens: 60,
        reservedOutputTokens: 10,
        safetyMarginTokens: 5
      }
    });

    expect(result.contextMessages.at(-1)).toEqual({
      role: "user",
      content: "current"
    });
    expect(result.contextMessages.some((message) => message.content.length < 500)).toBe(true);
  });
});
