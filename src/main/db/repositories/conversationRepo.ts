import { randomUUID } from "node:crypto";
import type {
  Conversation,
  CreateConversationInput,
  UpdateConversationInput
} from "../../../shared/domain";
import { getDatabase, type AgentHubDatabase } from "../index";

type ConversationRow = {
  id: string;
  workspace_id: string;
  workspace_context_id: string | null;
  agent_id: string;
  avatar: string | null;
  status: string;
  last_message_at: string | null;
  last_message_preview?: string | null;
  provider: string | null;
  title: string;
  mode: Conversation["mode"];
  created_at: string;
  updated_at: string;
  type: string;
  description: string;
  owner_user_id: string;
  main_agent_id: string | null;
  auto_dispatch_enabled: number;
};

function toConversation(row: ConversationRow): Conversation {
  let lastMessagePreview: string | undefined;
  if (row.last_message_preview) {
    try {
      const content = JSON.parse(row.last_message_preview) as { text?: unknown };
      lastMessagePreview = typeof content.text === "string" ? content.text : undefined;
    } catch {
      lastMessagePreview = undefined;
    }
  }
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    workspaceContextId: row.workspace_context_id ?? null,
    agentId: row.agent_id,
    avatar: row.avatar ?? null,
    status: (row.status ?? "active") as Conversation["status"],
    lastMessageAt: row.last_message_at ?? null,
    ...(lastMessagePreview === undefined ? {} : { lastMessagePreview }),
    provider: (row.provider ?? null) as Conversation["provider"],
    title: row.title,
    mode: row.mode,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    type: (row.type ?? "direct") as Conversation["type"],
    description: row.description ?? "",
    ownerUserId: row.owner_user_id ?? "local-user",
    mainAgentId: row.main_agent_id ?? null,
    autoDispatchEnabled: (row.auto_dispatch_enabled ?? 0) === 1
  };
}

export function createConversation(
  input: CreateConversationInput,
  db: AgentHubDatabase = getDatabase()
): Conversation {
  const now = new Date().toISOString();
  const conversation: Conversation = {
    id: input.id ?? randomUUID(),
    workspaceId: input.workspaceId,
    workspaceContextId: input.workspaceContextId ?? null,
    agentId: input.agentId,
    avatar: input.avatar ?? null,
    status: input.status ?? "active",
    lastMessageAt: input.lastMessageAt ?? null,
    provider: input.provider ?? null,
    title: input.title,
    mode: input.mode,
    createdAt: now,
    updatedAt: now,
    type: input.type ?? "direct",
    description: input.description ?? "",
    ownerUserId: input.ownerUserId ?? "local-user",
    mainAgentId: input.mainAgentId ?? null,
    autoDispatchEnabled: input.autoDispatchEnabled ?? false
  };

  db.prepare(`
    INSERT INTO conversations (
      id,
      workspace_id,
      workspace_context_id,
      agent_id,
      avatar,
      status,
      last_message_at,
      provider,
      title,
      mode,
      created_at,
      updated_at,
      type,
      description,
      owner_user_id,
      main_agent_id,
      auto_dispatch_enabled
    )
    VALUES (
      @id,
      @workspaceId,
      @workspaceContextId,
      @agentId,
      @avatar,
      @status,
      @lastMessageAt,
      @provider,
      @title,
      @mode,
      @createdAt,
      @updatedAt,
      @type,
      @description,
      @ownerUserId,
      @mainAgentId,
      @autoDispatchEnabled
    )
  `).run({
    ...conversation,
    provider: conversation.provider ?? null,
    autoDispatchEnabled: conversation.autoDispatchEnabled ? 1 : 0
  });

  return conversation;
}

export function getConversationById(
  id: string,
  db: AgentHubDatabase = getDatabase()
): Conversation | null {
  const row = db
    .prepare<[string], ConversationRow>("SELECT * FROM conversations WHERE id = ?")
    .get(id);

  return row ? toConversation(row) : null;
}

export function getConversationsByAgent(
  agentId: string,
  db: AgentHubDatabase = getDatabase()
): Conversation[] {
  return db
    .prepare<[string], ConversationRow>(
      "SELECT * FROM conversations WHERE agent_id = ? AND type <> 'group' ORDER BY updated_at DESC"
    )
    .all(agentId)
    .map(toConversation);
}

export function getFirstConversationByAgent(
  agentId: string,
  db: AgentHubDatabase = getDatabase()
): Conversation | null {
  const row = db
    .prepare<[string], ConversationRow>(
      "SELECT * FROM conversations WHERE agent_id = ? AND type <> 'group' ORDER BY created_at ASC LIMIT 1"
    )
    .get(agentId);

  return row ? toConversation(row) : null;
}

export function getDirectConversationByAgent(
  agentId: string,
  db: AgentHubDatabase = getDatabase()
): Conversation | null {
  const row = db
    .prepare<[string], ConversationRow>(
      "SELECT * FROM conversations WHERE agent_id = ? AND type = 'direct' AND status = 'active' ORDER BY created_at ASC LIMIT 1"
    )
    .get(agentId);
  return row ? toConversation(row) : null;
}

export function updateConversation(
  id: string,
  input: UpdateConversationInput,
  db: AgentHubDatabase = getDatabase()
): Conversation | null {
  const current = getConversationById(id, db);

  if (!current) {
    return null;
  }

  const next: Conversation = {
    ...current,
    ...input,
    updatedAt: new Date().toISOString()
  };

  db.prepare(`
    UPDATE conversations
    SET
      title = @title,
      description = @description,
      mode = @mode,
      workspace_context_id = @workspaceContextId,
      avatar = @avatar,
      status = @status,
      auto_dispatch_enabled = @autoDispatchEnabled,
      last_message_at = @lastMessageAt,
      updated_at = @updatedAt
    WHERE id = @id
  `).run({
    ...next,
    autoDispatchEnabled: next.autoDispatchEnabled ? 1 : 0
  });

  return next;
}

export function deleteConversation(id: string, db: AgentHubDatabase = getDatabase()): boolean {
  const result = db.prepare<[string]>("DELETE FROM conversations WHERE id = ?").run(id);
  return result.changes > 0;
}

export function getGroupConversationsByWorkspace(
  workspaceId: string,
  db: AgentHubDatabase = getDatabase()
): Conversation[] {
  return db
    .prepare<[string], ConversationRow>(
      "SELECT * FROM conversations WHERE workspace_id = ? AND type = 'group' ORDER BY updated_at DESC"
    )
    .all(workspaceId)
    .map(toConversation);
}

export function getGroupConversations(db: AgentHubDatabase = getDatabase()): Conversation[] {
  return db
    .prepare<[], ConversationRow>(
      "SELECT * FROM conversations WHERE type = 'group' AND status = 'active' ORDER BY COALESCE(last_message_at, updated_at) DESC"
    )
    .all()
    .map(toConversation);
}

export function getChats(db: AgentHubDatabase = getDatabase()): Conversation[] {
  return db
    .prepare<[], ConversationRow>(
      `SELECT conversations.*,
              (
                SELECT messages.content
                FROM messages
                WHERE messages.conversation_id = conversations.id
                ORDER BY messages.created_at DESC, messages.rowid DESC
                LIMIT 1
              ) AS last_message_preview
       FROM conversations
       LEFT JOIN agents ON agents.id = conversations.agent_id
       WHERE conversations.status = 'active'
         AND (
           conversations.type = 'group'
           OR (
             conversations.type = 'direct'
             AND agents.status NOT IN ('disabled', 'deleted')
           )
         )
       ORDER BY COALESCE(conversations.last_message_at, conversations.updated_at) DESC`
    )
    .all()
    .map(toConversation);
}
