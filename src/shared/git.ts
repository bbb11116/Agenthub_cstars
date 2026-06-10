export type GitFileStatusLabel =
  | "modified"
  | "added"
  | "deleted"
  | "untracked"
  | "renamed"
  | "unknown";

export type GitFileStatus = {
  path: string;
  indexStatus: string;
  worktreeStatus: string;
  label: GitFileStatusLabel;
};

export type GitStatus = {
  workspaceId: string;
  isGitRepo: boolean;
  branch?: string;
  files: GitFileStatus[];
};

export type GitDiff = {
  workspaceId: string;
  filePath?: string;
  diff: string;
  truncated?: boolean;
};

export type ReadGitStatusInput = {
  workspaceId: string;
  conversationId?: string;
  agentId?: string;
};

export type ReadGitDiffInput = {
  workspaceId: string;
  conversationId?: string;
  filePath?: string;
};

export type GitTabState = {
  status: GitStatus | null;
  selectedFilePath: string | null;
  diff: string | null;
  loading: boolean;
};
