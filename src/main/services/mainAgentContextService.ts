import type { Message } from "../../shared/domain";
import {
  ONE_MILLION_CONTEXT_WINDOW_TOKENS,
  type ContextUsage
} from "../../shared/modelProvider";
import { getDatabase, type AgentHubDatabase } from "../db";
import {
  createConversationCompactSummary,
  getConversationCompactSummaries,
  type ConversationCompactSummary
} from "../db/repositories/conversationCompactSummaryRepo";
import { getDiffProposalsByConversation } from "../db/repositories/diffRepo";
import { getMessagesByConversation } from "../db/repositories/messageRepo";
import type { MainAgentModelConfig } from "./configService";
import {
  calculateContextUsage,
  callLLM,
  estimateInputTokens,
  LLMError
} from "./llmRouter";

export const RECENT_RAW_MESSAGE_LIMIT = 20;
const MAX_COMPACT_ATTEMPTS = 2;
const COMPACT_TRIGGER_RATIO = 0.95;

export type MainAgentLLMMessage = {
  role: "user" | "assistant" | "system";
  content: string;
};

export type MainAgentContextPayload = {
  systemPrompt: string;
  messages: MainAgentLLMMessage[];
  usage: ContextUsage;
};

type CompactModelCaller = typeof callLLM;

type SummaryCoverage = {
  startIndex: number;
  endIndex: number;
};

const COMPACT_SYSTEM_PROMPT = `You compact AgentHub conversation history into durable coding-agent working memory.

Return only the structured summary. Do not add commentary or markdown fences.
Preserve facts that can still affect later implementation work. Do not invent requirements.
Remove greetings, repetition, and low-value chatter. Keep the result compact and stable so it can be compacted again later.

Use exactly these sections:
# Conversation Compact Summary

## User Goal

## Confirmed Decisions

## Architecture Constraints

## Implemented So Far

## Pending Work

## Bugs / Risks

## Important Files / Symbols

## DiffProposal State

## Open Questions`;

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

function formatRawMessageForLLM(message: Message): MainAgentLLMMessage {
  return {
    role: message.senderType === "agent" ? "assistant" : message.senderType,
    content: getMessageText(message)
  };
}

function findSummaryCoverage(
  allMessages: Message[],
  summary: ConversationCompactSummary | null
): SummaryCoverage | null {
  if (!summary) {
    return null;
  }

  const startIndex = allMessages.findIndex(
    (message) => message.id === summary.coveredMessageStartId
  );
  const endIndex = allMessages.findIndex(
    (message) => message.id === summary.coveredMessageEndId
  );

  if (startIndex === -1 || endIndex === -1 || startIndex > endIndex) {
    return null;
  }

  return { startIndex, endIndex };
}

function getLatestValidSummary(
  conversationId: string,
  allMessages: Message[],
  db: AgentHubDatabase
): ConversationCompactSummary | null {
  const summaries = getConversationCompactSummaries(conversationId, db);

  for (let index = summaries.length - 1; index >= 0; index -= 1) {
    if (findSummaryCoverage(allMessages, summaries[index])) {
      return summaries[index];
    }
  }

  return null;
}

export function buildMainAgentConversationMessages(
  allMessages: Message[],
  summary: ConversationCompactSummary | null
): MainAgentLLMMessage[] {
  const coverage = findSummaryCoverage(allMessages, summary);
  const recentStartIndex = Math.max(0, allMessages.length - RECENT_RAW_MESSAGE_LIMIT);
  const messages: MainAgentLLMMessage[] = [];

  if (summary && coverage) {
    messages.push({
      role: "system",
      content: [
        "The following persisted compact summary is durable working memory for earlier messages.",
        "Use it as prior conversation context. The raw messages that follow take precedence if details conflict.",
        "",
        summary.summary
      ].join("\n")
    });
  }

  for (let index = 0; index < allMessages.length; index += 1) {
    if (coverage && index <= coverage.endIndex && index < recentStartIndex) {
      continue;
    }
    messages.push(formatRawMessageForLLM(allMessages[index]));
  }

  return messages;
}

export function buildMainAgentContextPayload(
  input: {
    conversationId: string;
    config: MainAgentModelConfig;
    systemPrompt: string;
  },
  db: AgentHubDatabase = getDatabase()
): MainAgentContextPayload {
  const allMessages = getMessagesByConversation(input.conversationId, db);
  const summary = getLatestValidSummary(input.conversationId, allMessages, db);
  const messages = buildMainAgentConversationMessages(allMessages, summary);

  return {
    systemPrompt: input.systemPrompt,
    messages,
    usage: calculateContextUsage(input.config, input.systemPrompt, messages)
  };
}

function buildCompactUserPrompt(input: {
  previousSummary: ConversationCompactSummary | null;
  rawMessages: Message[];
  attempt: number;
  pendingDiffs: Array<{
    id: string;
    filePath: string;
    status: string;
  }>;
}): string {
  const compactStrength = input.attempt === 1
    ? "Compress aggressively. Preserve decisions and actionable state, but minimize prose."
    : "This is a second pass. Compress even more aggressively and keep only durable facts needed for future work.";
  const parts = [
    compactStrength,
    "Aim to leave the next model request at or below 50% of its configured context window.",
    "Keep the user's long-term goal, current task, confirmed product decisions, architecture boundaries, data structures, UI behavior, implemented work, pending work, bugs, risks, important paths and symbols, unapplied DiffProposal state, and the user's latest confirmed choices.",
    "Do not include requirements that never appeared in the source material."
  ];

  if (input.previousSummary) {
    parts.push("", "## Previous Compact Summary", input.previousSummary.summary);
  }

  if (input.rawMessages.length > 0) {
    parts.push("", "## Additional Raw Messages");
    for (const message of input.rawMessages) {
      parts.push(
        `[messageId=${message.id} sender=${message.senderType} type=${message.messageType}]`,
        getMessageText(message)
      );
    }
  }

  parts.push(
    "",
    "## Current Persisted State",
    JSON.stringify({
      pendingDiffProposals: input.pendingDiffs
    })
  );

  return parts.join("\n");
}

async function compactEarlierHistory(
  input: {
    conversationId: string;
    config: MainAgentModelConfig;
    attempt: number;
  },
  db: AgentHubDatabase,
  callModel: CompactModelCaller
): Promise<ConversationCompactSummary | null> {
  const allMessages = getMessagesByConversation(input.conversationId, db);
  const previousSummary = getLatestValidSummary(input.conversationId, allMessages, db);
  const coverage = findSummaryCoverage(allMessages, previousSummary);
  const recentStartIndex = Math.max(0, allMessages.length - RECENT_RAW_MESSAGE_LIMIT);
  const compactEndIndex = recentStartIndex - 1;

  if (compactEndIndex < 0) {
    return null;
  }

  const rawStartIndex = coverage ? coverage.endIndex + 1 : 0;
  const rawMessages = allMessages.slice(rawStartIndex, recentStartIndex);

  if (!previousSummary && rawMessages.length === 0) {
    return null;
  }

  const pendingDiffs = getDiffProposalsByConversation(input.conversationId, db)
    .filter((proposal) => proposal.status === "pending")
    .map((proposal) => ({
      id: proposal.id,
      filePath: proposal.filePath,
      status: proposal.status
    }));
  const compactUserPrompt = buildCompactUserPrompt({
    previousSummary,
    rawMessages,
    attempt: input.attempt,
    pendingDiffs
  });

  let summaryText: string;
  try {
    summaryText = await callModel(
      input.config,
      COMPACT_SYSTEM_PROMPT,
      [{ role: "user", content: compactUserPrompt }]
    );
  } catch (error) {
    throw new LLMError(
      `自动压缩上下文失败，未发送模型请求: ${error instanceof Error ? error.message : "unknown error"}`
    );
  }

  if (!summaryText.trim()) {
    throw new LLMError("自动压缩上下文失败，未发送模型请求: 模型返回了空摘要。");
  }

  const coveredStartMessage = previousSummary
    ? allMessages[coverage!.startIndex]
    : rawMessages[0];
  const coveredEndMessage = allMessages[Math.max(compactEndIndex, coverage?.endIndex ?? -1)];

  return createConversationCompactSummary(
    {
      conversationId: input.conversationId,
      coveredMessageStartId: coveredStartMessage.id,
      coveredMessageEndId: coveredEndMessage.id,
      summary: summaryText.trim(),
      summaryTokens: estimateInputTokens(summaryText),
      rawTokensBeforeCompact: estimateInputTokens({
        previousSummary: previousSummary?.summary ?? "",
        rawMessages: rawMessages.map((message) => ({
          senderType: message.senderType,
          messageType: message.messageType,
          content: getMessageText(message)
        })),
        pendingDiffs
      })
    },
    db
  );
}

function createOverflowError(usage: ContextUsage): LLMError {
  if (usage.contextWindowTokens >= ONE_MILLION_CONTEXT_WINDOW_TOKENS) {
    return new LLMError(
      "当前上下文已超过 1M context 配置上限，自动压缩后仍无法放入。请减少文件内容、清理终端输出，或新建会话。"
    );
  }

  return new LLMError(
    "当前上下文已超过模型配置的上下文窗口限制，自动压缩后仍无法放入 256K context。请减少文件内容、清理终端输出、开启 1M 上下文，或新建会话。"
  );
}

export async function prepareMainAgentContext(
  input: {
    conversationId: string;
    config: MainAgentModelConfig;
    systemPrompt: string;
  },
  db: AgentHubDatabase = getDatabase(),
  callModel: CompactModelCaller = callLLM
): Promise<MainAgentContextPayload> {
  let payload = buildMainAgentContextPayload(input, db);
  let compactAttempts = 0;

  while (
    payload.usage.contextRatio >= COMPACT_TRIGGER_RATIO &&
    compactAttempts < MAX_COMPACT_ATTEMPTS
  ) {
    const compactSummary = await compactEarlierHistory(
      {
        conversationId: input.conversationId,
        config: input.config,
        attempt: compactAttempts + 1
      },
      db,
      callModel
    );

    if (!compactSummary) {
      break;
    }

    compactAttempts += 1;
    payload = buildMainAgentContextPayload(input, db);
  }

  if (payload.usage.contextRatio >= 1) {
    throw createOverflowError(payload.usage);
  }

  return payload;
}
