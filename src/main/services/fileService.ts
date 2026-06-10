import { promises as fs } from "node:fs";
import type { Dirent } from "node:fs";
import path from "node:path";
import type { ToolPermissionError } from "../../shared/domain";
import type {
  FileContent,
  FileTreeNode,
  GlobFilesInput,
  GlobFilesResult,
  ListDirectoryEntry,
  ListDirectoryInput,
  ListDirectoryResult,
  ReadFileInput,
  ReadFileTreeInput,
  WriteWorkspaceFileInput
} from "../../shared/file";
import type { AgentHubDatabase } from "../db";
import {
  createWorkspacePathGuard,
  PathGuardError,
  type WorkspacePathGuard
} from "../utils/pathGuard";
import {
  assertAgentCanUseTool,
  ToolPermissionServiceError
} from "./toolPermissionService";
import { getWorkspaceById } from "../db/repositories/workspaceRepo";
import { resolveExecutionWorkspace } from "./workspaceContextResolver";

const IGNORED_DIRECTORY_NAMES = new Set([
  ".git",
  "node_modules",
  "dist",
  "build",
  ".next"
]);

const MAX_FILE_PREVIEW_BYTES = 1024 * 1024;
const BINARY_SAMPLE_BYTES = 8192;
const SECURITY_BLOCKED_MESSAGE =
  "Security blocked:\nFile access outside workspace is not allowed.";

type FileServiceErrorCode =
  | "INVALID_INPUT"
  | "WORKSPACE_NOT_FOUND"
  | "TOOL_PERMISSION_DENIED"
  | "PATH_OUTSIDE_WORKSPACE"
  | "FILE_NOT_FOUND"
  | "PERMISSION_DENIED"
  | "NOT_A_FILE"
  | "FILE_TOO_LARGE"
  | "BINARY_FILE"
  | "READ_FAILED";

export class FileServiceError extends Error {
  readonly code: FileServiceErrorCode;
  readonly agentId?: string;
  readonly tool?: ToolPermissionError["tool"];
  readonly path?: string;

  constructor(
    code: FileServiceErrorCode,
    message: string,
    options: ErrorOptions & Partial<Pick<ToolPermissionError, "agentId" | "tool" | "path">> = {}
  ) {
    super(message, options);
    this.name = "FileServiceError";
    this.code = code;
    this.agentId = options.agentId;
    this.tool = options.tool;
    this.path = options.path;
  }
}

function getErrorCode(error: unknown): string | undefined {
  return typeof error === "object" && error !== null && "code" in error
    ? String((error as { code: unknown }).code)
    : undefined;
}

function toFileServiceError(error: unknown, fallbackMessage: string): FileServiceError {
  if (error instanceof FileServiceError) {
    return error;
  }

  if (error instanceof ToolPermissionServiceError) {
    return new FileServiceError("TOOL_PERMISSION_DENIED", error.message, {
      cause: error,
      agentId: error.agentId,
      tool: error.tool
    });
  }

  if (error instanceof PathGuardError) {
    const code =
      error.code === "PATH_OUTSIDE_WORKSPACE" ||
      error.message === "Path is outside of the workspace."
        ? "PATH_OUTSIDE_WORKSPACE"
        : error.message === "Workspace does not exist."
          ? "WORKSPACE_NOT_FOUND"
          : error.message === "Permission denied."
            ? "PERMISSION_DENIED"
            : "READ_FAILED";
    const message = code === "PATH_OUTSIDE_WORKSPACE" ? SECURITY_BLOCKED_MESSAGE : error.message;

    return new FileServiceError(code, message, {
      cause: error,
      path: error.path
    });
  }

  const code = getErrorCode(error);

  if (code === "ENOENT") {
    return new FileServiceError("FILE_NOT_FOUND", "File does not exist.", {
      cause: error
    });
  }

  if (code === "EACCES" || code === "EPERM") {
    return new FileServiceError("PERMISSION_DENIED", "Permission denied.", {
      cause: error
    });
  }

  return new FileServiceError("READ_FAILED", fallbackMessage, { cause: error });
}

function normalizeTreeInput(input: ReadFileTreeInput): ReadFileTreeInput {
  if (!input || typeof input !== "object" || typeof input.workspaceId !== "string") {
    throw new FileServiceError("INVALID_INPUT", "Workspace id is required.");
  }

  return {
    workspaceId: input.workspaceId,
    conversationId: input.conversationId
  };
}

function normalizeReadInput(input: ReadFileInput): ReadFileInput {
  if (!input || typeof input !== "object" || typeof input.workspaceId !== "string") {
    throw new FileServiceError("INVALID_INPUT", "Workspace id is required.");
  }

  if (typeof input.relativePath !== "string" || input.relativePath.length === 0) {
    throw new FileServiceError("INVALID_INPUT", "File path is required.");
  }

  return {
    workspaceId: input.workspaceId,
    conversationId: input.conversationId,
    relativePath: input.relativePath,
    agentId:
      input.agentId === undefined
        ? undefined
        : normalizeOptionalAgentId(input.agentId, "agentId")
  };
}

function normalizeOptionalAgentId(value: unknown, label: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new FileServiceError("INVALID_INPUT", `${label} is required.`);
  }

  return value.trim();
}

function normalizeWriteInput(input: WriteWorkspaceFileInput): WriteWorkspaceFileInput {
  if (!input || typeof input !== "object" || typeof input.workspaceId !== "string") {
    throw new FileServiceError("INVALID_INPUT", "Workspace id is required.");
  }

  if (typeof input.relativePath !== "string" || input.relativePath.length === 0) {
    throw new FileServiceError("INVALID_INPUT", "File path is required.");
  }

  if (typeof input.content !== "string") {
    throw new FileServiceError("INVALID_INPUT", "File content is required.");
  }

  return {
    workspaceId: input.workspaceId,
    conversationId: input.conversationId,
    relativePath: input.relativePath,
    content: input.content
  };
}

function normalizeListInput(input: ListDirectoryInput): {
  workspaceId: string;
  conversationId?: string;
  relativePath: string;
} {
  if (!input || typeof input !== "object" || typeof input.workspaceId !== "string") {
    throw new FileServiceError("INVALID_INPUT", "Workspace id is required.");
  }

  const relativePath =
    typeof input.relativePath === "string" ? input.relativePath : "";

  return {
    workspaceId: input.workspaceId,
    conversationId: input.conversationId,
    relativePath
  };
}

const DEFAULT_GLOB_MAX_RESULTS = 200;
const ABSOLUTE_GLOB_MAX_RESULTS = 1000;

function normalizeGlobInput(input: GlobFilesInput): {
  workspaceId: string;
  conversationId?: string;
  pattern: string;
  maxResults: number;
} {
  if (!input || typeof input !== "object" || typeof input.workspaceId !== "string") {
    throw new FileServiceError("INVALID_INPUT", "Workspace id is required.");
  }

  if (typeof input.pattern !== "string" || input.pattern.trim().length === 0) {
    throw new FileServiceError("INVALID_INPUT", "Glob pattern is required.");
  }

  const maxResults =
    typeof input.maxResults === "number" && Number.isFinite(input.maxResults)
      ? Math.min(Math.max(1, Math.floor(input.maxResults)), ABSOLUTE_GLOB_MAX_RESULTS)
      : DEFAULT_GLOB_MAX_RESULTS;

  return {
    workspaceId: input.workspaceId,
    conversationId: input.conversationId,
    pattern: input.pattern,
    maxResults
  };
}

function sortListDirectoryEntries(
  left: ListDirectoryEntry,
  right: ListDirectoryEntry
): number {
  if (left.type !== right.type) {
    return left.type === "directory" ? -1 : 1;
  }

  return left.name.localeCompare(right.name, undefined, {
    numeric: true,
    sensitivity: "base"
  });
}

const REGEX_ESCAPE_PATTERN = /[|\\{}()[\]^$+?.]/g;

function escapeGlobRegexLiteral(value: string): string {
  return value.replace(REGEX_ESCAPE_PATTERN, "\\$&");
}

function compileGlobPattern(rawPattern: string): ((path: string) => boolean) | null {
  const pattern = rawPattern.trim();
  if (!pattern) {
    return null;
  }

  // Translate the glob to a regex, anchored at the full relative path.
  // Supports `**` (any chars incl. /), `*` (any chars excl. /), `?` (single
  // char excl. /), and literal segments. Brace expansion is not supported.
  let regex = "^";
  let i = 0;
  while (i < pattern.length) {
    const ch = pattern[i];

    if (ch === "*") {
      if (pattern[i + 1] === "*") {
        // `**/` matches zero or more path segments; `**` by itself matches
        // any chars (including /).
        if (pattern[i + 2] === "/") {
          regex += "(?:.*/)?";
          i += 3;
          continue;
        }
        regex += ".*";
        i += 2;
        continue;
      }
      regex += "[^/]*";
      i += 1;
      continue;
    }

    if (ch === "?") {
      regex += "[^/]";
      i += 1;
      continue;
    }

    regex += escapeGlobRegexLiteral(ch);
    i += 1;
  }
  regex += "$";

  const compiled = new RegExp(regex);
  return (candidate: string) => compiled.test(candidate);
}

function getWorkspacePathGuard(
  workspaceId: string,
  db?: AgentHubDatabase,
  conversationId?: string
): WorkspacePathGuard {
  if (!conversationId) {
    const workspace = getWorkspaceById(workspaceId, db);
    if (!workspace) {
      throw new FileServiceError("WORKSPACE_NOT_FOUND", "Workspace not found.");
    }
    return createWorkspacePathGuard(workspace.rootPath);
  }
  const resolved = resolveExecutionWorkspace({ workspaceId, conversationId }, db);
  return createWorkspacePathGuard(resolved.rootPath);
}

function joinRelativePath(parentPath: string, childName: string): string {
  return parentPath ? `${parentPath}/${childName}` : childName;
}

function sortFileTreeNodes(left: FileTreeNode, right: FileTreeNode): number {
  if (left.type !== right.type) {
    return left.type === "directory" ? -1 : 1;
  }

  return left.name.localeCompare(right.name, undefined, {
    numeric: true,
    sensitivity: "base"
  });
}

function isSupportedDirectory(entry: Dirent): boolean {
  return entry.isDirectory() && !IGNORED_DIRECTORY_NAMES.has(entry.name);
}

async function readDirectoryEntries(
  guard: WorkspacePathGuard,
  relativePath = ""
): Promise<FileTreeNode[]> {
  const { absolutePath } = guard.resolve(relativePath);
  const safeDirectoryPath = guard.assertInside(absolutePath);
  const entries = await fs.readdir(safeDirectoryPath, { withFileTypes: true });
  const nodes: FileTreeNode[] = [];

  for (const entry of entries) {
    const entryRelativePath = joinRelativePath(relativePath, entry.name);
    const { absolutePath: entryPath } = guard.resolve(entryRelativePath);
    const stats = await fs.lstat(entryPath);

    if (stats.isSymbolicLink()) {
      continue;
    }

    if (isSupportedDirectory(entry)) {
      nodes.push({
        name: entry.name,
        relativePath: entryRelativePath,
        type: "directory",
        children: await readDirectoryEntries(guard, entryRelativePath)
      });
      continue;
    }

    if (stats.isFile()) {
      nodes.push({
        name: entry.name,
        relativePath: entryRelativePath,
        type: "file"
      });
    }
  }

  return nodes.sort(sortFileTreeNodes);
}

function isLikelyBinary(buffer: Buffer): boolean {
  const sample = buffer.subarray(0, Math.min(buffer.length, BINARY_SAMPLE_BYTES));

  if (sample.length === 0) {
    return false;
  }

  let suspiciousBytes = 0;

  for (const byte of sample) {
    if (byte === 0) {
      return true;
    }

    const isAllowedControlByte =
      byte === 7 || byte === 8 || byte === 9 || byte === 10 || byte === 12 || byte === 13;

    if (byte < 32 && !isAllowedControlByte) {
      suspiciousBytes += 1;
    }
  }

  if (suspiciousBytes / sample.length > 0.1) {
    return true;
  }

  const decodedSample = sample.toString("utf8");
  return decodedSample.includes("\uFFFD");
}

function inferLanguage(relativePath: string): string | undefined {
  const extension = path.extname(relativePath).toLowerCase();
  const languageByExtension: Record<string, string> = {
    ".c": "c",
    ".cpp": "cpp",
    ".cs": "csharp",
    ".css": "css",
    ".go": "go",
    ".h": "c",
    ".hpp": "cpp",
    ".html": "html",
    ".java": "java",
    ".js": "javascript",
    ".json": "json",
    ".jsx": "jsx",
    ".md": "markdown",
    ".mjs": "javascript",
    ".py": "python",
    ".rb": "ruby",
    ".rs": "rust",
    ".sh": "shell",
    ".sql": "sql",
    ".ts": "typescript",
    ".tsx": "tsx",
    ".txt": "text",
    ".yml": "yaml",
    ".yaml": "yaml"
  };

  return languageByExtension[extension];
}

export async function readFileTree(
  input: ReadFileTreeInput,
  db?: AgentHubDatabase
): Promise<FileTreeNode[]> {
  const normalizedInput = normalizeTreeInput(input);

  try {
    const guard = getWorkspacePathGuard(
      normalizedInput.workspaceId,
      db,
      normalizedInput.conversationId
    );

    return await readDirectoryEntries(guard);
  } catch (error) {
    throw toFileServiceError(error, "Failed to read file tree.");
  }
}

export async function listWorkspaceDirectory(
  input: ListDirectoryInput,
  db?: AgentHubDatabase
): Promise<ListDirectoryResult> {
  const normalizedInput = normalizeListInput(input);

  try {
    const guard = getWorkspacePathGuard(
      normalizedInput.workspaceId,
      db,
      normalizedInput.conversationId
    );
    const { absolutePath } = guard.resolve(normalizedInput.relativePath);
    const safeDirectoryPath = guard.assertInside(absolutePath);
    const entries = await fs.readdir(safeDirectoryPath, { withFileTypes: true });
    const nodes: ListDirectoryEntry[] = [];

    for (const entry of entries) {
      if (entry.isSymbolicLink()) {
        continue;
      }

      const entryRelativePath = joinRelativePath(
        normalizedInput.relativePath,
        entry.name
      );
      const { absolutePath: entryPath } = guard.resolve(entryRelativePath);
      const stats = await fs.lstat(entryPath);

      if (stats.isDirectory() && !IGNORED_DIRECTORY_NAMES.has(entry.name)) {
        nodes.push({
          name: entry.name,
          relativePath: entryRelativePath,
          type: "directory"
        });
        continue;
      }

      if (stats.isFile()) {
        nodes.push({
          name: entry.name,
          relativePath: entryRelativePath,
          type: "file"
        });
      }
    }

    nodes.sort(sortListDirectoryEntries);
    return {
      relativePath: normalizedInput.relativePath,
      entries: nodes
    };
  } catch (error) {
    throw toFileServiceError(error, "Failed to list directory.");
  }
}

export async function globWorkspaceFiles(
  input: GlobFilesInput,
  db?: AgentHubDatabase
): Promise<GlobFilesResult> {
  const normalizedInput = normalizeGlobInput(input);
  const matcher = compileGlobPattern(normalizedInput.pattern);

  if (!matcher) {
    throw new FileServiceError("INVALID_INPUT", "Glob pattern is required.");
  }

  try {
    const guard = getWorkspacePathGuard(
      normalizedInput.workspaceId,
      db,
      normalizedInput.conversationId
    );
    const matches: string[] = [];
    const maxResults = normalizedInput.maxResults;
    let truncated = false;

    const queue: string[] = [""];
    while (queue.length > 0) {
      const relativePath = queue.shift()!;
      const { absolutePath } = guard.resolve(relativePath);
      const safeDirectoryPath = guard.assertInside(absolutePath);
      const entries = await fs.readdir(safeDirectoryPath, { withFileTypes: true });

      for (const entry of entries) {
        if (entry.isSymbolicLink()) {
          continue;
        }

        const entryRelativePath = joinRelativePath(relativePath, entry.name);

        if (entry.isDirectory()) {
          if (IGNORED_DIRECTORY_NAMES.has(entry.name)) {
            continue;
          }
          queue.push(entryRelativePath);
          continue;
        }

        if (entry.isFile() && matcher(entryRelativePath)) {
          matches.push(entryRelativePath);
          if (matches.length >= maxResults) {
            truncated = true;
            return { pattern: normalizedInput.pattern, matches, truncated };
          }
        }
      }
    }

    matches.sort();
    return { pattern: normalizedInput.pattern, matches, truncated };
  } catch (error) {
    throw toFileServiceError(error, "Failed to glob workspace files.");
  }
}

export async function readWorkspaceFile(
  input: ReadFileInput,
  db?: AgentHubDatabase
): Promise<FileContent> {
  const normalizedInput = normalizeReadInput(input);

  try {
    if (normalizedInput.agentId) {
      assertAgentCanUseTool(
        {
          agentId: normalizedInput.agentId,
          tool: "readFile"
        },
        db
      );
    }

    const guard = getWorkspacePathGuard(
      normalizedInput.workspaceId,
      db,
      normalizedInput.conversationId
    );
    const { absolutePath, relativePath } = guard.resolve(normalizedInput.relativePath);
    const safeFilePath = guard.assertInside(absolutePath);
    const stats = await fs.stat(safeFilePath);

    if (!stats.isFile()) {
      throw new FileServiceError("NOT_A_FILE", "Selected path is not a file.");
    }

    if (stats.size > MAX_FILE_PREVIEW_BYTES) {
      throw new FileServiceError("FILE_TOO_LARGE", "File too large to preview");
    }

    const buffer = await fs.readFile(safeFilePath);

    if (buffer.byteLength > MAX_FILE_PREVIEW_BYTES) {
      throw new FileServiceError("FILE_TOO_LARGE", "File too large to preview");
    }

    if (isLikelyBinary(buffer)) {
      throw new FileServiceError(
        "BINARY_FILE",
        "Binary file preview is not supported"
      );
    }

    return {
      relativePath,
      content: buffer.toString("utf8"),
      language: inferLanguage(relativePath),
      size: buffer.byteLength
    };
  } catch (error) {
    throw toFileServiceError(error, "Failed to read file.");
  }
}

export async function writeWorkspaceTextFile(
  input: WriteWorkspaceFileInput,
  db?: AgentHubDatabase
): Promise<FileContent> {
  const normalizedInput = normalizeWriteInput(input);

  try {
    if (normalizedInput.content.includes("\0")) {
      throw new FileServiceError("BINARY_FILE", "Binary file writes are not supported.");
    }

    const guard = getWorkspacePathGuard(
      normalizedInput.workspaceId,
      db,
      normalizedInput.conversationId
    );
    const { absolutePath, relativePath } = guard.resolve(normalizedInput.relativePath);
    const safeFilePath = guard.assertInside(absolutePath);

    await fs.mkdir(path.dirname(safeFilePath), { recursive: true });
    await fs.writeFile(safeFilePath, normalizedInput.content, "utf8");

    return {
      relativePath,
      content: normalizedInput.content,
      language: inferLanguage(relativePath),
      size: Buffer.byteLength(normalizedInput.content, "utf8")
    };
  } catch (error) {
    throw toFileServiceError(error, "Failed to write file.");
  }
}
