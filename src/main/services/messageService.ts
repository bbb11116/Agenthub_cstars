import type {
  Conversation,
  CreateMessageInput,
  Message,
  MessageSenderType,
  MessageType
} from "../../shared/domain";
import type { MessageArtifact } from "../../shared/agentRunEvent";
import { getDatabase, type AgentHubDatabase } from "../db";
import { getAgentById } from "../db/repositories/agentRepo";
import { getConversationById, updateConversation } from "../db/repositories/conversationRepo";
import {
  createMessage as insertMessage,
  getMessagesByConversation
} from "../db/repositories/messageRepo";
import { getArtifactsByConversation } from "../db/repositories/messageArtifactRepo";
import { getWorkspaceById } from "../db/repositories/workspaceRepo";
import { createArtifactForAgentMessage } from "./artifactService";
import { ensureMainAgentGuideMessage as ensureMainAgentGuideMessageForWorkspace } from "./conversationService";

const MESSAGE_TYPES = new Set<MessageType>([
  "text",
  "code",
  "diff_card",
  "file_card",
  "preview_card",
  "deploy_status",
  "agent_status",
  "dispatch_plan",
  "agent_assignment",
  "orchestrator_summary"
]);

const SENDER_TYPES = new Set<MessageSenderType>(["user", "agent", "system"]);

export class MessageValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MessageValidationError";
  }
}

function assertNonEmptyString(value: unknown, label: string): asserts value is string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new MessageValidationError(`${label} is required.`);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function assertTextContent(content: unknown, messageType: MessageType): void {
  if (!isRecord(content) || typeof content.text !== "string") {
    throw new MessageValidationError(`${messageType} content.text is required.`);
  }
}

function validateMessageContent(input: CreateMessageInput): void {
  switch (input.messageType) {
    case "text":
    case "dispatch_plan":
    case "agent_assignment":
    case "orchestrator_summary":
      assertTextContent(input.content, input.messageType);
      return;
    case "code":
      if (
        !isRecord(input.content) ||
        typeof input.content.language !== "string" ||
        typeof input.content.code !== "string"
      ) {
        throw new MessageValidationError("code content.language and content.code are required.");
      }
      return;
    case "diff_card":
      if (
        !isRecord(input.content) ||
        typeof input.content.diffProposalId !== "string" ||
        typeof input.content.filePath !== "string"
      ) {
        throw new MessageValidationError("diff_card content is invalid.");
      }
      return;
    case "agent_status":
      if (
        !isRecord(input.content) ||
        typeof input.content.agentId !== "string" ||
        typeof input.content.status !== "string" ||
        typeof input.content.title !== "string"
      ) {
        throw new MessageValidationError("agent_status content is invalid.");
      }
      return;
    case "file_card":
    case "preview_card":
    case "deploy_status":
      return;
  }
}

function normalizeCreateMessageInput(input: CreateMessageInput): CreateMessageInput {
  if (!input) {
    throw new MessageValidationError("Message input is required.");
  }

  assertNonEmptyString(input.workspaceId, "workspaceId");
  assertNonEmptyString(input.conversationId, "conversationId");
  assertNonEmptyString(input.senderId, "senderId");

  if (!SENDER_TYPES.has(input.senderType)) {
    throw new MessageValidationError("senderType is invalid.");
  }

  if (!MESSAGE_TYPES.has(input.messageType)) {
    throw new MessageValidationError("messageType is invalid.");
  }

  validateMessageContent(input);

  return {
    ...input,
    workspaceId: input.workspaceId.trim(),
    conversationId: input.conversationId.trim(),
    senderId: input.senderId.trim()
  };
}

function ensureMainAgentGuideMessage(
  conversation: Conversation,
  db: AgentHubDatabase
): Message | null {
  const agent = getAgentById(conversation.agentId, db);
  const workspace = getWorkspaceById(conversation.workspaceId, db);

  if (!workspace || agent?.role !== "main") {
    return null;
  }

  return ensureMainAgentGuideMessageForWorkspace(workspace, agent, conversation, db);
}

function withAgentSenderDisplayNames(
  messages: Message[],
  db: AgentHubDatabase
): Message[] {
  return messages.map((message) => {
    if (message.senderType !== "agent") {
      return message;
    }

    const senderAgent = getAgentById(message.senderId, db);
    const senderDisplayName =
      !senderAgent || senderAgent.status === "deleted"
        ? "已删除 Agent"
        : senderAgent.name;

    return {
      ...message,
      metadata: {
        ...message.metadata,
        senderDisplayName
      }
    };
  });
}

export function listMessagesByConversation(
  conversationId: string,
  db: AgentHubDatabase = getDatabase()
): Message[] {
  assertNonEmptyString(conversationId, "conversationId");
  const normalizedConversationId = conversationId.trim();
  const conversation = getConversationById(normalizedConversationId, db);

  if (!conversation) {
    return withAgentSenderDisplayNames(
      getMessagesByConversation(normalizedConversationId, db),
      db
    );
  }

  const listWithGuide = db.transaction((targetConversation: Conversation) => {
    ensureMainAgentGuideMessage(targetConversation, db);
    return getMessagesByConversation(targetConversation.id, db);
  });

  return withAgentSenderDisplayNames(listWithGuide(conversation), db);
}

export function createMessage(
  input: CreateMessageInput,
  db: AgentHubDatabase = getDatabase()
): Message {
  const normalizedInput = normalizeCreateMessageInput(input);
  const conversation = getConversationById(normalizedInput.conversationId, db);

  if (!conversation) {
    throw new MessageValidationError("Conversation not found.");
  }

  if (conversation.workspaceId !== normalizedInput.workspaceId) {
    throw new MessageValidationError("Message workspace does not match the conversation.");
  }

  const createAndTouchConversation = db.transaction((messageInput: CreateMessageInput) => {
    const message = insertMessage(messageInput, db);

    try {
      createArtifactForAgentMessage(message, db);
    } catch (error) {
      console.warn("Failed to create artifact for agent message.", error);
    }

    updateConversation(
      conversation.id,
      {
        title: conversation.title,
        mode: conversation.mode
      },
      db
    );

    return message;
  });

  return createAndTouchConversation(normalizedInput);
}

export type MessageWithArtifacts = Message & {
  artifacts: MessageArtifact[];
};

/**
 * List messages in a conversation along with their structured artifacts.
 * Used by the renderer to render Markdown body + ToolCall/DiffProposal/etc.
 * cards from the unified event protocol.
 */
export function listMessagesWithArtifactsByConversation(
  conversationId: string,
  db: AgentHubDatabase = getDatabase()
): MessageWithArtifacts[] {
  assertNonEmptyString(conversationId, "conversationId");
  const messages = listMessagesByConversation(conversationId, db);
  const artifacts = getArtifactsByConversation(conversationId, db);
  const byMessage = new Map<string, MessageArtifact[]>();
  for (const artifact of artifacts) {
    const list = byMessage.get(artifact.messageId) ?? [];
    list.push(artifact);
    byMessage.set(artifact.messageId, list);
  }
  return messages.map((message) => ({
    ...message,
    artifacts: byMessage.get(message.id) ?? []
  }));
}
