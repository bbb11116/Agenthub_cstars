import { randomUUID } from "node:crypto";
import type {
  ConversationMember,
  ConversationMemberRole,
  ConversationMemberStatus,
  ConversationMemberType
} from "../../../shared/groupChat";
import { getDatabase, type AgentHubDatabase } from "../index";

type ConversationMemberRow = {
  id: string;
  conversation_id: string;
  member_type: ConversationMemberType;
  member_id: string;
  role: ConversationMemberRole;
  status: ConversationMemberStatus;
  joined_at: string;
};

function toConversationMember(row: ConversationMemberRow): ConversationMember {
  return {
    id: row.id,
    conversationId: row.conversation_id,
    memberType: row.member_type,
    memberId: row.member_id,
    role: row.role,
    status: row.status,
    joinedAt: row.joined_at
  };
}

export type CreateConversationMemberInput = {
  conversationId: string;
  memberType: ConversationMemberType;
  memberId: string;
  role: ConversationMemberRole;
};

export function createMember(
  input: CreateConversationMemberInput,
  db: AgentHubDatabase = getDatabase()
): ConversationMember {
  const member: ConversationMember = {
    id: randomUUID(),
    conversationId: input.conversationId,
    memberType: input.memberType,
    memberId: input.memberId,
    role: input.role,
    status: "active",
    joinedAt: new Date().toISOString()
  };

  db.prepare(`
    INSERT INTO conversation_members (
      id, conversation_id, member_type, member_id, role, status, joined_at
    )
    VALUES (
      @id, @conversationId, @memberType, @memberId, @role, @status, @joinedAt
    )
  `).run(member);

  return member;
}

export function getMembersByConversation(
  conversationId: string,
  db: AgentHubDatabase = getDatabase()
): ConversationMember[] {
  return db
    .prepare<[string], ConversationMemberRow>(
      "SELECT * FROM conversation_members WHERE conversation_id = ? ORDER BY joined_at ASC"
    )
    .all(conversationId)
    .map(toConversationMember);
}

export function getActiveMembers(
  conversationId: string,
  db: AgentHubDatabase = getDatabase()
): ConversationMember[] {
  return db
    .prepare<[string], ConversationMemberRow>(
      "SELECT * FROM conversation_members WHERE conversation_id = ? AND status = 'active' ORDER BY joined_at ASC"
    )
    .all(conversationId)
    .map(toConversationMember);
}

export function getMember(
  conversationId: string,
  memberType: ConversationMemberType,
  memberId: string,
  db: AgentHubDatabase = getDatabase()
): ConversationMember | null {
  const row = db
    .prepare<[string, string, string], ConversationMemberRow>(
      "SELECT * FROM conversation_members WHERE conversation_id = ? AND member_type = ? AND member_id = ?"
    )
    .get(conversationId, memberType, memberId);

  return row ? toConversationMember(row) : null;
}

export function updateMemberStatus(
  id: string,
  status: ConversationMemberStatus,
  db: AgentHubDatabase = getDatabase()
): boolean {
  const result = db
    .prepare<[ConversationMemberStatus, string]>(
      "UPDATE conversation_members SET status = ? WHERE id = ?"
    )
    .run(status, id);
  return result.changes > 0;
}

export function deleteMember(id: string, db: AgentHubDatabase = getDatabase()): boolean {
  const result = db.prepare<[string]>("DELETE FROM conversation_members WHERE id = ?").run(id);
  return result.changes > 0;
}
