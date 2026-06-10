import path from "node:path";
import type {
  Artifact,
  ArtifactType,
  CreateArtifactInput,
  PreviewArtifactInput
} from "../../shared/artifact";
import { isArtifactType } from "../../shared/artifact";
import type { Message, ToolPermissionError } from "../../shared/domain";
import { getDatabase, type AgentHubDatabase } from "../db";
import {
  createArtifact as insertArtifact,
  getArtifactById,
  getArtifactsByWorkspace,
  updateArtifact as updateArtifactRow
} from "../db/repositories/artifactRepo";
import { createMessageArtifact } from "../db/repositories/messageArtifactRepo";
import { getAgentById } from "../db/repositories/agentRepo";
import { getConversationById } from "../db/repositories/conversationRepo";
import { getMember } from "../db/repositories/conversationMemberRepo";
import { getWorkspaceById } from "../db/repositories/workspaceRepo";
import { createWorkspacePathGuard, PathGuardError } from "../utils/pathGuard";
import {
  assertAgentCanUseTool,
  ToolPermissionServiceError
} from "./toolPermissionService";
import {
  getInitialRenderManifest,
  scheduleArtifactRender
} from "./artifactRenderService";
import { resolveExecutionWorkspaceForConversation } from "./workspaceContextResolver";

type ArtifactServiceErrorCode =
  | "INVALID_INPUT"
  | "WORKSPACE_NOT_FOUND"
  | "AGENT_NOT_FOUND"
  | "CONVERSATION_NOT_FOUND"
  | "TOOL_PERMISSION_DENIED"
  | "ARTIFACT_NOT_FOUND"
  | "PATH_OUTSIDE_WORKSPACE";

export class ArtifactServiceError extends Error {
  readonly code: ArtifactServiceErrorCode;
  readonly agentId?: string;
  readonly tool?: ToolPermissionError["tool"];
  readonly path?: string;

  constructor(
    code: ArtifactServiceErrorCode,
    message: string,
    options: ErrorOptions & Partial<Pick<ToolPermissionError, "agentId" | "tool" | "path">> = {}
  ) {
    super(message, options);
    this.name = "ArtifactServiceError";
    this.code = code;
    this.agentId = options.agentId;
    this.tool = options.tool;
    this.path = options.path;
  }
}

const SECURITY_BLOCKED_MESSAGE =
  "Security blocked:\nFile access outside workspace is not allowed.";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function assertNonEmptyString(value: unknown, label: string): asserts value is string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new ArtifactServiceError("INVALID_INPUT", `${label} is required.`);
  }
}

function normalizeOptionalString(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }

  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function normalizeVersion(value: unknown): number {
  if (value === undefined) {
    return 1;
  }

  if (typeof value !== "number" || !Number.isInteger(value) || value <= 0) {
    throw new ArtifactServiceError("INVALID_INPUT", "version must be a positive integer.");
  }

  return value;
}

function toArtifactServiceError(error: unknown, fallbackMessage: string): ArtifactServiceError {
  if (error instanceof ArtifactServiceError) {
    return error;
  }

  if (error instanceof ToolPermissionServiceError) {
    return new ArtifactServiceError("TOOL_PERMISSION_DENIED", error.message, {
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
          : "INVALID_INPUT";
    const message = code === "PATH_OUTSIDE_WORKSPACE" ? SECURITY_BLOCKED_MESSAGE : error.message;

    return new ArtifactServiceError(code, message, {
      cause: error,
      path: error.path
    });
  }

  return new ArtifactServiceError("INVALID_INPUT", fallbackMessage, { cause: error });
}

function normalizePreviewArtifactInput(
  input: string | PreviewArtifactInput
): Required<Pick<PreviewArtifactInput, "artifactId">> &
  Pick<PreviewArtifactInput, "agentId"> {
  if (typeof input === "string") {
    assertNonEmptyString(input, "artifactId");

    return {
      artifactId: input.trim()
    };
  }

  if (!isRecord(input)) {
    throw new ArtifactServiceError("INVALID_INPUT", "artifactId is required.");
  }

  assertNonEmptyString(input.artifactId, "artifactId");

  const agentId = input.agentId;
  const normalizedAgentId =
    agentId === undefined
      ? undefined
      : (() => {
          assertNonEmptyString(agentId, "agentId");
          return agentId.trim();
        })();

  return {
    artifactId: input.artifactId.trim(),
    agentId: normalizedAgentId
  };
}

function normalizeArtifactFilePath(
  workspaceRootPath: string,
  filePath: unknown
): string | undefined {
  const normalizedFilePath = normalizeOptionalString(filePath);

  if (!normalizedFilePath) {
    return undefined;
  }

  return createWorkspacePathGuard(workspaceRootPath).resolve(normalizedFilePath).relativePath;
}

function normalizeCreateArtifactInput(
  input: CreateArtifactInput,
  db: AgentHubDatabase
): CreateArtifactInput {
  if (!isRecord(input)) {
    throw new ArtifactServiceError("INVALID_INPUT", "Artifact input is required.");
  }

  assertNonEmptyString(input.workspaceId, "workspaceId");
  assertNonEmptyString(input.conversationId, "conversationId");
  assertNonEmptyString(input.agentId, "agentId");
  assertNonEmptyString(input.title, "title");

  if (!isArtifactType(input.type)) {
    throw new ArtifactServiceError("INVALID_INPUT", "Artifact type is invalid.");
  }

  if (typeof input.content !== "string") {
    throw new ArtifactServiceError("INVALID_INPUT", "content is required.");
  }

  const workspaceId = input.workspaceId.trim();
  const conversationId = input.conversationId.trim();
  const agentId = input.agentId.trim();
  const workspace = getWorkspaceById(workspaceId, db);

  if (!workspace) {
    throw new ArtifactServiceError("WORKSPACE_NOT_FOUND", "Workspace does not exist.");
  }

  const agent = getAgentById(agentId, db);

  if (!agent) {
    throw new ArtifactServiceError("AGENT_NOT_FOUND", "Agent does not exist.");
  }

  const conversation = getConversationById(conversationId, db);

  if (!conversation) {
    throw new ArtifactServiceError(
      "CONVERSATION_NOT_FOUND",
      "Conversation does not exist."
    );
  }

  if (conversation.workspaceId !== workspaceId) {
    throw new ArtifactServiceError(
      "INVALID_INPUT",
      "Conversation does not belong to the workspace."
    );
  }

  if (conversation.type !== "group" && agent.workspaceId !== workspaceId) {
    throw new ArtifactServiceError("INVALID_INPUT", "Agent does not belong to the workspace.");
  }

  const isActiveGroupMember =
    conversation.type === "group" &&
    getMember(conversation.id, "agent", agentId, db)?.status === "active";

  if (conversation.agentId !== agentId && !isActiveGroupMember) {
    throw new ArtifactServiceError("INVALID_INPUT", "Agent does not match the conversation.");
  }

  return {
    workspaceId,
    conversationId,
    agentId,
    type: input.type,
    title: input.title.trim(),
    content: input.content,
    language: normalizeOptionalString(input.language),
    filePath: normalizeArtifactFilePath(
      resolveExecutionWorkspaceForConversation(conversation.id, agent.id, db).rootPath,
      input.filePath
    ),
    version: normalizeVersion(input.version)
  };
}

export function inferArtifactType(language: string | undefined, filePath: string | undefined): ArtifactType {
  const normalizedLanguage = language?.toLowerCase();
  const extension = filePath ? path.extname(filePath).toLowerCase() : "";

  if (normalizedLanguage === "html" || extension === ".html" || extension === ".htm") {
    return "html";
  }

  if (
    normalizedLanguage === "markdown" ||
    normalizedLanguage === "md" ||
    extension === ".md" ||
    extension === ".markdown"
  ) {
    return "markdown";
  }

  if (
    normalizedLanguage === "diff" ||
    normalizedLanguage === "patch" ||
    extension === ".diff" ||
    extension === ".patch"
  ) {
    return "diff";
  }

  if (extension === ".pdf") {
    return "pdf";
  }

  if (extension === ".doc" || extension === ".docx" || extension === ".odt") {
    return "document";
  }

  if (extension === ".ppt" || extension === ".pptx" || extension === ".odp") {
    return "presentation";
  }

  return "code";
}

export function inferPreviewArtifactType(
  language: string | undefined,
  filePath: string | undefined
): ArtifactType | null {
  const type = inferArtifactType(language, filePath);
  if (type === "diff") return null;
  // For office formats (document/presentation/pdf), use "html" as preview type
  // so the HTML content can be rendered in an iframe before apply.
  // After apply, the diff service will convert to the target format and update the artifact type.
  if (type === "document" || type === "presentation" || type === "pdf") return "html";
  return type;
}

const OFFICE_EXTENSIONS = new Set([".docx", ".doc", ".odt", ".pptx", ".ppt", ".odp", ".pdf", ".xlsx", ".xls"]);

export function isOfficeFormat(filePath: string | undefined): boolean {
  if (!filePath) return false;
  const ext = path.extname(filePath).toLowerCase();
  return OFFICE_EXTENSIONS.has(ext);
}

export function inferOfficeArtifactType(filePath: string): ArtifactType {
  const ext = path.extname(filePath).toLowerCase();
  if (ext === ".pdf") return "pdf";
  if (ext === ".docx" || ext === ".doc" || ext === ".odt") return "document";
  if (ext === ".pptx" || ext === ".ppt" || ext === ".odp") return "presentation";
  return "code";
}

export function createArtifactPreviewPayload(
  artifact: Artifact,
  messageId: string
): import("../../shared/artifact").ArtifactPreviewPayload {
  return {
    messageId,
    artifactId: artifact.id,
    title: artifact.title,
    artifactType: artifact.type,
    renderMode: artifact.render?.mode ?? "code",
    renderStatus: artifact.render?.status ?? "none",
    filePath: artifact.filePath,
    language: artifact.language,
    pageCount: artifact.render?.pageCount,
    sizeBytes: Buffer.byteLength(artifact.content, "utf8")
  };
}

export function attachArtifactPreviewToMessage(
  input: {
    messageId: string;
    conversationId: string;
    artifact: Artifact;
  },
  db: AgentHubDatabase = getDatabase()
): void {
  createMessageArtifact(
    {
      messageId: input.messageId,
      conversationId: input.conversationId,
      type: "artifact_preview",
      payload: createArtifactPreviewPayload(input.artifact, input.messageId)
    },
    db
  );
}

function getCodeMessageArtifactInput(message: Message): CreateArtifactInput | null {
  if (message.senderType !== "agent" || message.messageType !== "code" || !isRecord(message.content)) {
    return null;
  }

  const language = normalizeOptionalString(message.content.language) ?? "text";
  const code = message.content.code;

  if (typeof code !== "string") {
    return null;
  }

  const filePath = normalizeOptionalString(message.content.filePath);
  const type = inferArtifactType(language, filePath);

  return {
    workspaceId: message.workspaceId,
    conversationId: message.conversationId,
    agentId: message.senderId,
    type,
    title: filePath ?? `${language} artifact`,
    content: code,
    language,
    filePath
  };
}

export function createArtifact(
  input: CreateArtifactInput,
  db: AgentHubDatabase = getDatabase()
): Artifact {
  try {
    const artifact = insertArtifact(normalizeCreateArtifactInput(input, db), db);
    const render = input.render ?? getInitialRenderManifest(artifact);
    const artifactWithRender = updateArtifactRow(artifact.id, { render }, db) ?? {
      ...artifact,
      render
    };
    scheduleArtifactRender(artifactWithRender.id, db);
    return artifactWithRender;
  } catch (error) {
    throw toArtifactServiceError(error, "Failed to create artifact.");
  }
}

export function createArtifactForAgentMessage(
  message: Message,
  db: AgentHubDatabase = getDatabase()
): Artifact | null {
  const input = getCodeMessageArtifactInput(message);

  if (!input) {
    return null;
  }

  const artifact = createArtifact(input, db);
  attachArtifactPreviewToMessage(
    {
      messageId: message.id,
      conversationId: message.conversationId,
      artifact
    },
    db
  );
  return artifact;
}

export function listArtifactsByWorkspace(
  workspaceId: string,
  db: AgentHubDatabase = getDatabase()
): Artifact[] {
  assertNonEmptyString(workspaceId, "workspaceId");
  return getArtifactsByWorkspace(workspaceId.trim(), db);
}

export function getArtifact(
  input: string | PreviewArtifactInput,
  db: AgentHubDatabase = getDatabase()
): Artifact {
  const normalizedInput = normalizePreviewArtifactInput(input);

  if (normalizedInput.agentId) {
    try {
      assertAgentCanUseTool(
        {
          agentId: normalizedInput.agentId,
          tool: "previewArtifact"
        },
        db
      );
    } catch (error) {
      throw toArtifactServiceError(error, "Failed to preview artifact.");
    }
  }

  const artifact = getArtifactById(normalizedInput.artifactId, db);

  if (!artifact) {
    throw new ArtifactServiceError("ARTIFACT_NOT_FOUND", "Not found");
  }

  return artifact;
}

export function updateArtifactContent(
  input: import("../../shared/artifact").UpdateArtifactContentInput,
  db: AgentHubDatabase = getDatabase()
): Artifact {
  assertNonEmptyString(input.artifactId, "artifactId");

  if (typeof input.content !== "string") {
    throw new ArtifactServiceError("INVALID_INPUT", "content is required.");
  }

  const current = getArtifactById(input.artifactId.trim(), db);

  if (!current) {
    throw new ArtifactServiceError("ARTIFACT_NOT_FOUND", "Not found");
  }

  const render = getInitialRenderManifest({
    ...current,
    content: input.content,
    title: normalizeOptionalString(input.title) ?? current.title,
    version: current.version + 1
  });
  const updated = updateArtifactRow(
    current.id,
    {
      content: input.content,
      title: normalizeOptionalString(input.title) ?? current.title,
      version: current.version + 1,
      render
    },
    db
  );

  if (!updated) {
    throw new ArtifactServiceError("ARTIFACT_NOT_FOUND", "Not found");
  }

  scheduleArtifactRender(updated.id, db);
  return updated;
}
