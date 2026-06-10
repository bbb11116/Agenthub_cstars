import type { GitStatus } from "./git";

export type DiffProposalStatus =
  | "pending"
  | "applied"
  | "rejected"
  | "conflicted"
  | "failed";

export type DiffProposal = {
  id: string;
  workspaceId: string;
  agentId: string;
  conversationId: string;
  filePath: string;
  oldContentHash: string;
  newContentHash: string;
  diffContent: string;
  newContent: string;
  status: DiffProposalStatus;
  createdAt: string;
  appliedAt?: string;
  dispatchRunId?: string | null;
  dispatchStepId?: string | null;
  messageId?: string | null;
};

export type CreateDiffProposalInput = {
  workspaceId: string;
  agentId: string;
  conversationId: string;
  filePath: string;
  newContent?: string;
  /**
   * Unified diff patch (with `--- / +++` headers). When provided, the new
   * file content is derived by applying the patch to the current file on
   * disk. Mutually exclusive with `newContent`.
   */
  unifiedDiff?: string;
  /**
   * True when the proposal creates a new file. The service will treat the
   * pre-edit content as empty and reject the proposal if the target file
   * already exists and is non-empty.
   */
  isNewFile?: boolean;
  dispatchRunId?: string;
  dispatchStepId?: string;
};

export type PersistDiffProposalInput = Omit<
  DiffProposal,
  "id" | "createdAt" | "status" | "appliedAt"
> & {
  status?: DiffProposalStatus;
  appliedAt?: string;
  dispatchRunId?: string | null;
  dispatchStepId?: string | null;
  messageId?: string | null;
};

export type UpdateDiffProposalInput = Partial<
  Pick<
    DiffProposal,
    "status" | "appliedAt" | "dispatchRunId" | "dispatchStepId" | "messageId"
  >
>;

export type DiffCardContent = {
  diffProposalId: string;
  filePath: string;
  summary?: string;
};

export type ApplyDiffInput = {
  workspaceId: string;
  diffProposalId: string;
  agentId?: string;
};

export type RejectDiffInput = ApplyDiffInput;

export type ApplyDiffResult = {
  status: "applied" | "conflicted" | "failed";
  diffProposal: DiffProposal | null;
  gitStatus?: GitStatus;
  error?: string;
};
