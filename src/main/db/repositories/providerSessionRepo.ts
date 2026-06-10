import { randomUUID } from "node:crypto";
import type { RuntimeProvider } from "../../../shared/runtime";
import { getDatabase, type AgentHubDatabase } from "../index";

export type ProviderSessionStatus = "active" | "missing" | "failed" | "replaced";
export type ProviderSessionExecutionScope = "direct" | "group_subagent" | "orchestrator";

export type ConversationProviderSession = {
  id: string;
  conversationId: string;
  workspaceId: string;
  agentId: string | null;
  provider: RuntimeProvider;
  providerSessionId: string;
  workspaceContextId: string | null;
  rootPath: string;
  executionScope: ProviderSessionExecutionScope;
  status: ProviderSessionStatus;
  failureReason: string | null;
  createdAt: string;
  updatedAt: string;
};

export type ProviderSessionScope = {
  agentId?: string | null;
  provider?: RuntimeProvider;
  workspaceContextId?: string | null;
  rootPath?: string;
  executionScope?: ProviderSessionExecutionScope;
};

type ProviderSessionRow = {
  id: string;
  conversation_id: string;
  workspace_id: string;
  agent_id: string | null;
  provider: string;
  provider_session_id: string;
  workspace_context_id: string | null;
  root_path: string;
  execution_scope: string | null;
  status: string;
  failure_reason: string | null;
  created_at: string;
  updated_at: string;
};

function isDatabase(value: unknown): value is AgentHubDatabase {
  return Boolean(value && typeof value === "object" && "prepare" in value);
}

function toProviderSession(row: ProviderSessionRow): ConversationProviderSession {
  return {
    id: row.id,
    conversationId: row.conversation_id,
    workspaceId: row.workspace_id,
    agentId: row.agent_id ?? null,
    provider: row.provider as RuntimeProvider,
    providerSessionId: row.provider_session_id,
    workspaceContextId: row.workspace_context_id ?? null,
    rootPath: row.root_path,
    executionScope: (row.execution_scope ?? "direct") as ProviderSessionExecutionScope,
    status: row.status as ProviderSessionStatus,
    failureReason: row.failure_reason ?? null,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

export function createProviderSession(
  input: {
    conversationId: string;
    workspaceId: string;
    agentId: string;
    provider: RuntimeProvider;
    providerSessionId: string;
    workspaceContextId?: string | null;
    rootPath: string;
    executionScope?: ProviderSessionExecutionScope;
  },
  db: AgentHubDatabase = getDatabase()
): ConversationProviderSession {
  // The v2 table is the active path. v2 distinguishes rows by
  // (agent_id, workspace_context_id, execution_scope, provider_session_id),
  // not just (conversation_id, provider, root_path) — so multiple sessions
  // for the same conversation are allowed. The path below is a
  // SELECT-then-INSERT-or-UPDATE that never blindly INSERTs against a
  // key the DB doesn't have a UNIQUE on, so a duplicate cannot raise a
  // UNIQUE constraint failure.
  const now = new Date().toISOString();
  const executionScope = input.executionScope ?? "direct";
  const workspaceContextId = input.workspaceContextId ?? null;
  const existingRow = db
    .prepare<
      [string, string, string, string | null, string, string],
      ProviderSessionRow
    >(
      `SELECT * FROM conversation_provider_sessions_v2
       WHERE conversation_id = ?
         AND agent_id = ?
         AND provider = ?
         AND workspace_context_id IS ?
         AND execution_scope = ?
         AND provider_session_id = ?
       ORDER BY created_at DESC
       LIMIT 1`
    )
    .get(
      input.conversationId,
      input.agentId,
      input.provider,
      workspaceContextId,
      executionScope,
      input.providerSessionId
    );

  if (existingRow) {
    db.prepare(
      `UPDATE conversation_provider_sessions_v2
       SET workspace_id = @workspaceId,
           root_path = @rootPath,
           status = 'active',
           failure_reason = NULL,
           updated_at = @updatedAt
       WHERE id = @id`
    ).run({
      id: existingRow.id,
      workspaceId: input.workspaceId,
      rootPath: input.rootPath,
      updatedAt: now
    });

    return {
      ...toProviderSession(existingRow),
      workspaceId: input.workspaceId,
      rootPath: input.rootPath,
      status: "active",
      failureReason: null,
      updatedAt: now
    };
  }

  const session: ConversationProviderSession = {
    id: randomUUID(),
    conversationId: input.conversationId,
    workspaceId: input.workspaceId,
    agentId: input.agentId,
    provider: input.provider,
    providerSessionId: input.providerSessionId,
    workspaceContextId,
    rootPath: input.rootPath,
    executionScope,
    status: "active",
    failureReason: null,
    createdAt: now,
    updatedAt: now
  };

  db.prepare(`
    INSERT INTO conversation_provider_sessions_v2 (
      id, conversation_id, workspace_id, agent_id, provider,
      provider_session_id, workspace_context_id, root_path, execution_scope,
      status, failure_reason, created_at, updated_at
    )
    VALUES (
      @id, @conversationId, @workspaceId, @agentId, @provider,
      @providerSessionId, @workspaceContextId, @rootPath, @executionScope,
      @status, @failureReason, @createdAt, @updatedAt
    )
  `).run(session);

  return session;
}

export function getActiveProviderSession(
  conversationId: string,
  scopeOrDb?: ProviderSessionScope | AgentHubDatabase,
  dbOrUndefined?: AgentHubDatabase
): ConversationProviderSession | null {
  const scope = isDatabase(scopeOrDb) ? {} : scopeOrDb ?? {};
  const db = isDatabase(scopeOrDb) ? scopeOrDb : dbOrUndefined ?? getDatabase();
  const row = db
    .prepare<
      {
        conversationId: string;
        agentId: string | null;
        provider: RuntimeProvider | null;
        workspaceContextId: string | null;
        rootPath: string | null;
        executionScope: ProviderSessionExecutionScope | null;
      },
      ProviderSessionRow
    >(
      `SELECT * FROM conversation_provider_sessions_v2
       WHERE conversation_id = @conversationId
         AND status = 'active'
         AND (@agentId IS NULL OR agent_id = @agentId)
         AND (@provider IS NULL OR provider = @provider)
         AND (
           @workspaceContextId IS NULL
           OR workspace_context_id = @workspaceContextId
           OR workspace_context_id IS NULL
         )
         AND (@rootPath IS NULL OR root_path = @rootPath)
         AND (@executionScope IS NULL OR execution_scope = @executionScope)
       ORDER BY
         CASE WHEN workspace_context_id IS @workspaceContextId THEN 0 ELSE 1 END,
         created_at DESC
       LIMIT 1`
    )
    .get({
      conversationId,
      agentId: scope.agentId ?? null,
      provider: scope.provider ?? null,
      workspaceContextId: scope.workspaceContextId ?? null,
      rootPath: scope.rootPath ?? null,
      executionScope: scope.executionScope ?? null
    });

  return row ? toProviderSession(row) : null;
}

export function getProviderSessionById(
  id: string,
  db: AgentHubDatabase = getDatabase()
): ConversationProviderSession | null {
  const row = db
    .prepare<[string], ProviderSessionRow>(
      "SELECT * FROM conversation_provider_sessions_v2 WHERE id = ?"
    )
    .get(id);
  return row ? toProviderSession(row) : null;
}

export function getProviderSessionsByConversation(
  conversationId: string,
  db: AgentHubDatabase = getDatabase()
): ConversationProviderSession[] {
  return db
    .prepare<[string], ProviderSessionRow>(
      "SELECT * FROM conversation_provider_sessions_v2 WHERE conversation_id = ? ORDER BY created_at DESC"
    )
    .all(conversationId)
    .map(toProviderSession);
}

export function updateProviderSessionStatus(
  id: string,
  status: ProviderSessionStatus,
  failureReason?: string,
  db: AgentHubDatabase = getDatabase()
): boolean {
  const result = db
    .prepare(
      "UPDATE conversation_provider_sessions_v2 SET status = @status, failure_reason = @failureReason, updated_at = @updatedAt WHERE id = @id"
    )
    .run({
      id,
      status,
      failureReason: failureReason ?? null,
      updatedAt: new Date().toISOString()
    });
  return result.changes > 0;
}

export function markActiveSessionsAsReplaced(
  conversationId: string,
  scopeOrDb?: ProviderSessionScope | AgentHubDatabase,
  dbOrUndefined?: AgentHubDatabase
): void {
  const scope = isDatabase(scopeOrDb) ? {} : scopeOrDb ?? {};
  const db = isDatabase(scopeOrDb) ? scopeOrDb : dbOrUndefined ?? getDatabase();
  db.prepare(
    `UPDATE conversation_provider_sessions_v2
     SET status = 'replaced', updated_at = @updatedAt
     WHERE conversation_id = @conversationId
       AND status = 'active'
       AND (@agentId IS NULL OR agent_id = @agentId)
       AND (@provider IS NULL OR provider = @provider)
       AND (
         @workspaceContextId IS NULL
         OR workspace_context_id = @workspaceContextId
         OR workspace_context_id IS NULL
       )
       AND (@rootPath IS NULL OR root_path = @rootPath)
       AND (@executionScope IS NULL OR execution_scope = @executionScope)`
  ).run({
    conversationId,
    updatedAt: new Date().toISOString(),
    agentId: scope.agentId ?? null,
    provider: scope.provider ?? null,
    workspaceContextId: scope.workspaceContextId ?? null,
    rootPath: scope.rootPath ?? null,
    executionScope: scope.executionScope ?? null
  });
}

/**
 * Mark every active session bound to `agentId` (across all conversations) as
 * `replaced`. Used when an agent's execution cwd changes so the next run
 * starts a fresh local-runtime session in the new cwd instead of trying to
 * resume a process spawned in the old cwd.
 */
export function markActiveSessionsAsReplacedForAgent(
  agentId: string,
  providerOrDb?: RuntimeProvider | AgentHubDatabase,
  dbOrUndefined?: AgentHubDatabase
): void {
  const provider = isDatabase(providerOrDb) ? undefined : providerOrDb;
  const db = isDatabase(providerOrDb) ? providerOrDb : dbOrUndefined ?? getDatabase();
  db.prepare(
    `UPDATE conversation_provider_sessions_v2
     SET status = 'replaced', updated_at = @updatedAt
     WHERE status = 'active'
       AND agent_id = @agentId
       AND (@provider IS NULL OR provider = @provider)`
  ).run({
    updatedAt: new Date().toISOString(),
    agentId,
    provider: provider ?? null
  });
}

/**
 * Upsert a provider session against the v1 (non-scoped) table. Uses
 * `ON CONFLICT(conversation_id, provider, root_path) DO UPDATE` to avoid
 * the "UNIQUE constraint failed" error on the second/third message in the
 * same conversation. The v1 table is preserved for legacy data; the active
 * code path is `createProviderSession` (v2) above.
 */
export function upsertProviderSessionV1(
  input: {
    conversationId: string;
    workspaceId: string;
    agentId: string;
    provider: RuntimeProvider;
    providerSessionId: string;
    rootPath: string;
    status?: ProviderSessionStatus;
    failureReason?: string | null;
  },
  db: AgentHubDatabase = getDatabase()
): void {
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO conversation_provider_sessions (
       id, conversation_id, workspace_id, agent_id, provider,
       provider_session_id, root_path, status, failure_reason,
       created_at, updated_at
     )
     VALUES (
       @id, @conversationId, @workspaceId, @agentId, @provider,
       @providerSessionId, @rootPath, @status, @failureReason,
       @now, @now
     )
     ON CONFLICT(conversation_id, provider, root_path) DO UPDATE SET
       provider_session_id = excluded.provider_session_id,
       workspace_id = excluded.workspace_id,
       agent_id = excluded.agent_id,
       status = excluded.status,
       failure_reason = excluded.failure_reason,
       updated_at = excluded.updated_at`
  ).run({
    id: randomUUID(),
    conversationId: input.conversationId,
    workspaceId: input.workspaceId,
    agentId: input.agentId,
    provider: input.provider,
    providerSessionId: input.providerSessionId,
    rootPath: input.rootPath,
    status: input.status ?? "active",
    failureReason: input.failureReason ?? null,
    now
  });
}
