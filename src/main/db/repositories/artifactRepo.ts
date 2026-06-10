import { randomUUID } from "node:crypto";
import type {
  Artifact,
  CreateArtifactInput,
  UpdateArtifactInput
} from "../../../shared/artifact";
import { isArtifactType } from "../../../shared/artifact";
import {
  getDatabase,
  parseJsonField,
  stringifyJsonField,
  type AgentHubDatabase
} from "../index";

type ArtifactRow = {
  id: string;
  workspace_id: string;
  agent_id: string;
  conversation_id: string;
  name: string;
  artifact_type: string;
  file_path: string | null;
  content: string;
  metadata: string;
  created_at: string;
  updated_at: string;
};

type ArtifactMetadata = {
  language?: unknown;
  version?: unknown;
  render?: unknown;
};

function toContentString(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }

  if (value === null || value === undefined) {
    return "";
  }

  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function toVersion(value: unknown): number {
  return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : 1;
}

function inferLegacyArtifactType(row: ArtifactRow, content: string): Artifact["type"] {
  const lowerFilePath = row.file_path?.toLowerCase() ?? "";

  if (lowerFilePath.endsWith(".html") || content.trimStart().toLowerCase().startsWith("<!doctype")) {
    return "html";
  }

  if (lowerFilePath.endsWith(".md") || lowerFilePath.endsWith(".markdown")) {
    return "markdown";
  }

  if (content.startsWith("--- ") || content.includes("\n@@ ")) {
    return "diff";
  }

  return "code";
}

function toArtifact(row: ArtifactRow): Artifact {
  const content = toContentString(
    parseJsonField<unknown>(row.content, "", "artifacts.content")
  );
  const metadata = parseJsonField<ArtifactMetadata>(row.metadata, {}, "artifacts.metadata");
  const language = typeof metadata.language === "string" ? metadata.language : undefined;
  const version = toVersion(metadata.version);
  const render =
    metadata.render && typeof metadata.render === "object"
      ? (metadata.render as Artifact["render"])
      : undefined;

  return {
    id: row.id,
    workspaceId: row.workspace_id,
    agentId: row.agent_id,
    conversationId: row.conversation_id,
    type: isArtifactType(row.artifact_type)
      ? row.artifact_type
      : inferLegacyArtifactType(row, content),
    title: row.name,
    content,
    language,
    filePath: row.file_path ?? undefined,
    render,
    version,
    createdAt: row.created_at
  };
}

export function createArtifact(
  input: CreateArtifactInput,
  db: AgentHubDatabase = getDatabase()
): Artifact {
  const now = new Date().toISOString();
  const artifact: Artifact = {
    id: randomUUID(),
    workspaceId: input.workspaceId,
    agentId: input.agentId,
    conversationId: input.conversationId,
    type: input.type,
    title: input.title,
    content: input.content,
    language: input.language,
    filePath: input.filePath,
    render: input.render,
    version: input.version ?? 1,
    createdAt: now
  };

  db.prepare(`
    INSERT INTO artifacts (
      id,
      workspace_id,
      agent_id,
      conversation_id,
      name,
      artifact_type,
      file_path,
      content,
      metadata,
      created_at,
      updated_at
    )
    VALUES (
      @id,
      @workspaceId,
      @agentId,
      @conversationId,
      @name,
      @artifactType,
      @filePath,
      @content,
      @metadata,
      @createdAt,
      @updatedAt
    )
  `).run({
    id: artifact.id,
    workspaceId: artifact.workspaceId,
    agentId: artifact.agentId,
    conversationId: artifact.conversationId,
    name: artifact.title,
    artifactType: artifact.type,
    filePath: artifact.filePath ?? null,
    content: stringifyJsonField(artifact.content),
    metadata: stringifyJsonField({
      language: artifact.language,
      version: artifact.version,
      render: artifact.render
    }),
    createdAt: artifact.createdAt,
    updatedAt: now
  });

  return artifact;
}

export function getArtifactById(
  id: string,
  db: AgentHubDatabase = getDatabase()
): Artifact | null {
  const row = db.prepare<[string], ArtifactRow>("SELECT * FROM artifacts WHERE id = ?").get(id);
  return row ? toArtifact(row) : null;
}

export function getArtifactsByConversation(
  conversationId: string,
  db: AgentHubDatabase = getDatabase()
): Artifact[] {
  return db
    .prepare<[string], ArtifactRow>(
      "SELECT * FROM artifacts WHERE conversation_id = ? ORDER BY updated_at DESC"
    )
    .all(conversationId)
    .map(toArtifact);
}

export function getArtifactsByWorkspace(
  workspaceId: string,
  db: AgentHubDatabase = getDatabase()
): Artifact[] {
  return db
    .prepare<[string], ArtifactRow>(
      "SELECT * FROM artifacts WHERE workspace_id = ? ORDER BY created_at DESC, rowid DESC"
    )
    .all(workspaceId)
    .map(toArtifact);
}

export function updateArtifact(
  id: string,
  input: UpdateArtifactInput,
  db: AgentHubDatabase = getDatabase()
): Artifact | null {
  const current = getArtifactById(id, db);

  if (!current) {
    return null;
  }

  const next: Artifact = {
    ...current,
    ...input,
    version: input.version ?? current.version
  };
  const updatedAt = new Date().toISOString();

  db.prepare(`
    UPDATE artifacts
    SET
      name = @name,
      artifact_type = @artifactType,
      file_path = @filePath,
      content = @content,
      metadata = @metadata,
      updated_at = @updatedAt
    WHERE id = @id
  `).run({
    id: next.id,
    name: next.title,
    artifactType: next.type,
    filePath: next.filePath ?? null,
    content: stringifyJsonField(next.content),
    metadata: stringifyJsonField({
      language: next.language,
      version: next.version,
      render: next.render
    }),
    updatedAt
  });

  return next;
}

export function deleteArtifact(id: string, db: AgentHubDatabase = getDatabase()): boolean {
  const result = db.prepare<[string]>("DELETE FROM artifacts WHERE id = ?").run(id);
  return result.changes > 0;
}
