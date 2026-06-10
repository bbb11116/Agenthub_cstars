import type { AgentRunInput } from "../../shared/agentAdapter";
import type { Message } from "../../shared/domain";
import { getDatabase, type AgentHubDatabase } from "../db";
import {
  getLatestConversationCompactSummary,
  type ConversationCompactSummary
} from "../db/repositories/conversationCompactSummaryRepo";
import { getMessagesByConversation } from "../db/repositories/messageRepo";
import { estimateTokens } from "./tokenEstimator";

export { estimateTokens } from "./tokenEstimator";

export const DEFAULT_CONTEXT_SAFETY_MARGIN_TOKENS = 1_024;
const MESSAGE_OVERHEAD_TOKENS = 6;

export type ContextBudget = {
  contextWindowTokens: number;
  reservedOutputTokens: number;
  safetyMarginTokens?: number;
};

export type BuildConversationContextInput = {
  currentUserMessage?: string;
  systemPrompt?: string;
  workspaceInfo?: string;
  budget: ContextBudget;
};

export type BuildConversationContextForAgentRunInput =
  BuildConversationContextInput & {
    conversationId: string;
  };

export type ConversationContextResult = {
  contextMessages: NonNullable<AgentRunInput["contextMessages"]>;
  availableInputTokens: number;
  estimatedInputTokens: number;
};

function getMessageText(message: Message): string {
  if (
    typeof message.content === "object" &&
    message.content !== null &&
    "text" in message.content &&
    typeof (message.content as { text?: unknown }).text === "string"
  ) {
    return (message.content as { text: string }).text;
  }

  return JSON.stringify(message.content);
}

function getMessageRole(message: Message): "user" | "assistant" | "system" {
  return message.senderType === "agent" ? "assistant" : message.senderType;
}

function estimateMessageTokens(content: string): number {
  return MESSAGE_OVERHEAD_TOKENS + estimateTokens(content);
}

function truncateToTokenBudget(text: string, maxTokens: number): string {
  if (maxTokens <= 0 || !text) {
    return "";
  }
  if (estimateTokens(text) <= maxTokens) {
    return text;
  }

  const characters = [...text];
  let low = 0;
  let high = characters.length;

  while (low < high) {
    const mid = Math.ceil((low + high) / 2);
    if (estimateTokens(characters.slice(0, mid).join("")) <= maxTokens) {
      low = mid;
    } else {
      high = mid - 1;
    }
  }

  return characters.slice(0, low).join("");
}

function fitSystemContext(
  label: string,
  text: string | undefined,
  remainingTokens: number
): { message?: NonNullable<AgentRunInput["contextMessages"]>[number]; tokens: number } {
  if (!text || remainingTokens <= MESSAGE_OVERHEAD_TOKENS) {
    return { tokens: 0 };
  }

  const prefix = `${label}\n`;
  const maxContentTokens = remainingTokens - MESSAGE_OVERHEAD_TOKENS;
  const content = truncateToTokenBudget(
    prefix + text,
    maxContentTokens
  );

  if (!content) {
    return { tokens: 0 };
  }

  return {
    message: { role: "system", content },
    tokens: estimateMessageTokens(content)
  };
}

function getHistoryStartIndex(
  messages: Message[],
  summary: ConversationCompactSummary | null
): number {
  if (!summary) {
    return 0;
  }

  const coveredEndIndex = messages.findIndex(
    (message) => message.id === summary.coveredMessageEndId
  );
  return coveredEndIndex === -1 ? 0 : coveredEndIndex + 1;
}

export function buildConversationContext(
  input: BuildConversationContextInput & {
    messages: Message[];
    summary?: ConversationCompactSummary | null;
  }
): ConversationContextResult {
  const safetyMarginTokens =
    input.budget.safetyMarginTokens ?? DEFAULT_CONTEXT_SAFETY_MARGIN_TOKENS;
  const availableInputTokens = Math.max(
    0,
    input.budget.contextWindowTokens -
      input.budget.reservedOutputTokens -
      safetyMarginTokens
  );
  const currentUserTokens = input.currentUserMessage
    ? estimateMessageTokens(input.currentUserMessage)
    : 0;
  let estimatedInputTokens = input.systemPrompt ? estimateTokens(input.systemPrompt) : 0;
  let remainingTokens = Math.max(
    0,
    availableInputTokens - estimatedInputTokens - currentUserTokens
  );
  const contextMessages: NonNullable<AgentRunInput["contextMessages"]> = [];

  const workspace = fitSystemContext(
    "Workspace context:",
    input.workspaceInfo,
    remainingTokens
  );
  if (workspace.message) {
    contextMessages.push(workspace.message);
    remainingTokens -= workspace.tokens;
    estimatedInputTokens += workspace.tokens;
  }

  const summary = fitSystemContext(
    "Conversation compact summary:",
    input.summary?.summary,
    remainingTokens
  );
  if (summary.message) {
    contextMessages.push(summary.message);
    remainingTokens -= summary.tokens;
    estimatedInputTokens += summary.tokens;
  }

  const selectedHistory: NonNullable<AgentRunInput["contextMessages"]> = [];
  const historyStartIndex = getHistoryStartIndex(input.messages, input.summary ?? null);
  let skippedPersistedCurrentUserMessage = false;

  for (let index = input.messages.length - 1; index >= historyStartIndex; index -= 1) {
    const message = input.messages[index];
    const content = getMessageText(message);

    if (
      !skippedPersistedCurrentUserMessage &&
      input.currentUserMessage !== undefined &&
      message.senderType === "user" &&
      content === input.currentUserMessage
    ) {
      skippedPersistedCurrentUserMessage = true;
      continue;
    }

    const tokens = estimateMessageTokens(content);
    if (tokens > remainingTokens) {
      break;
    }

    selectedHistory.unshift({
      role: getMessageRole(message),
      content,
      createdAt: message.createdAt
    });
    remainingTokens -= tokens;
    estimatedInputTokens += tokens;
  }

  contextMessages.push(...selectedHistory);
  if (input.currentUserMessage !== undefined) {
    contextMessages.push({
      role: "user",
      content: input.currentUserMessage
    });
    estimatedInputTokens += currentUserTokens;
  }

  return {
    contextMessages,
    availableInputTokens,
    estimatedInputTokens
  };
}

export function buildConversationContextForAgentRun(
  input: BuildConversationContextForAgentRunInput,
  db: AgentHubDatabase = getDatabase()
): ConversationContextResult {
  return buildConversationContext({
    ...input,
    messages: getMessagesByConversation(input.conversationId, db),
    summary: getLatestConversationCompactSummary(input.conversationId, db)
  });
}
