import { randomUUID } from "node:crypto";
import {
  MAX_DISPATCH_STEPS,
  type DispatchMode,
  DispatchRun,
  DispatchRunStatus
} from "../../../shared/groupChat";
import type { AcceptanceCriterion, OrchestratorReview } from "../../../shared/groupChat";
import {
  getDatabase,
  parseJsonField,
  stringifyJsonField,
  type AgentHubDatabase
} from "../index";

type DispatchRunRow = {
  id: string;
  conversation_id: string;
  trigger_message_id: string;
  mode: DispatchMode;
  status: DispatchRunStatus;
  max_steps: number;
  round_index: number;
  acceptance_criteria: string;
  orchestrator_review: string | null;
  final_summary_enabled: number;
  diff_review_required: number;
  created_at: string;
  finished_at: string | null;
};

function toDispatchRun(row: DispatchRunRow): DispatchRun {
  return {
    id: row.id,
    conversationId: row.conversation_id,
    triggerMessageId: row.trigger_message_id,
    mode: row.mode,
    status: row.status,
    maxSteps: row.max_steps,
    roundIndex: row.round_index ?? 0,
    acceptanceCriteria: parseJsonField<AcceptanceCriterion[]>(
      row.acceptance_criteria ?? "[]",
      [],
      "dispatch_runs.acceptance_criteria"
    ),
    orchestratorReview: row.orchestrator_review
      ? parseJsonField<OrchestratorReview | null>(
          row.orchestrator_review,
          null,
          "dispatch_runs.orchestrator_review"
        )
      : null,
    finalSummaryEnabled: row.final_summary_enabled === 1,
    diffReviewRequired: row.diff_review_required === 1,
    createdAt: row.created_at,
    finishedAt: row.finished_at
  };
}

export type CreateDispatchRunInput = {
  conversationId: string;
  triggerMessageId: string;
  mode: DispatchMode;
  maxSteps?: number;
  roundIndex?: number;
  acceptanceCriteria?: AcceptanceCriterion[];
  finalSummaryEnabled?: boolean;
  diffReviewRequired?: boolean;
};

export function createDispatchRun(
  input: CreateDispatchRunInput,
  db: AgentHubDatabase = getDatabase()
): DispatchRun {
  const run: DispatchRun = {
    id: randomUUID(),
    conversationId: input.conversationId,
    triggerMessageId: input.triggerMessageId,
    mode: input.mode,
    status: "planning",
    maxSteps: input.maxSteps ?? MAX_DISPATCH_STEPS,
    roundIndex: input.roundIndex ?? 0,
    acceptanceCriteria: input.acceptanceCriteria ?? [],
    orchestratorReview: null,
    finalSummaryEnabled: input.finalSummaryEnabled ?? true,
    diffReviewRequired: input.diffReviewRequired ?? false,
    createdAt: new Date().toISOString(),
    finishedAt: null
  };

  db.prepare(`
    INSERT INTO dispatch_runs (
      id, conversation_id, trigger_message_id, mode, status, max_steps,
      round_index, acceptance_criteria, orchestrator_review,
      final_summary_enabled, diff_review_required, created_at, finished_at
    )
    VALUES (
      @id, @conversationId, @triggerMessageId, @mode, @status, @maxSteps,
      @roundIndex, @acceptanceCriteria, @orchestratorReview,
      @finalSummaryEnabled, @diffReviewRequired, @createdAt, @finishedAt
    )
  `).run({
    ...run,
    acceptanceCriteria: stringifyJsonField(run.acceptanceCriteria),
    orchestratorReview: null,
    finalSummaryEnabled: run.finalSummaryEnabled ? 1 : 0,
    diffReviewRequired: run.diffReviewRequired ? 1 : 0
  });

  return run;
}

export function getDispatchRunById(
  id: string,
  db: AgentHubDatabase = getDatabase()
): DispatchRun | null {
  const row = db
    .prepare<[string], DispatchRunRow>("SELECT * FROM dispatch_runs WHERE id = ?")
    .get(id);

  return row ? toDispatchRun(row) : null;
}

export function getDispatchRunsByConversation(
  conversationId: string,
  db: AgentHubDatabase = getDatabase()
): DispatchRun[] {
  return db
    .prepare<[string], DispatchRunRow>(
      "SELECT * FROM dispatch_runs WHERE conversation_id = ? ORDER BY created_at DESC"
    )
    .all(conversationId)
    .map(toDispatchRun);
}

export function updateDispatchRunStatus(
  id: string,
  status: DispatchRunStatus,
  db: AgentHubDatabase = getDatabase()
): boolean {
  const finishedAt =
    status === "completed" ||
    status === "partial" ||
    status === "partial_failed" ||
    status === "failed" ||
    status === "waiting_for_user" ||
    status === "cancelled"
      ? new Date().toISOString()
      : null;

  const result = db
    .prepare<[DispatchRunStatus, string | null, string]>(
      "UPDATE dispatch_runs SET status = ?, finished_at = ? WHERE id = ?"
    )
    .run(status, finishedAt, id);

  return result.changes > 0;
}

export function updateDispatchRunExecution(
  id: string,
  input: {
    roundIndex?: number;
    acceptanceCriteria?: AcceptanceCriterion[];
    orchestratorReview?: OrchestratorReview | null;
  },
  db: AgentHubDatabase = getDatabase()
): boolean {
  const result = db
    .prepare(
      `UPDATE dispatch_runs
       SET round_index = COALESCE(@roundIndex, round_index),
           acceptance_criteria = COALESCE(@acceptanceCriteria, acceptance_criteria),
           orchestrator_review = CASE
             WHEN @hasOrchestratorReview = 1 THEN @orchestratorReview
             ELSE orchestrator_review
           END
       WHERE id = @id`
    )
    .run({
      id,
      roundIndex: input.roundIndex ?? null,
      acceptanceCriteria:
        input.acceptanceCriteria === undefined
          ? null
          : stringifyJsonField(input.acceptanceCriteria),
      hasOrchestratorReview: input.orchestratorReview === undefined ? 0 : 1,
      orchestratorReview:
        input.orchestratorReview === undefined || input.orchestratorReview === null
          ? null
          : stringifyJsonField(input.orchestratorReview)
    });

  return result.changes > 0;
}
