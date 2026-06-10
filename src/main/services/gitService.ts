import { promises as fs } from "node:fs";
import path from "node:path";
import type {
  GitDiff,
  GitFileStatus,
  GitFileStatusLabel,
  GitStatus,
  ReadGitDiffInput,
  ReadGitStatusInput
} from "../../shared/git";
import type { ToolPermissionError } from "../../shared/domain";
import type { AgentHubDatabase } from "../db";
import {
  CommandRunnerError,
  runCommand,
  type CommandRunResult
} from "../utils/commandRunner";
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

const GIT_COMMAND_TIMEOUT_MS = 5000;
const MAX_GIT_OUTPUT_BYTES = 256 * 1024;
const DIFF_TRUNCATED_NOTICE =
  "\n\n[Diff truncated because it is too large to display fully.]";
const SECURITY_BLOCKED_MESSAGE =
  "Security blocked:\nFile access outside workspace is not allowed.";

type GitServiceErrorCode =
  | "INVALID_INPUT"
  | "WORKSPACE_NOT_FOUND"
  | "TOOL_PERMISSION_DENIED"
  | "PATH_OUTSIDE_WORKSPACE"
  | "NOT_GIT_REPO"
  | "GIT_UNAVAILABLE"
  | "TIMEOUT"
  | "PERMISSION_DENIED"
  | "GIT_COMMAND_FAILED";

export class GitServiceError extends Error {
  readonly code: GitServiceErrorCode;
  readonly agentId?: string;
  readonly tool?: ToolPermissionError["tool"];
  readonly path?: string;

  constructor(
    code: GitServiceErrorCode,
    message: string,
    options: ErrorOptions & Partial<Pick<ToolPermissionError, "agentId" | "tool" | "path">> = {}
  ) {
    super(message, options);
    this.name = "GitServiceError";
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

function normalizeStatus(status: string): string {
  return status === " " ? "" : status;
}

function labelGitStatus(indexStatus: string, worktreeStatus: string): GitFileStatusLabel {
  if (indexStatus === "?" && worktreeStatus === "?") {
    return "untracked";
  }

  if (indexStatus === "R" || worktreeStatus === "R") {
    return "renamed";
  }

  if (indexStatus === "A" || worktreeStatus === "A") {
    return "added";
  }

  if (indexStatus === "D" || worktreeStatus === "D") {
    return "deleted";
  }

  if (indexStatus === "M" || worktreeStatus === "M") {
    return "modified";
  }

  return "unknown";
}

function parseStatusPath(rawPath: string, label: GitFileStatusLabel): string {
  if (label !== "renamed") {
    return rawPath;
  }

  const renameSeparator = " -> ";
  const separatorIndex = rawPath.lastIndexOf(renameSeparator);

  return separatorIndex >= 0
    ? rawPath.slice(separatorIndex + renameSeparator.length)
    : rawPath;
}

export function parseGitStatusOutput(output: string): GitFileStatus[] {
  return output
    .split(/\r?\n/)
    .map((line) => line.trimEnd())
    .filter((line) => line.length >= 2)
    .map((line) => {
      const indexStatus = normalizeStatus(line[0] ?? "");
      const worktreeStatus = normalizeStatus(line[1] ?? "");
      const label = labelGitStatus(indexStatus, worktreeStatus);
      const rawPath = line.length > 3 ? line.slice(3) : "";

      return {
        path: parseStatusPath(rawPath, label),
        indexStatus,
        worktreeStatus,
        label
      };
    })
    .filter((fileStatus) => fileStatus.path.length > 0);
}

function normalizeStatusInput(input: ReadGitStatusInput): ReadGitStatusInput {
  if (!input || typeof input !== "object" || typeof input.workspaceId !== "string") {
    throw new GitServiceError("INVALID_INPUT", "Workspace id is required.");
  }

  return {
    workspaceId: input.workspaceId,
    conversationId: input.conversationId,
    agentId:
      input.agentId === undefined
        ? undefined
        : normalizeOptionalAgentId(input.agentId, "agentId")
  };
}

function normalizeOptionalAgentId(value: unknown, label: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new GitServiceError("INVALID_INPUT", `${label} is required.`);
  }

  return value.trim();
}

function normalizeDiffInput(input: ReadGitDiffInput): ReadGitDiffInput {
  if (!input || typeof input !== "object" || typeof input.workspaceId !== "string") {
    throw new GitServiceError("INVALID_INPUT", "Workspace id is required.");
  }

  if (input.filePath !== undefined && typeof input.filePath !== "string") {
    throw new GitServiceError("INVALID_INPUT", "File path must be a string.");
  }

  return {
    workspaceId: input.workspaceId,
    conversationId: input.conversationId,
    filePath: input.filePath?.trim() || undefined
  };
}

function getWorkspaceGuard(
  workspaceId: string,
  db?: AgentHubDatabase,
  conversationId?: string
): WorkspacePathGuard {
  if (!conversationId) {
    const workspace = getWorkspaceById(workspaceId, db);
    if (!workspace) {
      throw new GitServiceError("WORKSPACE_NOT_FOUND", "Workspace not found.");
    }
    return createWorkspacePathGuard(workspace.rootPath);
  }
  const resolved = resolveExecutionWorkspace({ workspaceId, conversationId }, db);
  return createWorkspacePathGuard(resolved.rootPath);
}

async function isGitRepository(guard: WorkspacePathGuard): Promise<boolean> {
  const gitPath = path.join(guard.rootPath, ".git");
  const safeGitPath = guard.assertInside(gitPath);

  try {
    const stats = await fs.lstat(safeGitPath);
    return stats.isDirectory() || stats.isFile() || stats.isSymbolicLink();
  } catch (error) {
    const code = getErrorCode(error);

    if (code === "ENOENT") {
      return false;
    }

    if (code === "EACCES" || code === "EPERM") {
      throw new GitServiceError("PERMISSION_DENIED", "Permission denied.", {
        cause: error
      });
    }

    throw new GitServiceError("GIT_COMMAND_FAILED", "Unable to inspect Git metadata.", {
      cause: error
    });
  }
}

function isNotGitRepositoryError(error: unknown): boolean {
  if (!(error instanceof CommandRunnerError)) {
    return false;
  }

  const stderr = error.result?.stderr ?? error.message;
  return /not a git repository|not a git work tree/i.test(stderr);
}

function toGitServiceError(error: unknown, fallbackMessage: string): GitServiceError {
  if (error instanceof GitServiceError) {
    return error;
  }

  if (error instanceof ToolPermissionServiceError) {
    return new GitServiceError("TOOL_PERMISSION_DENIED", error.message, {
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
            : "GIT_COMMAND_FAILED";
    const message = code === "PATH_OUTSIDE_WORKSPACE" ? SECURITY_BLOCKED_MESSAGE : error.message;

    return new GitServiceError(code, message, {
      cause: error,
      path: error.path
    });
  }

  if (error instanceof CommandRunnerError) {
    if (error.code === "COMMAND_UNAVAILABLE") {
      return new GitServiceError("GIT_UNAVAILABLE", "Git unavailable", {
        cause: error
      });
    }

    if (error.code === "TIMEOUT") {
      return new GitServiceError("TIMEOUT", "Timeout", { cause: error });
    }

    if (error.code === "PERMISSION_DENIED") {
      return new GitServiceError("PERMISSION_DENIED", "Permission denied.", {
        cause: error
      });
    }

    return new GitServiceError(
      "GIT_COMMAND_FAILED",
      error.result?.stderr.trim() || fallbackMessage,
      {
        cause: error
      }
    );
  }

  return new GitServiceError("GIT_COMMAND_FAILED", fallbackMessage, { cause: error });
}

async function runGit(
  guard: WorkspacePathGuard,
  args: string[],
  maxOutputBytes = MAX_GIT_OUTPUT_BYTES
): Promise<CommandRunResult> {
  return runCommand("git", args, {
    cwd: guard.rootPath,
    timeoutMs: GIT_COMMAND_TIMEOUT_MS,
    maxOutputBytes
  });
}

function createNonGitStatus(workspaceId: string): GitStatus {
  return {
    workspaceId,
    isGitRepo: false,
    files: []
  };
}

export async function readGitStatus(
  input: ReadGitStatusInput,
  db?: AgentHubDatabase
): Promise<GitStatus> {
  const normalizedInput = normalizeStatusInput(input);

  try {
    if (normalizedInput.agentId) {
      assertAgentCanUseTool(
        {
          agentId: normalizedInput.agentId,
          tool: "gitStatus"
        },
        db
      );
    }

    const guard = getWorkspaceGuard(
      normalizedInput.workspaceId,
      db,
      normalizedInput.conversationId
    );

    if (!(await isGitRepository(guard))) {
      return createNonGitStatus(normalizedInput.workspaceId);
    }

    const [branchResult, statusResult] = await Promise.all([
      runGit(guard, ["branch", "--show-current"]),
      runGit(guard, ["status", "--short"])
    ]);
    const branch = branchResult.stdout.trim();

    return {
      workspaceId: normalizedInput.workspaceId,
      isGitRepo: true,
      branch: branch || undefined,
      files: parseGitStatusOutput(statusResult.stdout)
    };
  } catch (error) {
    if (isNotGitRepositoryError(error)) {
      return createNonGitStatus(normalizedInput.workspaceId);
    }

    throw toGitServiceError(error, "Failed to read Git status.");
  }
}

export async function readGitDiff(
  input: ReadGitDiffInput,
  db?: AgentHubDatabase
): Promise<GitDiff> {
  const normalizedInput = normalizeDiffInput(input);

  try {
    const guard = getWorkspaceGuard(
      normalizedInput.workspaceId,
      db,
      normalizedInput.conversationId
    );

    if (!(await isGitRepository(guard))) {
      throw new GitServiceError("NOT_GIT_REPO", "This workspace is not a Git repository.");
    }

    const args = normalizedInput.filePath
      ? ["diff", "--", guard.resolve(normalizedInput.filePath).relativePath]
      : ["diff"];
    const diffResult = await runGit(guard, args);
    const diff = diffResult.truncated
      ? `${diffResult.stdout}${DIFF_TRUNCATED_NOTICE}`
      : diffResult.stdout;

    return {
      workspaceId: normalizedInput.workspaceId,
      filePath: normalizedInput.filePath,
      diff,
      truncated: diffResult.truncated
    };
  } catch (error) {
    if (isNotGitRepositoryError(error)) {
      throw new GitServiceError("NOT_GIT_REPO", "This workspace is not a Git repository.", {
        cause: error
      });
    }

    throw toGitServiceError(error, "Failed to read Git diff.");
  }
}
