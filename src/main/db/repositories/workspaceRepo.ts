import { randomUUID } from "node:crypto";
import path from "node:path";
import type {
  CreateWorkspaceInput,
  UpdateWorkspaceInput,
  Workspace
} from "../../../shared/domain";
import { getDatabase, type AgentHubDatabase } from "../index";

type WorkspaceRow = {
  id: string;
  name: string;
  root_path: string;
  main_agent_id: string | null;
  git_enabled: 0 | 1;
  created_at: string;
  updated_at: string;
};

function toWorkspace(row: WorkspaceRow): Workspace {
  return {
    id: row.id,
    name: row.name,
    rootPath: row.root_path,
    mainAgentId: row.main_agent_id,
    gitEnabled: row.git_enabled === 1,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

export function createWorkspace(
  input: CreateWorkspaceInput,
  db: AgentHubDatabase = getDatabase()
): Workspace {
  const now = new Date().toISOString();
  const inferredName = path.basename(path.resolve(input.rootPath)) || input.rootPath;
  const workspace: Workspace = {
    id: randomUUID(),
    name: input.name?.trim() || inferredName,
    rootPath: input.rootPath,
    mainAgentId: input.mainAgentId ?? null,
    gitEnabled: input.gitEnabled ?? false,
    createdAt: now,
    updatedAt: now
  };

  db.prepare(`
    INSERT INTO workspaces (
      id,
      name,
      root_path,
      main_agent_id,
      git_enabled,
      created_at,
      updated_at
    )
    VALUES (
      @id,
      @name,
      @rootPath,
      @mainAgentId,
      @gitEnabled,
      @createdAt,
      @updatedAt
    )
  `).run({
    ...workspace,
    gitEnabled: workspace.gitEnabled ? 1 : 0
  });

  return workspace;
}

export function getWorkspaces(db: AgentHubDatabase = getDatabase()): Workspace[] {
  return db
    .prepare<[], WorkspaceRow>("SELECT * FROM workspaces ORDER BY created_at ASC")
    .all()
    .map(toWorkspace);
}

export function getWorkspaceByRootPath(
  rootPath: string,
  db: AgentHubDatabase = getDatabase()
): Workspace | null {
  const row = db
    .prepare<[string], WorkspaceRow>("SELECT * FROM workspaces WHERE root_path = ? LIMIT 1")
    .get(rootPath);

  return row ? toWorkspace(row) : null;
}

export function getWorkspaceById(
  id: string,
  db: AgentHubDatabase = getDatabase()
): Workspace | null {
  const row = db
    .prepare<[string], WorkspaceRow>("SELECT * FROM workspaces WHERE id = ?")
    .get(id);

  return row ? toWorkspace(row) : null;
}

export function updateWorkspace(
  id: string,
  input: UpdateWorkspaceInput,
  db: AgentHubDatabase = getDatabase()
): Workspace | null {
  const current = getWorkspaceById(id, db);

  if (!current) {
    return null;
  }

  const next: Workspace = {
    ...current,
    ...input,
    updatedAt: new Date().toISOString()
  };

  db.prepare(`
    UPDATE workspaces
    SET
      name = @name,
      root_path = @rootPath,
      main_agent_id = @mainAgentId,
      git_enabled = @gitEnabled,
      updated_at = @updatedAt
    WHERE id = @id
  `).run({
    ...next,
    gitEnabled: next.gitEnabled ? 1 : 0
  });

  return next;
}

export function deleteWorkspace(id: string, db: AgentHubDatabase = getDatabase()): boolean {
  const result = db.prepare<[string]>("DELETE FROM workspaces WHERE id = ?").run(id);
  return result.changes > 0;
}
