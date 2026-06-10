import type { Message } from "../../shared/domain";
import { getDatabase, type AgentHubDatabase } from "../db";
import {
  getByAgent,
  getByAgentExcludingGroup,
  type AgentProjectExperience
} from "../db/repositories/agentProjectExperienceRepo";
import { getAgentById } from "../db/repositories/agentRepo";
import {
  createConversationCompactSummary,
  getLatestConversationCompactSummary,
  type ConversationCompactSummary
} from "../db/repositories/conversationCompactSummaryRepo";
import {
  getConversationById,
  getFirstConversationByAgent
} from "../db/repositories/conversationRepo";
import { getMessagesByConversation } from "../db/repositories/messageRepo";
import { estimateTokens } from "./tokenEstimator";
import {
  resolveExecutionWorkspaceForAgentDirect,
  resolveExecutionWorkspaceForGroup
} from "./workspaceContextResolver";

const DIRECT_RECENT_MESSAGE_LIMIT = 20;
const GROUP_DIRECT_RECENT_MESSAGE_LIMIT = 12;
const GROUP_RECENT_MESSAGE_LIMIT = 30;
const DEFAULT_MEMORY_CHARACTER_BUDGET = 18_000;

export type GroupAssignmentMemoryContext = {
  assignment: string;
  previousAgentOutputs?: string[];
  includeDirectConversation?: boolean;
  includeGroupConversationSummary?: boolean;
  selectedGroupMessages?: Message[];
};

type RecentLayer = {
  summary: ConversationCompactSummary | null;
  recentMessages: Message[];
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

function getCoveredEndIndex(
  messages: Message[],
  summary: ConversationCompactSummary | null
): number {
  if (!summary) {
    return -1;
  }
  return messages.findIndex((message) => message.id === summary.coveredMessageEndId);
}

function formatMessages(messages: Message[]): string {
  return messages
    .map((message) => `[${message.senderType}:${message.senderId}] ${getMessageText(message)}`)
    .join("\n");
}

function compactDeterministically(
  conversationId: string,
  messages: Message[],
  summary: ConversationCompactSummary | null,
  rawMessages: Message[],
  db: AgentHubDatabase
): ConversationCompactSummary {
  const previousSummary = summary?.summary.trim();
  const incremental = formatMessages(rawMessages);
  const summaryText = [
    previousSummary ? "[Previous Summary]\n" + previousSummary : "",
    incremental ? "[Incremental Persisted Messages]\n" + incremental : ""
  ]
    .filter(Boolean)
    .join("\n\n");
  const startId = summary?.coveredMessageStartId ?? rawMessages[0].id;
  const endId = rawMessages.at(-1)?.id ?? summary!.coveredMessageEndId;

  return createConversationCompactSummary(
    {
      conversationId,
      coveredMessageStartId: startId,
      coveredMessageEndId: endId,
      summary: summaryText,
      summaryTokens: estimateTokens(summaryText),
      rawTokensBeforeCompact: estimateTokens(incremental)
    },
    db
  );
}

function ensureRecentLayer(
  conversationId: string,
  recentLimit: number,
  db: AgentHubDatabase
): RecentLayer {
  const messages = getMessagesByConversation(conversationId, db);
  let summary = getLatestConversationCompactSummary(conversationId, db);
  let coveredEndIndex = getCoveredEndIndex(messages, summary);

  if (summary && coveredEndIndex === -1) {
    summary = null;
    coveredEndIndex = -1;
  }

  const uncompactedMessages = messages.slice(coveredEndIndex + 1);
  if (uncompactedMessages.length > recentLimit) {
    const messagesToCompact = uncompactedMessages.slice(
      0,
      uncompactedMessages.length - recentLimit
    );
    summary = compactDeterministically(
      conversationId,
      messages,
      summary,
      messagesToCompact,
      db
    );
    coveredEndIndex = getCoveredEndIndex(messages, summary);
  }

  return {
    summary,
    recentMessages: messages.slice(coveredEndIndex + 1)
  };
}

function formatExperiences(experiences: AgentProjectExperience[]): string {
  return experiences
    .map((experience) => {
      const details = [
        `### ${experience.groupName}`,
        experience.summary,
        experience.responsibilities.length
          ? `Responsibilities: ${experience.responsibilities.join("; ")}`
          : "",
        experience.keyDecisions.length
          ? `Key decisions: ${experience.keyDecisions.join("; ")}`
          : "",
        experience.filesTouched.length
          ? `Files touched: ${experience.filesTouched.join(", ")}`
          : "",
        experience.unresolvedIssues.length
          ? `Unresolved: ${experience.unresolvedIssues.join("; ")}`
          : ""
      ];
      return details.filter(Boolean).join("\n");
    })
    .join("\n\n");
}

function fitSections(sections: Array<[string, string]>, budget: number): string {
  let remaining = Math.max(0, budget);
  const fitted: string[] = [];
  for (const [label, content] of sections) {
    if (!content.trim() || remaining <= 0) {
      continue;
    }
    const block = `[${label}]\n${content.trim()}`;
    const selected = block.slice(0, remaining);
    fitted.push(selected);
    remaining -= selected.length + 2;
  }
  return fitted.join("\n\n");
}

export function buildDirectAgentMemoryContext(
  agentId: string,
  conversationId: string,
  budget = DEFAULT_MEMORY_CHARACTER_BUDGET,
  db: AgentHubDatabase = getDatabase()
): string {
  const agent = getAgentById(agentId, db);
  if (!agent) {
    throw new Error("Agent not found.");
  }
  const conversation = getConversationById(conversationId, db);
  if (!conversation) {
    throw new Error("Conversation not found.");
  }
  const layer = ensureRecentLayer(conversation.id, DIRECT_RECENT_MESSAGE_LIMIT, db);
  const resolved = resolveExecutionWorkspaceForAgentDirect(agent.id, conversation.id, db);

  return fitSections(
    [
      ["Agent Profile", `${agent.name}\n${agent.description ?? ""}`],
      ["Current WorkspaceContext", resolved.rootPath],
      ["Direct Conversation Summary", layer.summary?.summary ?? ""],
      ["Recent Direct Messages", formatMessages(layer.recentMessages)],
      ["Other Group Project Experiences", formatExperiences(getByAgent(agent.id, db))]
    ],
    budget
  );
}

export function buildGroupSubAgentMemoryContext(
  agentId: string,
  groupConversationId: string,
  assignmentContext: GroupAssignmentMemoryContext,
  budget = DEFAULT_MEMORY_CHARACTER_BUDGET,
  db: AgentHubDatabase = getDatabase()
): string {
  const agent = getAgentById(agentId, db);
  if (!agent) {
    throw new Error("Agent not found.");
  }
  const directConversation = assignmentContext.includeDirectConversation
    ? getFirstConversationByAgent(agent.id, db)
    : null;
  const directLayer = directConversation
    ? ensureRecentLayer(directConversation.id, GROUP_DIRECT_RECENT_MESSAGE_LIMIT, db)
    : { summary: null, recentMessages: [] };
  const groupLayer = assignmentContext.includeGroupConversationSummary
    ? ensureRecentLayer(groupConversationId, GROUP_RECENT_MESSAGE_LIMIT, db)
    : { summary: null, recentMessages: [] };
  const resolved = resolveExecutionWorkspaceForGroup(groupConversationId, db);
  const selectedGroupMessages = assignmentContext.selectedGroupMessages ?? [];

  return fitSections(
    [
      ["Agent Profile", `${agent.name}\n${agent.description ?? ""}`],
      ["Current Assignment", assignmentContext.assignment],
      ["Current Group WorkspaceContext", resolved.rootPath],
      ["Direct Conversation Summary", directLayer.summary?.summary ?? ""],
      ["Recent Direct Messages", formatMessages(directLayer.recentMessages)],
      ["Current Group Summary", groupLayer.summary?.summary ?? ""],
      ["Selected Group Messages", formatMessages(selectedGroupMessages)],
      ["Previous Agent Outputs", (assignmentContext.previousAgentOutputs ?? []).join("\n\n")],
      [
        "Other Group Project Experiences",
        formatExperiences(getByAgentExcludingGroup(agent.id, groupConversationId, db))
      ]
    ],
    budget
  );
}
