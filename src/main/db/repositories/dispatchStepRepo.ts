import { randomUUID } from "node:crypto";
import type {
  DispatchStep,
  DispatchStepStatus,
  SubAgentResult,
  SubAgentTaskInput
} from "../../../shared/groupChat";
import { AGENT_EXECUTION_LIMITS } from "../../../shared/agentExecution";
import {
  getDatabase,
  parseJsonField,
  stringifyJsonField,
  type AgentHubDatabase
} from "../index";

type DispatchStepRow = {
  id: string;
  dispatch_run_id: string;
  step_index: number;
  agent_id: string;
  instruction: string;
  status: DispatchStepStatus;
  round_index: number;
  assignment_id: string | null;
  target_criteria: string;
  subagent_result: string | null;
  max_iterations: number;
  input_context_snapshot: string | null;
  output_message_id: string | null;
  error_message: string | null;
  started_at: string | null;
  finished_at: string | null;
};

function toDispatchStep(row: DispatchStepRow): DispatchStep {
  return {
    id: row.id,
    dispatchRunId: row.dispatch_run_id,
    stepIndex: row.step_index,
    agentId: row.agent_id,
    instruction: row.instruction,
    status: row.status,
    roundIndex: row.round_index ?? 0,
    assignmentId: row.assignment_id ?? null,
    targetCriteria: parseJsonField<string[]>(
      row.target_criteria ?? "[]",
      [],
      "dispatch_steps.target_criteria"
    ),
    subAgentResult: row.subagent_result
      ? parseJsonField<SubAgentResult | null>(
          row.subagent_result,
          null,
          "dispatch_steps.subagent_result"
        )
      : null,
    maxIterations:
      row.max_iterations ?? AGENT_EXECUTION_LIMITS.groupSubagentMaxIterations,
    inputContextSnapshot: row.input_context_snapshot
      ? parseJsonField<SubAgentTaskInput | null>(
          row.input_context_snapshot,
          null,
          "dispatch_steps.input_context_snapshot"
        )
      : null,
    outputMessageId: row.output_message_id,
    errorMessage: row.error_message,
    startedAt: row.started_at,
    finishedAt: row.finished_at
  };
}

export type CreateDispatchStepInput = {
  dispatchRunId: string;
  stepIndex: number;
  agentId: string;
  instruction: string;
  roundIndex?: number;
  assignmentId?: string;
  targetCriteria?: string[];
  maxIterations?: number;
  inputContextSnapshot?: SubAgentTaskInput;
};

export function createDispatchStep(
  input: CreateDispatchStepInput,
  db: AgentHubDatabase = getDatabase()
): DispatchStep {
  const step: DispatchStep = {
    id: randomUUID(),
    dispatchRunId: input.dispatchRunId,
    stepIndex: input.stepIndex,
    agentId: input.agentId,
    instruction: input.instruction,
    status: "pending",
    roundIndex: input.roundIndex ?? 0,
    assignmentId: input.assignmentId ?? null,
    targetCriteria: input.targetCriteria ?? [],
    subAgentResult: null,
    maxIterations:
      input.maxIterations ?? AGENT_EXECUTION_LIMITS.groupSubagentMaxIterations,
    inputContextSnapshot: input.inputContextSnapshot ?? null,
    outputMessageId: null,
    errorMessage: null,
    startedAt: null,
    finishedAt: null
  };

  db.prepare(`
    INSERT INTO dispatch_steps (
      id, dispatch_run_id, step_index, agent_id, instruction, status,
      round_index, assignment_id, target_criteria, subagent_result, max_iterations,
      input_context_snapshot, output_message_id, error_message, started_at, finished_at
    )
    VALUES (
      @id, @dispatchRunId, @stepIndex, @agentId, @instruction, @status,
      @roundIndex, @assignmentId, @targetCriteria, @subAgentResult, @maxIterations,
      @inputContextSnapshot, @outputMessageId, @errorMessage, @startedAt, @finishedAt
    )
  `).run({
    ...step,
    targetCriteria: stringifyJsonField(step.targetCriteria),
    subAgentResult: null,
    inputContextSnapshot: step.inputContextSnapshot
      ? stringifyJsonField(step.inputContextSnapshot)
      : null
  });

  return step;
}

export function getDispatchStepById(
  id: string,
  db: AgentHubDatabase = getDatabase()
): DispatchStep | null {
  const row = db
    .prepare<[string], DispatchStepRow>("SELECT * FROM dispatch_steps WHERE id = ?")
    .get(id);

  return row ? toDispatchStep(row) : null;
}

export function getStepsByDispatchRun(
  dispatchRunId: string,
  db: AgentHubDatabase = getDatabase()
): DispatchStep[] {
  return db
    .prepare<[string], DispatchStepRow>(
      "SELECT * FROM dispatch_steps WHERE dispatch_run_id = ? ORDER BY step_index ASC"
    )
    .all(dispatchRunId)
    .map(toDispatchStep);
}

export function updateStepStatus(
  id: string,
  status: DispatchStepStatus,
  outputMessageId?: string | null,
  errorMessage?: string | null,
  db: AgentHubDatabase = getDatabase()
): boolean {
  const now = new Date().toISOString();
  const startedAt = status === "running" ? now : undefined;
  const finishedAt =
    status === "completed" ||
    status === "partial" ||
    status === "failed" ||
    status === "iteration_limit_reached" ||
    status === "cancelled" ||
    status === "skipped"
      ? now
      : undefined;

  const result = db
    .prepare(
      `UPDATE dispatch_steps
       SET status = @status,
           output_message_id = COALESCE(@outputMessageId, output_message_id),
           error_message = COALESCE(@errorMessage, error_message),
           started_at = COALESCE(@startedAt, started_at),
           finished_at = COALESCE(@finishedAt, finished_at)
       WHERE id = @id`
    )
    .run({
      id,
      status,
      outputMessageId: outputMessageId ?? null,
      errorMessage: errorMessage ?? null,
      startedAt: startedAt ?? null,
      finishedAt: finishedAt ?? null
    });

  return result.changes > 0;
}

export function updateStepSubAgentResult(
  id: string,
  subAgentResult: SubAgentResult,
  db: AgentHubDatabase = getDatabase()
): boolean {
  const result = db
    .prepare("UPDATE dispatch_steps SET subagent_result = ? WHERE id = ?")
    .run(stringifyJsonField(subAgentResult), id);

  return result.changes > 0;
}

export function updateStepInputContextSnapshot(
  id: string,
  inputContextSnapshot: SubAgentTaskInput,
  db: AgentHubDatabase = getDatabase()
): boolean {
  const result = db
    .prepare("UPDATE dispatch_steps SET input_context_snapshot = ? WHERE id = ?")
    .run(stringifyJsonField(inputContextSnapshot), id);

  return result.changes > 0;
}

export function updateStepOutputMessageId(
  id: string,
  outputMessageId: string,
  db: AgentHubDatabase = getDatabase()
): boolean {
  const result = db
    .prepare<[string, string]>(
      "UPDATE dispatch_steps SET output_message_id = ? WHERE id = ?"
    )
    .run(outputMessageId, id);
  return result.changes > 0;
}
