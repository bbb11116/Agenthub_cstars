import { randomUUID } from "node:crypto";
import type {
  CommandResultPayload,
  DiffProposalPayload,
  ErrorPayload,
  FileReferencePayload,
  MessageArtifact,
  MessageArtifactType,
  ToolCallCompletedPayload,
  ToolResultPayload
} from "../../../shared/agentRunEvent";
import { getDatabase, stringifyJsonField, type AgentHubDatabase } from "../index";

type MessageArtifactDbRow = {
  id: string;
  message_id: string;
  conversation_id: string;
  type: string;
  payload_json: string;
  created_at: string;
};

function toArtifact(row: MessageArtifactDbRow): MessageArtifact {
  const payload = row.payload_json ? JSON.parse(row.payload_json) : null;
  return {
    id: row.id,
    messageId: row.message_id,
    conversationId: row.conversation_id,
    type: row.type as MessageArtifactType,
    payload,
    createdAt: row.created_at
  };
}

export function createMessageArtifact(
  input: {
    messageId: string;
    conversationId: string;
    type: MessageArtifactType;
    payload: unknown;
  },
  db: AgentHubDatabase = getDatabase()
): MessageArtifact {
  const artifact: MessageArtifact = {
    id: randomUUID(),
    messageId: input.messageId,
    conversationId: input.conversationId,
    type: input.type,
    payload: input.payload,
    createdAt: new Date().toISOString()
  };

  db.prepare(`
    INSERT INTO message_artifacts (id, message_id, conversation_id, type, payload_json, created_at)
    VALUES (@id, @message_id, @conversation_id, @type, @payload_json, @created_at)
  `).run({
    id: artifact.id,
    message_id: artifact.messageId,
    conversation_id: artifact.conversationId,
    type: artifact.type,
    payload_json: stringifyJsonField(artifact.payload),
    created_at: artifact.createdAt
  });

  return artifact;
}

export function getArtifactsByMessage(
  messageId: string,
  db: AgentHubDatabase = getDatabase()
): MessageArtifact[] {
  return db
    .prepare<[string], MessageArtifactDbRow>(
      "SELECT * FROM message_artifacts WHERE message_id = ? ORDER BY created_at ASC, rowid ASC"
    )
    .all(messageId)
    .map(toArtifact);
}

export function getArtifactsByConversation(
  conversationId: string,
  db: AgentHubDatabase = getDatabase()
): MessageArtifact[] {
  return db
    .prepare<[string], MessageArtifactDbRow>(
      "SELECT * FROM message_artifacts WHERE conversation_id = ? ORDER BY created_at ASC, rowid ASC"
    )
    .all(conversationId)
    .map(toArtifact);
}

export type { ToolCallCompletedPayload, ToolResultPayload, DiffProposalPayload, CommandResultPayload, FileReferencePayload, ErrorPayload };
