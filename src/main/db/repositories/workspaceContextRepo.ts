import { randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type {
  WorkspaceContext,
  WorkspaceContextOwnerType
} from "../../../shared/domain";
import { getDatabase, type AgentHubDatabase } from "../index";

type WorkspaceContextRow = {
  id: string;
  owner_type: WorkspaceContextOwnerType;
  owner_id: string;
  root_path: string;
  git_enabled: 0 | 1;
  created_at: string;
  updated_at: string;
};

export type CreateWorkspaceContextInput = {
  id?: string;
  ownerType: WorkspaceContextOwnerType;
  ownerId: string;
  rootPath: string;
  gitEnabled?: boolean;
};

export type UpdateWorkspaceContextInput = Partial<
  Pick<WorkspaceContext, "rootPath" | "gitEnabled">
>;

function toWorkspaceContext(row: WorkspaceContextRow): WorkspaceContext {
  return {
    id: row.id,
    ownerType: row.owner_type,
    ownerId: row.owner_id,
    rootPath: row.root_path,
    gitEnabled: row.git_enabled === 1,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

function ensureDirectory(rootPath: string): string {
  const resolvedPath = path.resolve(rootPath);
  fs.mkdirSync(resolvedPath, { recursive: true });
  return resolvedPath;
}

export function slugifyWorkspaceContextName(
  name: string,
  fallback: "agent" | "group"
): string {
  const slug = name
    .normalize("NFKC")
    .trim()
    .replace(/[^\p{Letter}\p{Number}]+/gu, "-")
    .replace(/^-+|-+$/g, "")
    .toLowerCase();

  return slug || fallback;
}

export function getDefaultAgentWorkspaceRoot(agentId: string, agentName: string): string {
  return path.join(
    os.homedir(),
    "Documents",
    "AgentHub",
    "agents",
    `${agentId}-${slugifyWorkspaceContextName(agentName, "agent")}`
  );
}

export function getDefaultGroupWorkspaceRoot(
  conversationId: string,
  groupName: string
): string {
  return path.join(
    os.homedir(),
    "Documents",
    "AgentHub",
    "groups",
    `${conversationId}-${slugifyWorkspaceContextName(groupName, "group")}`
  );
}

export function createWorkspaceContext(
  input: CreateWorkspaceContextInput,
  db: AgentHubDatabase = getDatabase()
): WorkspaceContext {
  const now = new Date().toISOString();
  const context: WorkspaceContext = {
    id: input.id ?? randomUUID(),
    ownerType: input.ownerType,
    ownerId: input.ownerId,
    rootPath: ensureDirectory(input.rootPath),
    gitEnabled: input.gitEnabled ?? true,
    createdAt: now,
    updatedAt: now
  };

  db.prepare(`
    INSERT INTO workspace_contexts (
      id, owner_type, owner_id, root_path, git_enabled, created_at, updated_at
    )
    VALUES (
      @id, @ownerType, @ownerId, @rootPath, @gitEnabled, @createdAt, @updatedAt
    )
  `).run({
    ...context,
    gitEnabled: context.gitEnabled ? 1 : 0
  });

  return context;
}

export function getWorkspaceContextById(
  id: string,
  db: AgentHubDatabase = getDatabase()
): WorkspaceContext | null {
  const row = db
    .prepare<[string], WorkspaceContextRow>("SELECT * FROM workspace_contexts WHERE id = ?")
    .get(id);
  return row ? toWorkspaceContext(row) : null;
}

export function getWorkspaceContextByOwner(
  ownerType: WorkspaceContextOwnerType,
  ownerId: string,
  db: AgentHubDatabase = getDatabase()
): WorkspaceContext | null {
  const row = db
    .prepare<[WorkspaceContextOwnerType, string], WorkspaceContextRow>(
      "SELECT * FROM workspace_contexts WHERE owner_type = ? AND owner_id = ? ORDER BY created_at ASC LIMIT 1"
    )
    .get(ownerType, ownerId);
  return row ? toWorkspaceContext(row) : null;
}

export function updateWorkspaceContext(
  id: string,
  patch: UpdateWorkspaceContextInput,
  db: AgentHubDatabase = getDatabase()
): WorkspaceContext | null {
  const current = getWorkspaceContextById(id, db);
  if (!current) {
    return null;
  }

  const next: WorkspaceContext = {
    ...current,
    rootPath: patch.rootPath ? ensureDirectory(patch.rootPath) : current.rootPath,
    gitEnabled: patch.gitEnabled ?? current.gitEnabled,
    updatedAt: new Date().toISOString()
  };

  db.prepare(`
    UPDATE workspace_contexts
    SET root_path = @rootPath, git_enabled = @gitEnabled, updated_at = @updatedAt
    WHERE id = @id
  `).run({
    ...next,
    gitEnabled: next.gitEnabled ? 1 : 0
  });

  return next;
}

export function deleteWorkspaceContext(
  id: string,
  db: AgentHubDatabase = getDatabase()
): boolean {
  const result = db.prepare<[string]>("DELETE FROM workspace_contexts WHERE id = ?").run(id);
  return result.changes > 0;
}

export function ensureWorkspaceContextForAgent(
  agentId: string,
  agentName: string,
  db: AgentHubDatabase = getDatabase()
): WorkspaceContext {
  return (
    getWorkspaceContextByOwner("agent", agentId, db) ??
    createWorkspaceContext(
      {
        ownerType: "agent",
        ownerId: agentId,
        rootPath: getDefaultAgentWorkspaceRoot(agentId, agentName)
      },
      db
    )
  );
}

export function ensureWorkspaceContextForGroupConversation(
  conversationId: string,
  groupName: string,
  db: AgentHubDatabase = getDatabase()
): WorkspaceContext {
  return (
    getWorkspaceContextByOwner("group", conversationId, db) ??
    createWorkspaceContext(
      {
        ownerType: "group",
        ownerId: conversationId,
        rootPath: getDefaultGroupWorkspaceRoot(conversationId, groupName)
      },
      db
    )
  );
}
