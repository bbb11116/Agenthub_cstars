import { getDatabase, type AgentHubDatabase } from "../db";

const DEFAULT_STALE_RUNNING_MS = 12 * 60 * 60 * 1000;
const STALE_RUN_MESSAGE = "Recovered stale running Agent run.";
const STALE_CONVERSATION_RUN_MESSAGE = "Recovered stale running conversation run.";

export type StaleRunRecoveryResult = {
  recoveredAgentRuns: number;
  recoveredConversationRuns: number;
  recoveredAgents: number;
};

export function recoverStaleRunningAgentState(
  db: AgentHubDatabase = getDatabase(),
  options: {
    now?: Date;
    staleAfterMs?: number;
  } = {}
): StaleRunRecoveryResult {
  const now = options.now ?? new Date();
  const staleAfterMs = options.staleAfterMs ?? DEFAULT_STALE_RUNNING_MS;
  const nowIso = now.toISOString();
  const cutoffIso = new Date(now.getTime() - staleAfterMs).toISOString();

  const recover = db.transaction((): StaleRunRecoveryResult => {
    const recoveredConversationRuns = db
      .prepare(
        `UPDATE conversation_runs
         SET status = 'cancelled',
             ended_at = @nowIso,
             error_message = COALESCE(error_message, @message)
         WHERE status = 'running'
           AND started_at < @cutoffIso`
      )
      .run({
        nowIso,
        cutoffIso,
        message: STALE_CONVERSATION_RUN_MESSAGE
      }).changes;

    const recoveredAgentRuns = db
      .prepare(
        `UPDATE agent_runs
         SET status = 'failed',
             ended_at = @nowIso,
             error_message = COALESCE(error_message, @message)
         WHERE status = 'running'
           AND started_at < @cutoffIso
           AND NOT EXISTS (
             SELECT 1
             FROM conversation_runs
             WHERE conversation_runs.conversation_id = agent_runs.conversation_id
               AND conversation_runs.status = 'running'
           )`
      )
      .run({
        nowIso,
        cutoffIso,
        message: STALE_RUN_MESSAGE
      }).changes;

    const recoveredAgents = db
      .prepare(
        `UPDATE agents
         SET status = 'error',
             updated_at = @nowIso
         WHERE status = 'running'
           AND NOT EXISTS (
             SELECT 1
             FROM agent_runs
             WHERE agent_runs.agent_id = agents.id
               AND agent_runs.status = 'running'
           )
           AND NOT EXISTS (
             SELECT 1
             FROM conversation_runs
             WHERE conversation_runs.agent_id = agents.id
               AND conversation_runs.status = 'running'
           )`
      )
      .run({ nowIso }).changes;

    return {
      recoveredAgentRuns,
      recoveredConversationRuns,
      recoveredAgents
    };
  });

  return recover();
}
