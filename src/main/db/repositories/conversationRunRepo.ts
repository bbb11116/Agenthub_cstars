import { randomUUID } from "node:crypto";
import type { ConversationRun, ConversationRunStatus } from "../../../shared/agentRunEvent";
import { getDatabase, type AgentHubDatabase } from "../index";

type ConversationRunDbRow = {
  id: string;
  conversation_id: string;
  agent_id: string;
  status: string;
  started_at: string;
  ended_at: string | null;
  error_message: string | null;
};

function toRun(row: ConversationRunDbRow): ConversationRun {
  return {
    id: row.id,
    conversationId: row.conversation_id,
    agentId: row.agent_id,
    status: row.status as ConversationRunStatus,
    startedAt: row.started_at,
    endedAt: row.ended_at,
    errorMessage: row.error_message
  };
}

export function createConversationRun(
  input: {
    conversationId: string;
    agentId: string;
  },
  db: AgentHubDatabase = getDatabase()
): ConversationRun {
  // Close any stale running rows for the conversation. The partial unique
  // index lets only one 'running' row at a time, so this also prevents a
  // UNIQUE constraint failure on the second creation attempt.
  db.prepare(
    `UPDATE conversation_runs
       SET status = 'cancelled', ended_at = ?
     WHERE conversation_id = ? AND status = 'running'`
  ).run(new Date().toISOString(), input.conversationId);

  const run: ConversationRun = {
    id: randomUUID(),
    conversationId: input.conversationId,
    agentId: input.agentId,
    status: "running",
    startedAt: new Date().toISOString(),
    endedAt: null,
    errorMessage: null
  };

  db.prepare(`
    INSERT INTO conversation_runs (id, conversation_id, agent_id, status, started_at, ended_at, error_message)
    VALUES (@id, @conversation_id, @agent_id, @status, @started_at, @ended_at, @error_message)
  `).run({
    id: run.id,
    conversation_id: run.conversationId,
    agent_id: run.agentId,
    status: run.status,
    started_at: run.startedAt,
    ended_at: run.endedAt,
    error_message: run.errorMessage
  });

  return run;
}

export function completeConversationRun(
  runId: string,
  status: "completed" | "cancelled",
  db: AgentHubDatabase = getDatabase()
): void {
  db.prepare(
    "UPDATE conversation_runs SET status = ?, ended_at = ? WHERE id = ?"
  ).run(status, new Date().toISOString(), runId);
}

export function failConversationRun(
  runId: string,
  errorMessage: string,
  db: AgentHubDatabase = getDatabase()
): void {
  db.prepare(
    "UPDATE conversation_runs SET status = 'failed', ended_at = ?, error_message = ? WHERE id = ?"
  ).run(new Date().toISOString(), errorMessage, runId);
}

export function getActiveConversationRun(
  conversationId: string,
  db: AgentHubDatabase = getDatabase()
): ConversationRun | null {
  const row = db
    .prepare<[string], ConversationRunDbRow>(
      "SELECT * FROM conversation_runs WHERE conversation_id = ? AND status = 'running' LIMIT 1"
    )
    .get(conversationId);
  return row ? toRun(row) : null;
}

export function getConversationRunById(
  runId: string,
  db: AgentHubDatabase = getDatabase()
): ConversationRun | null {
  const row = db
    .prepare<[string], ConversationRunDbRow>(
      "SELECT * FROM conversation_runs WHERE id = ?"
    )
    .get(runId);
  return row ? toRun(row) : null;
}
