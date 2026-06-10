import { randomUUID } from "node:crypto";
import type { GroupRunEvent, GroupRunEventType } from "../../../shared/groupChat";
import { getDatabase, stringifyJsonField, type AgentHubDatabase } from "../index";

type GroupRunEventDbRow = {
  id: string;
  group_run_id: string;
  conversation_id: string;
  seq: number;
  type: string;
  payload_json: string;
  created_at: string;
};

function toEvent(row: GroupRunEventDbRow): GroupRunEvent {
  return {
    id: row.id,
    groupRunId: row.group_run_id,
    conversationId: row.conversation_id,
    seq: row.seq,
    type: row.type as GroupRunEventType,
    createdAt: row.created_at,
    payload: JSON.parse(row.payload_json)
  } as GroupRunEvent;
}

function getNextSeq(groupRunId: string, db: AgentHubDatabase): number {
  const row = db
    .prepare<[string], { seq: number | null }>(
      "SELECT MAX(seq) AS seq FROM group_run_events WHERE group_run_id = ?"
    )
    .get(groupRunId);

  return (row?.seq ?? 0) + 1;
}

export function createGroupRunEvent(
  input: {
    groupRunId: string;
    conversationId: string;
    type: GroupRunEventType;
    payload: GroupRunEvent["payload"];
  },
  db: AgentHubDatabase = getDatabase()
): GroupRunEvent {
  const event = {
    id: randomUUID(),
    groupRunId: input.groupRunId,
    conversationId: input.conversationId,
    seq: getNextSeq(input.groupRunId, db),
    type: input.type,
    createdAt: new Date().toISOString(),
    payload: input.payload
  } as GroupRunEvent;

  db.prepare(`
    INSERT INTO group_run_events (
      id, group_run_id, conversation_id, seq, type, payload_json, created_at
    )
    VALUES (
      @id, @groupRunId, @conversationId, @seq, @type, @payloadJson, @createdAt
    )
  `).run({
    id: event.id,
    groupRunId: event.groupRunId,
    conversationId: event.conversationId,
    seq: event.seq,
    type: event.type,
    payloadJson: stringifyJsonField(event.payload),
    createdAt: event.createdAt
  });

  return event;
}

export function getGroupRunEventsByRun(
  groupRunId: string,
  db: AgentHubDatabase = getDatabase()
): GroupRunEvent[] {
  return db
    .prepare<[string], GroupRunEventDbRow>(
      "SELECT * FROM group_run_events WHERE group_run_id = ? ORDER BY seq ASC"
    )
    .all(groupRunId)
    .map(toEvent);
}

export function getGroupRunEventsByConversation(
  conversationId: string,
  db: AgentHubDatabase = getDatabase()
): GroupRunEvent[] {
  return db
    .prepare<[string], GroupRunEventDbRow>(
      "SELECT * FROM group_run_events WHERE conversation_id = ? ORDER BY created_at ASC, seq ASC"
    )
    .all(conversationId)
    .map(toEvent);
}
