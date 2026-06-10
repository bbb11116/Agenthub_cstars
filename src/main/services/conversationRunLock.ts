import {
  getActiveConversationRun,
  createConversationRun,
  completeConversationRun,
  failConversationRun
} from "../db/repositories/conversationRunRepo";
import { getDatabase, type AgentHubDatabase } from "../db";

/**
 * In-process lock for an in-flight Agent run on a conversation. The
 * `conversation_runs` DB row with `status = 'running'` is the source of truth
 * (a partial UNIQUE index on (conversation_id) WHERE status = 'running'
 * prevents two rows). The in-process map is an optimization that avoids a DB
 * round-trip on the hot path.
 */
const activeConversationRuns = new Map<string, string>();

export class ConversationAlreadyRunningError extends Error {
  constructor(conversationId: string, runId: string) {
    super(`Conversation ${conversationId} is already running (runId=${runId}).`);
    this.name = "ConversationAlreadyRunningError";
  }
}

export type AcquiredRunLock = {
  runId: string;
  conversationId: string;
  agentId: string;
  release: (status: "completed" | "cancelled") => void;
  fail: (errorMessage: string) => void;
};

/**
 * Acquire a conversation-level run lock. Throws if another run is already
 * active for the same conversation. The caller MUST call `release()` or
 * `fail()` (typically in a finally block) — failure to do so will permanently
 * mark the conversation as busy and block future runs.
 */
export function acquireConversationRun(input: {
  conversationId: string;
  agentId: string;
  db?: AgentHubDatabase;
}): AcquiredRunLock {
  const db = input.db ?? getDatabase();

  // Fast path: an in-process run is already in flight for this conversation.
  if (activeConversationRuns.has(input.conversationId)) {
    const runId = activeConversationRuns.get(input.conversationId)!;
    throw new ConversationAlreadyRunningError(input.conversationId, runId);
  }

  // DB check: stale 'running' row from a previous crash.
  const stale = getActiveConversationRun(input.conversationId, db);
  if (stale) {
    // The in-process map is empty but the DB still says running. Treat as
    // busy — the caller (streaming service) will mark it failed/released.
    throw new ConversationAlreadyRunningError(input.conversationId, stale.id);
  }

  const run = createConversationRun(
    {
      conversationId: input.conversationId,
      agentId: input.agentId
    },
    db
  );

  activeConversationRuns.set(input.conversationId, run.id);

  let released = false;

  return {
    runId: run.id,
    conversationId: run.conversationId,
    agentId: run.agentId,
    release(status) {
      if (released) {
        return;
      }
      released = true;
      activeConversationRuns.delete(input.conversationId);
      completeConversationRun(run.id, status, db);
    },
    fail(errorMessage) {
      if (released) {
        return;
      }
      released = true;
      activeConversationRuns.delete(input.conversationId);
      failConversationRun(run.id, errorMessage, db);
    }
  };
}

/**
 * Mark a run as failed and release the lock. Safe to call from error paths.
 * Returns true if the lock was held and was released by this call.
 */
export function markRunFailed(runId: string, errorMessage: string): void {
  // Find the conversation for this run, then release the in-process entry.
  for (const [conversationId, candidateId] of activeConversationRuns.entries()) {
    if (candidateId === runId) {
      activeConversationRuns.delete(conversationId);
      break;
    }
  }
  failConversationRun(runId, errorMessage);
}

/**
 * Internal helper for tests and recovery: list conversation IDs with an
 * in-process lock currently held.
 */
export function getInProcessActiveConversations(): string[] {
  return Array.from(activeConversationRuns.keys());
}
