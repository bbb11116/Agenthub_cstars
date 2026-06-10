import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import type {
  ApplyDiffInput,
  ApplyDiffResult,
  CreateDiffProposalInput,
  DiffProposal,
  RejectDiffInput
} from "../../shared/diff";
import type { ToolPermissionError } from "../../shared/domain";
import { getDatabase, type AgentHubDatabase } from "../db";
import { getAgentById } from "../db/repositories/agentRepo";
import { getConversationById } from "../db/repositories/conversationRepo";
import { getMember } from "../db/repositories/conversationMemberRepo";
import { getDispatchRunById } from "../db/repositories/dispatchRunRepo";
import { getDispatchStepById } from "../db/repositories/dispatchStepRepo";
import {
  createDiffProposal as insertDiffProposal,
  getDiffProposalById,
  getDiffProposalsByWorkspace,
  updateDiffProposal
} from "../db/repositories/diffRepo";
import { getArtifactsByConversation, updateArtifact as updateArtifactRow } from "../db/repositories/artifactRepo";
import { createContentHash } from "../utils/hash";
import {
  createWorkspacePathGuard,
  PathGuardError,
  type WorkspacePathGuard
} from "../utils/pathGuard";
import { createUnifiedDiff } from "../utils/unifiedDiff";
import {
  attachArtifactPreviewToMessage,
  createArtifact,
  inferOfficeArtifactType,
  inferPreviewArtifactType,
  isOfficeFormat,
  updateArtifactContent
} from "./artifactService";
import { findOfficeConverter, scheduleArtifactRender } from "./artifactRenderService";
import { writeWorkspaceTextFile } from "./fileService";
import { readGitStatus } from "./gitService";
import { createMessage } from "./messageService";
import { applyUnifiedDiffToContent } from "./diffProposalTextService";
import {
  assertAgentCanUseTool,
  ToolPermissionServiceError
} from "./toolPermissionService";
import { resolveExecutionWorkspace } from "./workspaceContextResolver";

const execFileAsync = promisify(execFile);
const BINARY_SAMPLE_BYTES = 8192;
const DIFF_APPLIED_SUCCESS_TEXT = "Diff applied successfully";
const DIFF_CONFLICT_TEXT = "文件已被修改，请重新生成 Diff。";
const SECURITY_BLOCKED_MESSAGE =
  "Security blocked:\nFile access outside workspace is not allowed.";

type DiffServiceErrorCode =
  | "INVALID_INPUT"
  | "WORKSPACE_NOT_FOUND"
  | "AGENT_NOT_FOUND"
  | "CONVERSATION_NOT_FOUND"
  | "TOOL_PERMISSION_DENIED"
  | "PATH_OUTSIDE_WORKSPACE"
  | "FILE_NOT_FOUND"
  | "PERMISSION_DENIED"
  | "NOT_A_FILE"
  | "BINARY_FILE"
  | "NO_CHANGES"
  | "NOT_PENDING"
  | "WRITE_FAILED"
  | "READ_FAILED";

export class DiffServiceError extends Error {
  readonly code: DiffServiceErrorCode;
  readonly agentId?: string;
  readonly tool?: ToolPermissionError["tool"];
  readonly path?: string;

  constructor(
    code: DiffServiceErrorCode,
    message: string,
    options: ErrorOptions & Partial<Pick<ToolPermissionError, "agentId" | "tool" | "path">> = {}
  ) {
    super(message, options);
    this.name = "DiffServiceError";
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

function assertNonEmptyString(value: unknown, label: string): asserts value is string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new DiffServiceError("INVALID_INPUT", `${label} is required.`);
  }
}

function normalizeCreateInput(input: CreateDiffProposalInput): CreateDiffProposalInput {
  if (!input || typeof input !== "object") {
    throw new DiffServiceError("INVALID_INPUT", "Diff proposal input is required.");
  }

  assertNonEmptyString(input.workspaceId, "workspaceId");
  assertNonEmptyString(input.agentId, "agentId");
  assertNonEmptyString(input.conversationId, "conversationId");
  assertNonEmptyString(input.filePath, "filePath");

  if (typeof input.newContent !== "string" && typeof input.unifiedDiff !== "string") {
    throw new DiffServiceError("INVALID_INPUT", "newContent or unifiedDiff is required.");
  }

  return {
    workspaceId: input.workspaceId.trim(),
    agentId: input.agentId.trim(),
    conversationId: input.conversationId.trim(),
    filePath: input.filePath.trim(),
    newContent: input.newContent,
    unifiedDiff: input.unifiedDiff,
    isNewFile: input.isNewFile,
    dispatchRunId: input.dispatchRunId?.trim(),
    dispatchStepId: input.dispatchStepId?.trim()
  };
}

function normalizeApplyInput(input: ApplyDiffInput): ApplyDiffInput {
  if (!input || typeof input !== "object") {
    throw new DiffServiceError("INVALID_INPUT", "Diff apply input is required.");
  }

  assertNonEmptyString(input.workspaceId, "workspaceId");
  assertNonEmptyString(input.diffProposalId, "diffProposalId");

  return {
    workspaceId: input.workspaceId.trim(),
    diffProposalId: input.diffProposalId.trim(),
    agentId:
      input.agentId === undefined
        ? undefined
        : assertNonEmptyStringValue(input.agentId, "agentId")
  };
}

function assertNonEmptyStringValue(value: unknown, label: string): string {
  assertNonEmptyString(value, label);
  return value.trim();
}

function toDiffServiceError(error: unknown, fallbackMessage: string): DiffServiceError {
  if (error instanceof DiffServiceError) {
    return error;
  }

  if (error instanceof ToolPermissionServiceError) {
    return new DiffServiceError("TOOL_PERMISSION_DENIED", error.message, {
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

    return new DiffServiceError(code, message, {
      cause: error,
      path: error.path
    });
  }

  const code = getErrorCode(error);

  if (code === "ENOENT") {
    return new DiffServiceError("FILE_NOT_FOUND", "File does not exist.", {
      cause: error
    });
  }

  if (code === "EACCES" || code === "EPERM") {
    return new DiffServiceError("PERMISSION_DENIED", "Permission denied.", {
      cause: error
    });
  }

  return new DiffServiceError("READ_FAILED", fallbackMessage, { cause: error });
}

function isLikelyBinaryBuffer(buffer: Buffer): boolean {
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

  return sample.toString("utf8").includes("\uFFFD");
}

function isLikelyBinaryText(content: string): boolean {
  return content.includes("\0");
}

function summarizeDiff(diffContent: string): string {
  let additions = 0;
  let deletions = 0;

  diffContent.split("\n").forEach((line) => {
    if (line.startsWith("+++") || line.startsWith("---")) {
      return;
    }

    if (line.startsWith("+")) {
      additions += 1;
    }

    if (line.startsWith("-")) {
      deletions += 1;
    }
  });

  return `${additions} additions, ${deletions} deletions`;
}

function getWorkspaceGuard(
  workspaceId: string,
  db: AgentHubDatabase,
  conversationId?: string
): WorkspacePathGuard {
  const resolved = resolveExecutionWorkspace({ workspaceId, conversationId }, db);
  return createWorkspacePathGuard(resolved.rootPath);
}

function assertDiffContext(input: CreateDiffProposalInput, db: AgentHubDatabase): void {
  const agent = getAgentById(input.agentId, db);

  if (!agent) {
    throw new DiffServiceError("AGENT_NOT_FOUND", "Agent does not exist.");
  }

  const conversation = getConversationById(input.conversationId, db);

  if (!conversation) {
    throw new DiffServiceError("CONVERSATION_NOT_FOUND", "Conversation does not exist.");
  }

  if (conversation.workspaceId !== input.workspaceId) {
    throw new DiffServiceError(
      "INVALID_INPUT",
      "Conversation does not belong to the workspace."
    );
  }

  if (conversation.type !== "group" && conversation.agentId !== input.agentId) {
    throw new DiffServiceError("INVALID_INPUT", "Agent does not match the conversation.");
  }

  if (conversation.type !== "group") {
    if (agent.workspaceId !== input.workspaceId) {
      throw new DiffServiceError("INVALID_INPUT", "Agent does not belong to the workspace.");
    }
    return;
  }

  if (conversation.mainAgentId === input.agentId) {
    throw new DiffServiceError(
      "INVALID_INPUT",
      "Group orchestrator cannot create DiffProposal."
    );
  }

  const member = getMember(conversation.id, "agent", input.agentId, db);
  if (!member || member.status !== "active") {
    throw new DiffServiceError(
      "INVALID_INPUT",
      "Agent is not an active member of this group conversation."
    );
  }

  if (!input.dispatchRunId || !input.dispatchStepId) {
    throw new DiffServiceError(
      "INVALID_INPUT",
      "Group DiffProposal must be bound to a dispatch step."
    );
  }

  const dispatchRun = getDispatchRunById(input.dispatchRunId, db);
  const dispatchStep = getDispatchStepById(input.dispatchStepId, db);
  if (
    !dispatchRun ||
    dispatchRun.conversationId !== conversation.id ||
    !dispatchStep ||
    dispatchStep.dispatchRunId !== dispatchRun.id ||
    dispatchStep.agentId !== input.agentId
  ) {
    throw new DiffServiceError(
      "INVALID_INPUT",
      "DiffProposal dispatch binding does not match this group sub-agent."
    );
  }
}

function ensureProposalForWorkspace(
  proposal: DiffProposal | null,
  workspaceId: string
): DiffProposal | null {
  if (!proposal || proposal.workspaceId !== workspaceId) {
    return null;
  }

  return proposal;
}

function updateProposalStatus(
  proposal: DiffProposal,
  status: DiffProposal["status"],
  db: AgentHubDatabase,
  appliedAt?: string
): DiffProposal {
  return (
    updateDiffProposal(
      proposal.id,
      {
        status,
        appliedAt
      },
      db
    ) ?? {
      ...proposal,
      status,
      appliedAt
    }
  );
}

function createFailedApplyResult(
  diffProposal: DiffProposal | null,
  error: string
): ApplyDiffResult {
  return {
    status: "failed",
    diffProposal,
    error
  };
}

async function readExistingTextFile(
  guard: WorkspacePathGuard,
  relativePath: string
): Promise<{ content: string; relativePath: string }> {
  const { absolutePath, relativePath: normalizedRelativePath } = guard.resolve(relativePath);
  const safeFilePath = guard.assertInside(absolutePath);
  const stats = await fs.stat(safeFilePath);

  if (!stats.isFile()) {
    throw new DiffServiceError("NOT_A_FILE", "Selected path is not a file.");
  }

  const buffer = await fs.readFile(safeFilePath);

  if (isLikelyBinaryBuffer(buffer)) {
    throw new DiffServiceError("BINARY_FILE", "Binary file diff is not supported.");
  }

  return {
    content: buffer.toString("utf8"),
    relativePath: normalizedRelativePath
  };
}

export async function createDiffProposal(
  input: CreateDiffProposalInput,
  db: AgentHubDatabase = getDatabase()
): Promise<DiffProposal> {
  const normalizedInput = normalizeCreateInput(input);

  try {
    assertAgentCanUseTool(
      {
        agentId: normalizedInput.agentId,
        tool: "writeDiff"
      },
      db
    );
    assertDiffContext(normalizedInput, db);

    const guard = getWorkspaceGuard(
      normalizedInput.workspaceId,
      db,
      normalizedInput.conversationId
    );

    let oldContent: string;
    let relativePath: string;
    if (normalizedInput.isNewFile) {
      const resolved = guard.resolve(normalizedInput.filePath);
      guard.assertInside(resolved.absolutePath);
      oldContent = "";
      relativePath = resolved.relativePath;
    } else {
      const oldFile = await readExistingTextFile(guard, normalizedInput.filePath);
      oldContent = oldFile.content;
      relativePath = oldFile.relativePath;
    }

    let newContent: string;
    let diffContent: string;
    if (typeof normalizedInput.unifiedDiff === "string") {
      const derived = applyUnifiedDiffToContent(oldContent, normalizedInput.unifiedDiff);
      if (derived === null) {
        throw new DiffServiceError(
          "INVALID_INPUT",
          "Unified diff does not apply to the current file."
        );
      }
      newContent = derived;
      diffContent = normalizedInput.unifiedDiff;
    } else {
      newContent = normalizedInput.newContent ?? "";
      if (oldContent === newContent) {
        throw new DiffServiceError("NO_CHANGES", "No changes to propose.");
      }
      diffContent = createUnifiedDiff({
        oldFilePath: relativePath,
        newFilePath: relativePath,
        oldContent,
        newContent
      });
    }

    if (isLikelyBinaryText(newContent)) {
      throw new DiffServiceError("BINARY_FILE", "Binary file diff is not supported.");
    }

    const oldContentHash = createContentHash(oldContent);
    const newContentHash = createContentHash(newContent);
    const summary = summarizeDiff(diffContent);
    const saveProposalAndMessage = db.transaction(() => {
      const proposal = insertDiffProposal(
        {
          workspaceId: normalizedInput.workspaceId,
          agentId: normalizedInput.agentId,
          conversationId: normalizedInput.conversationId,
          filePath: relativePath,
          oldContentHash,
          newContentHash,
          diffContent,
          newContent,
          status: "pending",
          dispatchRunId: normalizedInput.dispatchRunId,
          dispatchStepId: normalizedInput.dispatchStepId
        },
        db
      );

      createArtifact(
        {
          workspaceId: normalizedInput.workspaceId,
          agentId: normalizedInput.agentId,
          conversationId: normalizedInput.conversationId,
          type: "diff",
          title: `${proposal.filePath} proposal`,
          content: proposal.diffContent,
          language: "diff",
          filePath: proposal.filePath
        },
        db
      );

      const message = createMessage(
        {
          workspaceId: normalizedInput.workspaceId,
          conversationId: normalizedInput.conversationId,
          senderType: "agent",
          senderId: normalizedInput.agentId,
          messageType: "diff_card",
          content: {
            diffProposalId: proposal.id,
            filePath: proposal.filePath,
            summary
          },
          dispatchRunId: normalizedInput.dispatchRunId,
          dispatchStepId: normalizedInput.dispatchStepId
        },
        db
      );

      const previewType = inferPreviewArtifactType(undefined, proposal.filePath);
      if (previewType) {
        const previewArtifact = createArtifact(
          {
            workspaceId: normalizedInput.workspaceId,
            agentId: normalizedInput.agentId,
            conversationId: normalizedInput.conversationId,
            type: previewType,
            title: proposal.filePath,
            content: proposal.newContent,
            language: previewType,
            filePath: proposal.filePath
          },
          db
        );
        attachArtifactPreviewToMessage(
          {
            messageId: message.id,
            conversationId: normalizedInput.conversationId,
            artifact: previewArtifact
          },
          db
        );
      }

      return updateDiffProposal(
        proposal.id,
        {
          messageId: message.id
        },
        db
      ) ?? proposal;
    });

    return saveProposalAndMessage();
  } catch (error) {
    throw toDiffServiceError(error, "Failed to create diff proposal.");
  }
}

export function getDiffProposal(
  id: string,
  db: AgentHubDatabase = getDatabase()
): DiffProposal {
  assertNonEmptyString(id, "diffProposalId");
  const proposal = getDiffProposalById(id.trim(), db);

  if (!proposal) {
    throw new DiffServiceError("INVALID_INPUT", "Diff proposal does not exist.");
  }

  return proposal;
}

export function listDiffProposalsByWorkspace(
  workspaceId: string,
  db: AgentHubDatabase = getDatabase()
): DiffProposal[] {
  assertNonEmptyString(workspaceId, "workspaceId");
  return getDiffProposalsByWorkspace(workspaceId.trim(), db);
}

export async function applyDiff(
  input: ApplyDiffInput,
  db: AgentHubDatabase = getDatabase()
): Promise<ApplyDiffResult> {
  let normalizedInput: ApplyDiffInput;

  try {
    normalizedInput = normalizeApplyInput(input);
  } catch (error) {
    return createFailedApplyResult(null, toDiffServiceError(error, "Invalid apply input.").message);
  }

  if (normalizedInput.agentId) {
    try {
      assertAgentCanUseTool(
        {
          agentId: normalizedInput.agentId,
          tool: "applyDiff"
        },
        db
      );
    } catch (error) {
      return createFailedApplyResult(
        null,
        toDiffServiceError(error, "Failed to apply diff.").message
      );
    }
  }

  const proposal = ensureProposalForWorkspace(
    getDiffProposalById(normalizedInput.diffProposalId, db),
    normalizedInput.workspaceId
  );

  if (!proposal) {
    return createFailedApplyResult(null, "DiffProposal does not exist.");
  }

  if (proposal.status !== "pending") {
    return createFailedApplyResult(
      proposal,
      "Only pending diff proposals can be applied."
    );
  }

  try {
    if (proposal.newContent === "" && proposal.newContentHash !== createContentHash("")) {
      const failedProposal = updateProposalStatus(proposal, "failed", db);

      return createFailedApplyResult(
        failedProposal,
        "Diff proposal content is unavailable. Please regenerate the diff."
      );
    }

    const guard = getWorkspaceGuard(
      normalizedInput.workspaceId,
      db,
      proposal.conversationId
    );

    const isNewFileProposal = proposal.oldContentHash === createContentHash("");
    if (isNewFileProposal) {
      const resolved = guard.resolve(proposal.filePath);
      const safeFilePath = guard.assertInside(resolved.absolutePath);
      let existsAndNonEmpty = false;
      try {
        const stats = await fs.stat(safeFilePath);
        if (stats.isFile() && stats.size > 0) {
          existsAndNonEmpty = true;
        }
      } catch (error) {
        if (getErrorCode(error) !== "ENOENT") {
          throw error;
        }
      }
      if (existsAndNonEmpty) {
        const conflictedProposal = updateProposalStatus(proposal, "conflicted", db);

        return {
          status: "conflicted",
          diffProposal: conflictedProposal,
          error: "目标文件已存在且非空，无法以新建语义应用。请用普通 SEARCH/REPLACE 重新生成 DiffProposal。"
        };
      }
    } else {
      const currentFile = await readExistingTextFile(guard, proposal.filePath);
      const currentHash = createContentHash(currentFile.content);

      if (currentHash !== proposal.oldContentHash) {
        const conflictedProposal = updateProposalStatus(proposal, "conflicted", db);

        return {
          status: "conflicted",
          diffProposal: conflictedProposal,
          error: DIFF_CONFLICT_TEXT
        };
      }
    }

    const officeConversion = isOfficeFormat(proposal.filePath);
    let officeConversionFailed = false;

    if (officeConversion) {
      try {
        await convertHtmlToOfficeFile(
          proposal.newContent,
          proposal.filePath,
          guard.rootPath
        );
      } catch (error) {
        // LibreOffice not available or conversion failed — fall back to writing HTML
        officeConversionFailed = true;
        console.warn("Office conversion failed, falling back to HTML write.", error);
        await writeWorkspaceTextFile(
          {
            workspaceId: normalizedInput.workspaceId,
            conversationId: proposal.conversationId,
            relativePath: proposal.filePath,
            content: proposal.newContent
          },
          db
        );
      }
    } else {
      await writeWorkspaceTextFile(
        {
          workspaceId: normalizedInput.workspaceId,
          conversationId: proposal.conversationId,
          relativePath: proposal.filePath,
          content: proposal.newContent
        },
        db
      );
    }

    const warningText = officeConversionFailed
      ? "\n\n⚠ LibreOffice 未安装或转换失败，已写入 HTML 源文件。请安装 LibreOffice 以获得自动格式转换。"
      : "";
    const markApplied = db.transaction((pendingProposal: DiffProposal) => {
      const appliedProposal = updateProposalStatus(
        pendingProposal,
        "applied",
        db,
        new Date().toISOString()
      );

      createMessage(
        {
          workspaceId: appliedProposal.workspaceId,
          conversationId: appliedProposal.conversationId,
          senderType: "system",
          senderId: "diff-apply",
          messageType: "text",
          content: {
            text: DIFF_APPLIED_SUCCESS_TEXT + warningText
          }
        },
        db
      );

      return appliedProposal;
    });
    const appliedProposal = markApplied(proposal);

    try {
      const previewArtifact = getArtifactsByConversation(proposal.conversationId, db).find(
        (artifact) => artifact.type !== "diff" && artifact.filePath === proposal.filePath
      );
      if (previewArtifact) {
        if (officeConversion && !officeConversionFailed) {
          const officeType = inferOfficeArtifactType(proposal.filePath);
          updateArtifactRow(
            previewArtifact.id,
            { type: officeType, content: proposal.newContent },
            db
          );
          scheduleArtifactRender(previewArtifact.id, db);
        } else if (previewArtifact.content !== proposal.newContent) {
          updateArtifactContent(
            { artifactId: previewArtifact.id, content: proposal.newContent },
            db
          );
        }
      }
    } catch (error) {
      console.warn("Failed to refresh preview artifact after diff apply.", error);
    }

    try {
      const gitStatus = await readGitStatus(
        {
          workspaceId: normalizedInput.workspaceId,
          conversationId: proposal.conversationId
        },
        db
      );

      return {
        status: "applied",
        diffProposal: appliedProposal,
        gitStatus
      };
    } catch {
      return {
        status: "applied",
        diffProposal: appliedProposal,
        error: "Git refresh failed."
      };
    }
  } catch (error) {
    const failedProposal = updateProposalStatus(proposal, "failed", db);
    const diffError = toDiffServiceError(error, "Failed to apply diff.");

    return createFailedApplyResult(failedProposal, diffError.message);
  }
}

async function convertHtmlToOfficeFile(
  htmlContent: string,
  targetRelativePath: string,
  workspaceRootPath: string
): Promise<void> {
  const converter = await findOfficeConverter();
  if (!converter) {
    throw new DiffServiceError(
      "INVALID_INPUT",
      "LibreOffice is not installed. Cannot convert HTML to office format. Install LibreOffice or set AGENTHUB_SOFFICE_PATH."
    );
  }

  const targetExt = path.extname(targetRelativePath).replace(".", "");
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "agenthub-office-convert-"));
  const tmpHtmlPath = path.join(tmpDir, "source.html");

  try {
    await fs.writeFile(tmpHtmlPath, htmlContent, "utf8");
    await execFileAsync(
      converter,
      ["--headless", "--convert-to", targetExt, "--outdir", tmpDir, tmpHtmlPath],
      { timeout: 60_000 }
    );

    const convertedFileName = `source.${targetExt}`;
    const convertedPath = path.join(tmpDir, convertedFileName);

    const targetAbsPath = path.resolve(workspaceRootPath, targetRelativePath);
    await fs.mkdir(path.dirname(targetAbsPath), { recursive: true });
    await fs.copyFile(convertedPath, targetAbsPath);
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  }
}

export function rejectDiffProposal(
  input: RejectDiffInput,
  db: AgentHubDatabase = getDatabase()
): DiffProposal {
  const normalizedInput = normalizeApplyInput(input);
  const proposal = ensureProposalForWorkspace(
    getDiffProposalById(normalizedInput.diffProposalId, db),
    normalizedInput.workspaceId
  );

  if (!proposal) {
    throw new DiffServiceError("INVALID_INPUT", "Diff proposal does not exist.");
  }

  if (proposal.status !== "pending") {
    throw new DiffServiceError("NOT_PENDING", "Only pending diff proposals can be rejected.");
  }

  return updateProposalStatus(proposal, "rejected", db);
}
