export type ReadFileTreeInput = {
  workspaceId: string;
  conversationId?: string;
};

export type ReadFileInput = {
  workspaceId: string;
  conversationId?: string;
  relativePath: string;
  agentId?: string;
};

export type WriteWorkspaceFileInput = {
  workspaceId: string;
  conversationId?: string;
  relativePath: string;
  content: string;
};

export type ListDirectoryInput = {
  workspaceId: string;
  conversationId?: string;
  relativePath?: string;
};

export type ListDirectoryEntry = {
  name: string;
  relativePath: string;
  type: "file" | "directory";
};

export type ListDirectoryResult = {
  relativePath: string;
  entries: ListDirectoryEntry[];
};

export type GlobFilesInput = {
  workspaceId: string;
  conversationId?: string;
  pattern: string;
  maxResults?: number;
};

export type GlobFilesResult = {
  pattern: string;
  matches: string[];
  truncated: boolean;
};

export type FileTreeNode = {
  name: string;
  relativePath: string;
  type: "file" | "directory";
  children?: FileTreeNode[];
};

export type FileContent = {
  relativePath: string;
  content: string;
  language?: string;
  size: number;
};

export type FileTreeState = {
  nodes: FileTreeNode[];
  selectedFilePath: string | null;
  selectedFileContent: FileContent | null;
  loading: boolean;
  error?: string;
};
