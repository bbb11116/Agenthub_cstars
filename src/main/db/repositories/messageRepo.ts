import { randomUUID } from "node:crypto";
import type { CreateMessageInput, Message } from "../../../shared/domain";
import type { MessageStatus } from "../../../shared/groupChat";
import {
  getDatabase,
  parseJsonField,
  stringifyJsonField,
  type AgentHubDatabase
} from "../index";

type MessageRow = {
  id: string;
  workspace_id: string;
  conversation_id: string;
  sender_type: Message["senderType"];
  sender_id: string;
  message_type: Message["messageType"];
  content: string;
  created_at: string;
  status: string;
  mention_agent_ids: string | null;
  dispatch_run_id: string | null;
  dispatch_step_id: string | null;
  reply_to_message_id: string | null;
  updated_at: string | null;
  metadata: string | null;
  thinking_markdown: string;
};

function toMessage(row: MessageRow): Message {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    conversationId: row.conversation_id,
    senderType: row.sender_type,
    senderId: row.sender_id,
    messageType: row.message_type,
    content: parseJsonField<unknown>(row.content, {}, "messages.content"),
    createdAt: row.created_at,
    status: (row.status ?? "completed") as Message["status"],
    mentionAgentIds: row.mention_agent_ids
      ? parseJsonField<string[]>(row.mention_agent_ids, [], "messages.mention_agent_ids")
      : null,
    dispatchRunId: row.dispatch_run_id ?? null,
    dispatchStepId: row.dispatch_step_id ?? null,
    replyToMessageId: row.reply_to_message_id ?? null,
    updatedAt: row.updated_at ?? null,
    metadata: row.metadata
      ? parseJsonField<Record<string, unknown>>(row.metadata, {}, "messages.metadata")
      : null,
    thinking: row.thinking_markdown ?? ""
  };
}

export function createMessage(
  input: CreateMessageInput,
  db: AgentHubDatabase = getDatabase()
): Message {
  const message: Message = {
    id: randomUUID(),
    workspaceId: input.workspaceId,
    conversationId: input.conversationId,
    senderType: input.senderType,
    senderId: input.senderId,
    messageType: input.messageType,
    content: input.content,
    createdAt: new Date().toISOString(),
    status: input.status ?? "completed",
    mentionAgentIds: input.mentionAgentIds ?? null,
    dispatchRunId: input.dispatchRunId ?? null,
    dispatchStepId: input.dispatchStepId ?? null,
    replyToMessageId: input.replyToMessageId ?? null,
    updatedAt: null,
    metadata: input.metadata ?? null
  };

  db.prepare(`
    INSERT INTO messages (
      id,
      workspace_id,
      conversation_id,
      sender_type,
      sender_id,
      message_type,
      content,
      created_at,
      status,
      mention_agent_ids,
      dispatch_run_id,
      dispatch_step_id,
      reply_to_message_id,
      updated_at,
      metadata,
      thinking_markdown
    )
    VALUES (
      @id,
      @workspaceId,
      @conversationId,
      @senderType,
      @senderId,
      @messageType,
      @content,
      @createdAt,
      @status,
      @mentionAgentIds,
      @dispatchRunId,
      @dispatchStepId,
      @replyToMessageId,
      @updatedAt,
      @metadata,
      @thinkingMarkdown
    )
  `).run({
    ...message,
    content: stringifyJsonField(message.content),
    mentionAgentIds: message.mentionAgentIds
      ? stringifyJsonField(message.mentionAgentIds)
      : null,
    metadata: message.metadata ? stringifyJsonField(message.metadata) : null,
    thinkingMarkdown: ""
  });

  db.prepare(
    "UPDATE conversations SET last_message_at = ?, updated_at = ? WHERE id = ?"
  ).run(message.createdAt, message.createdAt, message.conversationId);

  return message;
}

export function getMessageById(id: string, db: AgentHubDatabase = getDatabase()): Message | null {
  const row = db.prepare<[string], MessageRow>("SELECT * FROM messages WHERE id = ?").get(id);
  return row ? toMessage(row) : null;
}

export function getMessagesByConversation(
  conversationId: string,
  db: AgentHubDatabase = getDatabase()
): Message[] {
  return db
    .prepare<[string], MessageRow>(
      "SELECT * FROM messages WHERE conversation_id = ? ORDER BY created_at ASC, rowid ASC"
    )
    .all(conversationId)
    .map(toMessage);
}

export function getMessageCountByConversation(
  conversationId: string,
  db: AgentHubDatabase = getDatabase()
): number {
  const row = db
    .prepare<[string], { count: number }>(
      "SELECT COUNT(*) AS count FROM messages WHERE conversation_id = ?"
    )
    .get(conversationId);

  return row?.count ?? 0;
}

export function deleteMessage(id: string, db: AgentHubDatabase = getDatabase()): boolean {
  const result = db.prepare<[string]>("DELETE FROM messages WHERE id = ?").run(id);
  return result.changes > 0;
}

export function updateMessageContent(
  id: string,
  content: unknown,
  db: AgentHubDatabase = getDatabase()
): boolean {
  const result = db
    .prepare(
      "UPDATE messages SET content = @content, updated_at = @updatedAt WHERE id = @id"
    )
    .run({
      id,
      content: stringifyJsonField(content),
      updatedAt: new Date().toISOString()
    });

  return result.changes > 0;
}

export function getRecentMessagesByConversation(
  conversationId: string,
  limit = 20,
  db: AgentHubDatabase = getDatabase()
): Message[] {
  return db
    .prepare<[string, number], MessageRow>(
      "SELECT * FROM messages WHERE conversation_id = ? ORDER BY created_at DESC, rowid DESC LIMIT ?"
    )
    .all(conversationId, limit)
    .map(toMessage)
    .reverse();
}

export function updateMessageStatus(
  id: string,
  status: MessageStatus,
  db: AgentHubDatabase = getDatabase()
): boolean {
  const result = db
    .prepare(
      "UPDATE messages SET status = @status, updated_at = @updatedAt WHERE id = @id"
    )
    .run({
      id,
      status,
      updatedAt: new Date().toISOString()
    });
  return result.changes > 0;
}

export function appendMessageMarkdown(
  id: string,
  delta: string,
  db: AgentHubDatabase = getDatabase()
): boolean {
  const existing = db
    .prepare<[string], { content: string; content_markdown: string }>(
      "SELECT content, content_markdown FROM messages WHERE id = ?"
    )
    .get(id);

  if (!existing) {
    return false;
  }

  let nextContentText: string;
  try {
    const parsed = JSON.parse(existing.content);
    nextContentText =
      parsed && typeof parsed === "object" && typeof parsed.text === "string"
        ? parsed.text + delta
        : delta;
  } catch {
    nextContentText = delta;
  }

  const nextContent = JSON.stringify({ text: nextContentText });
  const nextMarkdown = (existing.content_markdown ?? "") + delta;

  db.prepare(
    "UPDATE messages SET content = @content, content_markdown = @markdown, updated_at = @updatedAt WHERE id = @id"
  ).run({
    id,
    content: nextContent,
    markdown: nextMarkdown,
    updatedAt: new Date().toISOString()
  });
  return true;
}

export function appendMessageThinking(
  id: string,
  delta: string,
  db: AgentHubDatabase = getDatabase()
): boolean {
  if (delta.length === 0) {
    return true;
  }

  const existing = db
    .prepare<[string], { thinking_markdown: string }>(
      "SELECT thinking_markdown FROM messages WHERE id = ?"
    )
    .get(id);

  if (!existing) {
    return false;
  }

  const nextThinking = (existing.thinking_markdown ?? "") + delta;

  db.prepare(
    "UPDATE messages SET thinking_markdown = @markdown, updated_at = @updatedAt WHERE id = @id"
  ).run({
    id,
    markdown: nextThinking,
    updatedAt: new Date().toISOString()
  });
  return true;
}
