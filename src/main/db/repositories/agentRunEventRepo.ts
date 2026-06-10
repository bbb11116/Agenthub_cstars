import { randomUUID } from "node:crypto";
import type { AgentRunEvent, AgentRunEventType } from "../../../shared/agentRunEvent";
import { getDatabase, stringifyJsonField, type AgentHubDatabase } from "../index";

export type AgentRunEventRow = AgentRunEvent;

type AgentRunEventDbRow = {
  id: string;
  run_id: string;
  conversation_id: string;
  seq: number;
  type: string;
  payload_json: string;
  created_at: string;
};

function toEvent(row: AgentRunEventDbRow): AgentRunEvent {
  const payload = row.payload_json ? JSON.parse(row.payload_json) : null;
  return {
    id: row.id,
    runId: row.run_id,
    conversationId: row.conversation_id,
    seq: row.seq,
    type: row.type as AgentRunEventType,
    createdAt: row.created_at,
    payload
  } as AgentRunEvent;
}

/**
 * Insert an event with idempotency on (run_id, seq). A second insert with the
 * same run_id+seq is a no-op; the caller may treat replay the same as a fresh
 * event.
 */
export function insertAgentRunEvent(
  event: AgentRunEvent,
  db: AgentHubDatabase = getDatabase()
): AgentRunEvent {
  const existing = db
    .prepare<[string, number], AgentRunEventDbRow>(
      "SELECT * FROM agent_run_events WHERE run_id = ? AND seq = ?"
    )
    .get(event.runId, event.seq);

  if (existing) {
    return toEvent(existing);
  }

  const row: AgentRunEventDbRow = {
    id: event.id,
    run_id: event.runId,
    conversation_id: event.conversationId,
    seq: event.seq,
    type: event.type,
    payload_json: stringifyJsonField(event.payload ?? null),
    created_at: event.createdAt
  };

  db.prepare(`
    INSERT INTO agent_run_events (id, run_id, conversation_id, seq, type, payload_json, created_at)
    VALUES (@id, @run_id, @conversation_id, @seq, @type, @payload_json, @created_at)
  `).run(row);

  return event;
}

export function getAgentRunEventsByRun(
  runId: string,
  db: AgentHubDatabase = getDatabase()
): AgentRunEvent[] {
  return db
    .prepare<[string], AgentRunEventDbRow>(
      "SELECT * FROM agent_run_events WHERE run_id = ? ORDER BY seq ASC"
    )
    .all(runId)
    .map(toEvent);
}

export function getAgentRunEventsByConversation(
  conversationId: string,
  db: AgentHubDatabase = getDatabase()
): AgentRunEvent[] {
  return db
    .prepare<[string], AgentRunEventDbRow>(
      "SELECT * FROM agent_run_events WHERE conversation_id = ? ORDER BY seq ASC"
    )
    .all(conversationId)
    .map(toEvent);
}

export function generateAgentRunEventId(): string {
  return randomUUID();
}
