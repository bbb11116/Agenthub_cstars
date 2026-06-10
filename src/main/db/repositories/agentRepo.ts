import { randomUUID } from "node:crypto";
import type {
  Agent,
  AgentToolPermissions,
  AgentType,
  ClaudeCodeConfig,
  CreateAgentInput,
  AgentStatus,
  UpdateAgentInput
} from "../../../shared/domain";
import { isRuntimeProvider } from "../../../shared/runtime";
import {
  getDatabase,
  parseJsonField,
  stringifyJsonField,
  type AgentHubDatabase
} from "../index";

type AgentRow = {
  id: string;
  workspace_id: string;
  default_workspace_context_id: string | null;
  avatar: string | null;
  name: string;
  description: string | null;
  role: Agent["role"];
  type: string;
  runtime_provider: Agent["runtimeProvider"];
  system_prompt: string;
  capabilities: string;
  skill_ids: string;
  tools: string;
  file_scope: string;
  claude_code_config: string | null;
  model_provider_id: string | null;
  model: string | null;
  status: Agent["status"];
  created_at: string;
  updated_at: string;
};

const defaultTools: AgentToolPermissions = {
  readFile: true,
  writeDiff: true,
  applyDiff: false,
  previewArtifact: true,
  gitStatus: true,
  webSearch: false,
  webFetch: false
};

function normalizeAgentType(row: AgentRow): AgentType {
  if (row.type === "orchestrator" || row.type === "specialist") {
    return row.type;
  }
  return row.role === "main" ? "orchestrator" : "specialist";
}

function toAgent(row: AgentRow): Agent {
  const runtimeProvider = isRuntimeProvider(row.runtime_provider)
    ? row.runtime_provider
    : "mock";
  const tools = {
    ...defaultTools,
    ...parseJsonField<Partial<AgentToolPermissions>>(row.tools, {}, "agents.tools"),
    applyDiff: false
  };

  const claudeCodeConfig = row.claude_code_config
    ? parseJsonField<ClaudeCodeConfig | null>(row.claude_code_config, null, "agents.claude_code_config")
    : undefined;

  return {
    id: row.id,
    workspaceId: row.workspace_id,
    defaultWorkspaceContextId: row.default_workspace_context_id ?? undefined,
    avatar: row.avatar ?? undefined,
    name: row.name,
    description: row.description ?? undefined,
    role: row.role,
    type: normalizeAgentType(row),
    runtimeProvider,
    systemPrompt: row.system_prompt,
    capabilities: parseJsonField<string[]>(row.capabilities, [], "agents.capabilities"),
    skillIds: parseJsonField<string[]>(row.skill_ids, [], "agents.skill_ids"),
    tools,
    fileScope: parseJsonField<string[]>(row.file_scope, [], "agents.file_scope"),
    claudeCodeConfig: claudeCodeConfig ?? undefined,
    modelProviderId: row.model_provider_id ?? undefined,
    model: row.model ?? undefined,
    status: row.status,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

export function createAgent(
  input: CreateAgentInput,
  db: AgentHubDatabase = getDatabase()
): Agent {
  const now = new Date().toISOString();
  const agentType = input.type ?? (input.role === "main" ? "orchestrator" : "specialist");
  const agent: Agent = {
    id: input.id ?? randomUUID(),
    workspaceId: input.workspaceId,
    defaultWorkspaceContextId: input.defaultWorkspaceContextId,
    avatar: input.avatar,
    name: input.name,
    description: input.description,
    role: input.role,
    type: agentType,
    runtimeProvider: input.runtimeProvider,
    systemPrompt: input.systemPrompt ?? "",
    capabilities: input.capabilities ?? [],
    skillIds: input.skillIds ?? [],
    tools: {
      ...defaultTools,
      ...input.tools,
      applyDiff: false
    },
    fileScope: input.fileScope ?? [],
    claudeCodeConfig: input.claudeCodeConfig,
    modelProviderId: input.modelProviderId,
    model: input.model,
    status: input.status ?? "available",
    createdAt: now,
    updatedAt: now
  };

  db.prepare(`
    INSERT INTO agents (
      id,
      workspace_id,
      default_workspace_context_id,
      avatar,
      name,
      description,
      role,
      type,
      runtime_provider,
      system_prompt,
      capabilities,
      skill_ids,
      tools,
      file_scope,
      claude_code_config,
      model_provider_id,
      model,
      status,
      created_at,
      updated_at
    )
    VALUES (
      @id,
      @workspaceId,
      @defaultWorkspaceContextId,
      @avatar,
      @name,
      @description,
      @role,
      @type,
      @runtimeProvider,
      @systemPrompt,
      @capabilities,
      @skillIds,
      @tools,
      @fileScope,
      @claudeCodeConfig,
      @modelProviderId,
      @model,
      @status,
      @createdAt,
      @updatedAt
    )
  `).run({
    ...agent,
    description: agent.description ?? null,
    defaultWorkspaceContextId: agent.defaultWorkspaceContextId ?? null,
    avatar: agent.avatar ?? null,
    capabilities: stringifyJsonField(agent.capabilities),
    skillIds: stringifyJsonField(agent.skillIds),
    tools: stringifyJsonField(agent.tools),
    fileScope: stringifyJsonField(agent.fileScope),
    claudeCodeConfig: agent.claudeCodeConfig ? stringifyJsonField(agent.claudeCodeConfig) : null,
    modelProviderId: agent.modelProviderId ?? null,
    model: agent.model ?? null
  });

  return agent;
}

export function getAgentById(id: string, db: AgentHubDatabase = getDatabase()): Agent | null {
  const row = db.prepare<[string], AgentRow>("SELECT * FROM agents WHERE id = ?").get(id);
  return row ? toAgent(row) : null;
}

export function getAgentsByWorkspace(
  workspaceId: string,
  db: AgentHubDatabase = getDatabase()
): Agent[] {
  return db
    .prepare<[string], AgentRow>(
      "SELECT * FROM agents WHERE workspace_id = ? AND status <> 'deleted' ORDER BY created_at ASC"
    )
    .all(workspaceId)
    .map(toAgent);
}

export function getAgentContacts(db: AgentHubDatabase = getDatabase()): Agent[] {
  return db
    .prepare<[], AgentRow>(
      "SELECT * FROM agents WHERE status NOT IN ('draft', 'disabled', 'deleted') ORDER BY created_at ASC"
    )
    .all()
    .map(toAgent);
}

export function getActiveMainAgent(db: AgentHubDatabase = getDatabase()): Agent | null {
  const row = db
    .prepare<[], AgentRow>(
      `SELECT *
       FROM agents
       WHERE (role = 'main' OR type = 'orchestrator')
         AND status NOT IN ('disabled', 'deleted')
       ORDER BY created_at ASC
       LIMIT 1`
    )
    .get();

  return row ? toAgent(row) : null;
}

export function getNonDeletedMainAgents(db: AgentHubDatabase = getDatabase()): Agent[] {
  return db
    .prepare<[], AgentRow>(
      `SELECT *
       FROM agents
       WHERE (role = 'main' OR type = 'orchestrator')
         AND status <> 'deleted'
       ORDER BY created_at ASC`
    )
    .all()
    .map(toAgent);
}

export function getMainAgentByWorkspace(
  workspaceId: string,
  db: AgentHubDatabase = getDatabase()
): Agent | null {
  const row = db
    .prepare<[string], AgentRow>(
      "SELECT * FROM agents WHERE workspace_id = ? AND role = 'main' AND status <> 'deleted' ORDER BY created_at ASC LIMIT 1"
    )
    .get(workspaceId);

  return row ? toAgent(row) : null;
}

export function updateAgent(
  id: string,
  input: UpdateAgentInput,
  db: AgentHubDatabase = getDatabase()
): Agent | null {
  const current = getAgentById(id, db);

  if (!current) {
    return null;
  }

  const next: Agent = {
    ...current,
    ...input,
    type: input.type ?? current.type,
    tools: input.tools
      ? { ...current.tools, ...input.tools, applyDiff: false }
      : { ...current.tools, applyDiff: false },
    updatedAt: new Date().toISOString()
  };

  db.prepare(`
    UPDATE agents
    SET
      name = @name,
      description = @description,
      default_workspace_context_id = @defaultWorkspaceContextId,
      avatar = @avatar,
      role = @role,
      type = @type,
      runtime_provider = @runtimeProvider,
      system_prompt = @systemPrompt,
      capabilities = @capabilities,
      skill_ids = @skillIds,
      tools = @tools,
      file_scope = @fileScope,
      claude_code_config = @claudeCodeConfig,
      model_provider_id = @modelProviderId,
      model = @model,
      status = @status,
      updated_at = @updatedAt
    WHERE id = @id
  `).run({
    ...next,
    description: next.description ?? null,
    defaultWorkspaceContextId: next.defaultWorkspaceContextId ?? null,
    avatar: next.avatar ?? null,
    capabilities: stringifyJsonField(next.capabilities),
    skillIds: stringifyJsonField(next.skillIds),
    tools: stringifyJsonField(next.tools),
    fileScope: stringifyJsonField(next.fileScope),
    claudeCodeConfig: next.claudeCodeConfig ? stringifyJsonField(next.claudeCodeConfig) : null,
    modelProviderId: next.modelProviderId ?? null,
    model: next.model ?? null
  });

  return next;
}

export function updateAgentStatus(
  id: string,
  status: AgentStatus,
  db: AgentHubDatabase = getDatabase()
): Agent | null {
  const current = getAgentById(id, db);

  if (!current) {
    return null;
  }

  const updatedAt = new Date().toISOString();

  db.prepare(`
    UPDATE agents
    SET
      status = @status,
      updated_at = @updatedAt
    WHERE id = @id
  `).run({
    id,
    status,
    updatedAt
  });

  return {
    ...current,
    status,
    updatedAt
  };
}

export function deleteAgent(id: string, db: AgentHubDatabase = getDatabase()): boolean {
  const result = db
    .prepare<[string]>(
      "DELETE FROM agents WHERE id = ? AND role <> 'main' AND type <> 'orchestrator'"
    )
    .run(id);
  return result.changes > 0;
}
