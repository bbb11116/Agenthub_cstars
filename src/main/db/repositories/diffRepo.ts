import { randomUUID } from "node:crypto";
import type {
  DiffProposal,
  DiffProposalStatus,
  PersistDiffProposalInput,
  UpdateDiffProposalInput
} from "../../../shared/diff";
import { getDatabase, type AgentHubDatabase } from "../index";

type DiffProposalRow = {
  id: string;
  workspace_id: string;
  agent_id: string;
  conversation_id: string;
  file_path: string;
  old_content_hash: string;
  new_content_hash: string;
  diff_content: string;
  new_content: string;
  status: DiffProposalStatus;
  created_at: string;
  applied_at: string | null;
  dispatch_run_id: string | null;
  dispatch_step_id: string | null;
  message_id: string | null;
};

function toDiffProposal(row: DiffProposalRow): DiffProposal {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    agentId: row.agent_id,
    conversationId: row.conversation_id,
    filePath: row.file_path,
    oldContentHash: row.old_content_hash,
    newContentHash: row.new_content_hash,
    diffContent: row.diff_content,
    newContent: row.new_content,
    status: row.status,
    createdAt: row.created_at,
    appliedAt: row.applied_at ?? undefined,
    dispatchRunId: row.dispatch_run_id ?? null,
    dispatchStepId: row.dispatch_step_id ?? null,
    messageId: row.message_id ?? null
  };
}

export function createDiffProposal(
  input: PersistDiffProposalInput,
  db: AgentHubDatabase = getDatabase()
): DiffProposal {
  const diffProposal: DiffProposal = {
    id: randomUUID(),
    workspaceId: input.workspaceId,
    agentId: input.agentId,
    conversationId: input.conversationId,
    filePath: input.filePath,
    oldContentHash: input.oldContentHash,
    newContentHash: input.newContentHash,
    diffContent: input.diffContent,
    newContent: input.newContent,
    status: input.status ?? "pending",
    createdAt: new Date().toISOString(),
    appliedAt: input.appliedAt,
    dispatchRunId: input.dispatchRunId ?? null,
    dispatchStepId: input.dispatchStepId ?? null,
    messageId: input.messageId ?? null
  };

  db.prepare(`
    INSERT INTO diff_proposals (
      id,
      workspace_id,
      agent_id,
      conversation_id,
      file_path,
      old_content_hash,
      new_content_hash,
      diff_content,
      new_content,
      status,
      created_at,
      applied_at,
      dispatch_run_id,
      dispatch_step_id,
      message_id
    )
    VALUES (
      @id,
      @workspaceId,
      @agentId,
      @conversationId,
      @filePath,
      @oldContentHash,
      @newContentHash,
      @diffContent,
      @newContent,
      @status,
      @createdAt,
      @appliedAt,
      @dispatchRunId,
      @dispatchStepId,
      @messageId
    )
  `).run({
    ...diffProposal,
    appliedAt: diffProposal.appliedAt ?? null
  });

  return diffProposal;
}

export function getDiffProposalById(
  id: string,
  db: AgentHubDatabase = getDatabase()
): DiffProposal | null {
  const row = db
    .prepare<[string], DiffProposalRow>("SELECT * FROM diff_proposals WHERE id = ?")
    .get(id);

  return row ? toDiffProposal(row) : null;
}

export function getDiffProposalsByConversation(
  conversationId: string,
  db: AgentHubDatabase = getDatabase()
): DiffProposal[] {
  return db
    .prepare<[string], DiffProposalRow>(
      "SELECT * FROM diff_proposals WHERE conversation_id = ? ORDER BY created_at DESC"
    )
    .all(conversationId)
    .map(toDiffProposal);
}

export function getDiffProposalsByWorkspace(
  workspaceId: string,
  db: AgentHubDatabase = getDatabase()
): DiffProposal[] {
  return db
    .prepare<[string], DiffProposalRow>(
      "SELECT * FROM diff_proposals WHERE workspace_id = ? ORDER BY created_at DESC"
    )
    .all(workspaceId)
    .map(toDiffProposal);
}

export function updateDiffProposal(
  id: string,
  input: UpdateDiffProposalInput,
  db: AgentHubDatabase = getDatabase()
): DiffProposal | null {
  const current = getDiffProposalById(id, db);

  if (!current) {
    return null;
  }

  const next: DiffProposal = {
    ...current,
    ...input
  };

  db.prepare(`
    UPDATE diff_proposals
    SET
      status = @status,
      applied_at = @appliedAt,
      dispatch_run_id = @dispatchRunId,
      dispatch_step_id = @dispatchStepId,
      message_id = @messageId
    WHERE id = @id
  `).run({
    ...next,
    appliedAt: next.appliedAt ?? null,
    dispatchRunId: next.dispatchRunId ?? null,
    dispatchStepId: next.dispatchStepId ?? null,
    messageId: next.messageId ?? null
  });

  return next;
}

export function deleteDiffProposal(id: string, db: AgentHubDatabase = getDatabase()): boolean {
  const result = db.prepare<[string]>("DELETE FROM diff_proposals WHERE id = ?").run(id);
  return result.changes > 0;
}

export function getDiffProposalsByDispatchRun(
  dispatchRunId: string,
  db: AgentHubDatabase = getDatabase()
): DiffProposal[] {
  return db
    .prepare<[string], DiffProposalRow>(
      "SELECT * FROM diff_proposals WHERE dispatch_run_id = ? ORDER BY created_at ASC"
    )
    .all(dispatchRunId)
    .map(toDiffProposal);
}
