import { randomUUID } from "node:crypto";
import type { RuntimeProvider } from "../../../shared/runtime";
import {
  AGENT_EXECUTION_LIMITS,
  type AgentExecutionMode
} from "../../../shared/agentExecution";
import {
  getDatabase,
  stringifyJsonField,
  parseJsonField,
  type AgentHubDatabase
} from "../index";

export type AgentRunStatus =
  | "running"
  | "completed"
  | "failed"
  | "cancelled"
  | "waiting_for_permission"
  | "iteration_limit_reached"
  | "verification_failed";

export type AgentRun = {
  id: string;
  conversationId: string;
  workspaceId: string;
  agentId: string;
  provider: RuntimeProvider;
  providerSessionId: string | null;
  rootPath: string;
  workspaceContextId: string | null;
  executionScope: string | null;
  dispatchStepId: string | null;
  systemPromptSnapshot: string;
  toolPermissionsSnapshot: string;
  status: AgentRunStatus;
  mode: AgentExecutionMode;
  maxIterations: number;
  iterationsUsed: number | null;
  rawOutput: string | null;
  startedAt: string;
  endedAt: string | null;
  errorMessage: string | null;
  usedFallback: boolean;
};

type AgentRunRow = {
  id: string;
  conversation_id: string;
  workspace_id: string;
  agent_id: string;
  provider: string;
  provider_session_id: string | null;
  root_path: string;
  workspace_context_id: string | null;
  execution_scope: string | null;
  dispatch_step_id: string | null;
  system_prompt_snapshot: string;
  tool_permissions_snapshot: string;
  status: string;
  mode: string;
  max_iterations: number;
  iterations_used: number | null;
  raw_output: string | null;
  started_at: string;
  ended_at: string | null;
  error_message: string | null;
  used_fallback: number;
};

function toAgentRun(row: AgentRunRow): AgentRun {
  return {
    id: row.id,
    conversationId: row.conversation_id,
    workspaceId: row.workspace_id,
    agentId: row.agent_id,
    provider: row.provider as RuntimeProvider,
    providerSessionId: row.provider_session_id ?? null,
    rootPath: row.root_path,
    workspaceContextId: row.workspace_context_id ?? null,
    executionScope: row.execution_scope ?? null,
    dispatchStepId: row.dispatch_step_id ?? null,
    systemPromptSnapshot: row.system_prompt_snapshot,
    toolPermissionsSnapshot: row.tool_permissions_snapshot,
    status: row.status as AgentRunStatus,
    mode: (row.mode ?? "single_chat") as AgentExecutionMode,
    maxIterations:
      row.max_iterations ?? AGENT_EXECUTION_LIMITS.singleChatMaxIterations,
    iterationsUsed: row.iterations_used ?? null,
    rawOutput: row.raw_output ?? null,
    startedAt: row.started_at,
    endedAt: row.ended_at ?? null,
    errorMessage: row.error_message ?? null,
    usedFallback: (row.used_fallback ?? 0) === 1
  };
}

export function createAgentRun(
  input: {
    conversationId: string;
    workspaceId: string;
    agentId: string;
    provider: RuntimeProvider;
    providerSessionId?: string;
    rootPath: string;
    workspaceContextId?: string | null;
    executionScope?: string | null;
    dispatchStepId?: string | null;
    systemPromptSnapshot: string;
    toolPermissionsSnapshot: string;
    mode?: AgentExecutionMode;
    maxIterations?: number;
  },
  db: AgentHubDatabase = getDatabase()
): AgentRun {
  const now = new Date().toISOString();
  const run: AgentRun = {
    id: randomUUID(),
    conversationId: input.conversationId,
    workspaceId: input.workspaceId,
    agentId: input.agentId,
    provider: input.provider,
    providerSessionId: input.providerSessionId ?? null,
    rootPath: input.rootPath,
    workspaceContextId: input.workspaceContextId ?? null,
    executionScope: input.executionScope ?? null,
    dispatchStepId: input.dispatchStepId ?? null,
    systemPromptSnapshot: input.systemPromptSnapshot,
    toolPermissionsSnapshot: input.toolPermissionsSnapshot,
    status: "running",
    mode: input.mode ?? "single_chat",
    maxIterations:
      input.maxIterations ?? AGENT_EXECUTION_LIMITS.singleChatMaxIterations,
    iterationsUsed: null,
    rawOutput: null,
    startedAt: now,
    endedAt: null,
    errorMessage: null,
    usedFallback: false
  };

  db.prepare(`
    INSERT INTO agent_runs (
      id, conversation_id, workspace_id, agent_id, provider,
      provider_session_id, root_path, system_prompt_snapshot,
      workspace_context_id, execution_scope, dispatch_step_id,
      tool_permissions_snapshot, status, mode, max_iterations, iterations_used, started_at, ended_at,
      raw_output, error_message, used_fallback
    )
    VALUES (
      @id, @conversationId, @workspaceId, @agentId, @provider,
      @providerSessionId, @rootPath, @systemPromptSnapshot,
      @workspaceContextId, @executionScope, @dispatchStepId,
      @toolPermissionsSnapshot, @status, @mode, @maxIterations, @iterationsUsed, @startedAt, @endedAt,
      @rawOutput, @errorMessage, @usedFallback
    )
  `).run({
    ...run,
    usedFallback: run.usedFallback ? 1 : 0
  });

  return run;
}

export function getAgentRunById(
  id: string,
  db: AgentHubDatabase = getDatabase()
): AgentRun | null {
  const row = db
    .prepare<[string], AgentRunRow>("SELECT * FROM agent_runs WHERE id = ?")
    .get(id);

  return row ? toAgentRun(row) : null;
}

export function getLatestAgentRunByConversation(
  conversationId: string,
  db: AgentHubDatabase = getDatabase()
): AgentRun | null {
  const row = db
    .prepare<[string], AgentRunRow>(
      "SELECT * FROM agent_runs WHERE conversation_id = ? ORDER BY started_at DESC LIMIT 1"
    )
    .get(conversationId);

  return row ? toAgentRun(row) : null;
}

export function getRunningAgentRunByConversation(
  conversationId: string,
  db: AgentHubDatabase = getDatabase()
): AgentRun | null {
  const row = db
    .prepare<[string], AgentRunRow>(
      "SELECT * FROM agent_runs WHERE conversation_id = ? AND status = 'running' LIMIT 1"
    )
    .get(conversationId);

  return row ? toAgentRun(row) : null;
}

export function getRunningAgentRunByScope(
  input: {
    conversationId: string;
    agentId: string;
    executionScope: string;
    dispatchStepId?: string | null;
  },
  db: AgentHubDatabase = getDatabase()
): AgentRun | null {
  const row = db
    .prepare<
      {
        conversationId: string;
        agentId: string;
        executionScope: string;
        dispatchStepId: string | null;
      },
      AgentRunRow
    >(
      `SELECT * FROM agent_runs
       WHERE conversation_id = @conversationId
         AND agent_id = @agentId
         AND (
           execution_scope = @executionScope
           OR (execution_scope IS NULL AND @executionScope = 'direct')
         )
         AND (
           @dispatchStepId IS NULL
           OR dispatch_step_id = @dispatchStepId
         )
         AND status = 'running'
       LIMIT 1`
    )
    .get({
      conversationId: input.conversationId,
      agentId: input.agentId,
      executionScope: input.executionScope,
      dispatchStepId: input.dispatchStepId ?? null
    });

  return row ? toAgentRun(row) : null;
}

export function getAgentRunsByConversation(
  conversationId: string,
  db: AgentHubDatabase = getDatabase()
): AgentRun[] {
  return db
    .prepare<[string], AgentRunRow>(
      "SELECT * FROM agent_runs WHERE conversation_id = ? ORDER BY started_at DESC"
    )
    .all(conversationId)
    .map(toAgentRun);
}

export function getAgentRunByDispatchStep(
  dispatchStepId: string,
  db: AgentHubDatabase = getDatabase()
): AgentRun | null {
  const row = db
    .prepare<[string], AgentRunRow>(
      "SELECT * FROM agent_runs WHERE dispatch_step_id = ? ORDER BY started_at DESC LIMIT 1"
    )
    .get(dispatchStepId);

  return row ? toAgentRun(row) : null;
}

export function updateAgentRunStatus(
  id: string,
  status: AgentRunStatus,
  errorMessage?: string,
  db: AgentHubDatabase = getDatabase(),
  iterationsUsed?: number
): boolean {
  const result = db
    .prepare(
      `UPDATE agent_runs SET
        status = @status,
        ended_at = @endedAt,
        error_message = @errorMessage,
        iterations_used = COALESCE(@iterationsUsed, iterations_used)
      WHERE id = @id`
    )
    .run({
      id,
      status,
      endedAt: new Date().toISOString(),
      errorMessage: errorMessage ?? null,
      iterationsUsed: iterationsUsed ?? null
    });

  return result.changes > 0;
}

export function updateAgentRunRawOutput(
  id: string,
  rawOutput: string,
  db: AgentHubDatabase = getDatabase()
): boolean {
  const result = db
    .prepare("UPDATE agent_runs SET raw_output = @rawOutput WHERE id = @id")
    .run({ id, rawOutput });

  return result.changes > 0;
}

export function updateAgentRunProviderSessionId(
  id: string,
  providerSessionId: string,
  db: AgentHubDatabase = getDatabase()
): boolean {
  const result = db
    .prepare("UPDATE agent_runs SET provider_session_id = @providerSessionId WHERE id = @id")
    .run({ id, providerSessionId });

  return result.changes > 0;
}

export function markAgentRunUsedFallback(
  id: string,
  db: AgentHubDatabase = getDatabase()
): boolean {
  const result = db
    .prepare("UPDATE agent_runs SET used_fallback = 1 WHERE id = @id")
    .run({ id });

  return result.changes > 0;
}
