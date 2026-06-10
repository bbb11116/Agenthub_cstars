import { randomUUID } from "node:crypto";
import type {
  Agent,
  AgentStatus,
  AgentToolPermissions,
  Conversation,
  CreateSubAgentManuallyInput,
  CreateSubAgentManuallyOutput,
  RuntimeProvider,
  UpdateAgentDefaultWorkspaceInput,
  UpdateAgentProfileInput,
  UpdateAgentStatusInput,
  Workspace
} from "../../shared/domain";
import { isRuntimeProvider } from "../../shared/runtime";
import { getDatabase, type AgentHubDatabase } from "../db";
import {
  createAgent,
  deleteAgent,
  getActiveMainAgent,
  getAgentContacts,
  getAgentById,
  getAgentsByWorkspace,
  getMainAgentByWorkspace,
  updateAgent,
  updateAgentStatus as updateAgentStatusInRepo
} from "../db/repositories/agentRepo";
import { createMessage as insertMessage } from "../db/repositories/messageRepo";
import { markActiveSessionsAsReplacedForAgent } from "../db/repositories/providerSessionRepo";
import { getWorkspaceById } from "../db/repositories/workspaceRepo";
import { createWorkspace as insertWorkspace } from "../db/repositories/workspaceRepo";
import {
  createWorkspaceContext,
  ensureWorkspaceContextForAgent,
  getDefaultAgentWorkspaceRoot,
  updateWorkspaceContext
} from "../db/repositories/workspaceContextRepo";
import {
  createDefaultConversationForAgent,
  ensureMainAgentGuideMessage
} from "./conversationService";
import {
  getAgentSkillCapabilities,
  getAgentSkillSummaries,
  normalizeAgentSkillIds,
  validateAgentSkillIds
} from "./agentSkillCatalogService";

export type MainAgentCreationResult = {
  agent: Agent;
  defaultConversation: Conversation;
};

type DefaultMainAgent = {
  role: Agent["role"];
  runtimeProvider: Agent["runtimeProvider"];
  capabilities: string[];
  tools: AgentToolPermissions;
};

const MAIN_AGENT_BASE_RULES = [
  "You are the fixed Main Agent bound to this AgentHub Workspace.",
  "The Main Agent is responsible for Workspace understanding, task dispatch, and result summarization.",
  "Sub Agents are created manually from the Add Sub Agent dialog. When asked to create one in chat, tell the user to click the plus button in the upper-left corner.",
  "When the user requests code changes, local Runtime Agents must create a valid DiffProposal or explicitly state that no file changes are needed.",
  "Never bypass AgentHub apply_diff by writing final workspace changes directly.",
  "Do not access paths outside workspace.rootPath.",
  "Do not run destructive Git commands, including reset --hard, clean, checkout --, branch deletion, force push, or history rewrite.",
  "Use approved Electron main-process tools for workspace reads, Git status, artifact previews, and optional diff proposal creation."
];

export const MAIN_AGENT_SYSTEM_PROMPT = MAIN_AGENT_BASE_RULES.join("\n");

export const defaultMainAgent: DefaultMainAgent = {
  role: "main",
  runtimeProvider: "builtin_openai",
  capabilities: [
    "workspace-management",
    "codebase-understanding",
    "diff-proposal-review",
    "git-aware"
  ],
  tools: {
    readFile: true,
    writeDiff: true,
    applyDiff: false,
    previewArtifact: true,
    gitStatus: true,
    webSearch: true,
    webFetch: true
  }
};

function buildRuntimeInstruction(
  runtimeProvider: RuntimeProvider,
  rootPath: string
): string {
  switch (runtimeProvider) {
    case "builtin_openai":
      return [
        "Runtime provider: AgentHub built-in LLM using the configured Model Provider.",
        "You are the Orchestrator of this AgentHub Workspace.",
        "You are fully capable of producing SEARCH/REPLACE edit blocks — both for modifying existing files AND for creating new files (use an empty SEARCH block).",
        "Do NOT tell the user that builtin_openai cannot create files. You can."
      ].join("\n");
    case "builtin_anthropic":
      return [
        "Runtime provider: AgentHub built-in LLM using the configured Model Provider.",
        "You are the Orchestrator of this AgentHub Workspace.",
        "You are fully capable of producing SEARCH/REPLACE edit blocks — both for modifying existing files AND for creating new files (use an empty SEARCH block).",
        "Do NOT tell the user that the LLM cannot create files. You can."
      ].join("\n");
    case "codex_local":
      return [
        "Runtime provider: Codex Local.",
        `When AgentHub invokes Codex Local, it may pass --cd "${rootPath}", and spawn options.cwd must also be "${rootPath}".`,
        "Codex Local must submit DiffProposal for code changes (including new files via empty SEARCH block) and wait for user confirmation."
      ].join("\n");
    case "claude_code":
      return [
        "Runtime provider: Claude Code Local.",
        `When AgentHub invokes Claude Code, spawn options.cwd must be "${rootPath}".`,
        "AgentHub Main Agent rules must be injected with --append-system-prompt or --append-system-prompt-file.",
        "Claude Code must submit DiffProposal for code changes (including new files via empty SEARCH block) and wait for user confirmation."
      ].join("\n");
    case "opencode":
      return [
        "Runtime provider: OpenCode.",
        `When AgentHub invokes OpenCode, spawn options.cwd must be "${rootPath}".`,
        "OpenCode must submit DiffProposal for code changes (including new files via empty SEARCH block) and wait for user confirmation."
      ].join("\n");
    case "mock":
      return [
        "Runtime provider: Mock.",
        "Mock may use DiffProposal to demonstrate the optional review workflow."
      ].join("\n");
  }
}

export function buildMainAgentSystemPrompt(
  rootPath: string,
  runtimeProvider: RuntimeProvider
): string {
  return [
    ...MAIN_AGENT_BASE_RULES,
    `workspace.rootPath: ${rootPath}`,
    buildRuntimeInstruction(runtimeProvider, rootPath)
  ].join("\n");
}

class AgentValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AgentValidationError";
  }
}

const RUNTIME_AGENT_STATUSES = new Set<UpdateAgentStatusInput["status"]>([
  "available",
  "running",
  "error",
  "unavailable"
]);
const MANUAL_SUB_AGENT_PROVIDERS = new Set<RuntimeProvider>([
  "builtin_openai",
  "codex_local",
  "claude_code",
  "opencode",
  "mock"
]);
const DEFAULT_MANUAL_SUB_AGENT_TOOLS: AgentToolPermissions = {
  readFile: true,
  writeDiff: true,
  applyDiff: false,
  previewArtifact: true,
  gitStatus: true,
  webSearch: true,
  webFetch: true
};

function assertRecord(value: unknown, label: string): asserts value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new AgentValidationError(`${label} is required.`);
  }
}

function assertNonEmptyString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new AgentValidationError(`${label} is required.`);
  }

  return value.trim();
}

function normalizeAgentId(agentId: unknown): string {
  return assertNonEmptyString(agentId, "agentId");
}

function normalizeRuntimeAgentStatus(value: unknown): UpdateAgentStatusInput["status"] {
  if (
    typeof value !== "string" ||
    !RUNTIME_AGENT_STATUSES.has(value as UpdateAgentStatusInput["status"])
  ) {
    throw new AgentValidationError("status is invalid.");
  }

  return value as UpdateAgentStatusInput["status"];
}

function normalizeRuntimeProvider(value: unknown): RuntimeProvider {
  if (!isRuntimeProvider(value)) {
    throw new AgentValidationError("runtimeProvider is invalid.");
  }

  return value;
}

function normalizeCreateSubAgentManuallyInput(
  input: CreateSubAgentManuallyInput
): CreateSubAgentManuallyInput {
  assertRecord(input, "Manual sub Agent input");
  const provider = normalizeRuntimeProvider(input.provider);

  if (!MANUAL_SUB_AGENT_PROVIDERS.has(provider)) {
    throw new AgentValidationError("provider is invalid.");
  }

  return {
    workspaceId:
      input.workspaceId === undefined
        ? undefined
        : assertNonEmptyString(input.workspaceId, "workspaceId"),
    provider,
    name: assertNonEmptyString(input.name, "name"),
    description: input.description?.trim() ?? "",
    skillIds: validateAgentSkillIds(normalizeAgentSkillIds(input.skillIds))
  };
}

function getUniqueSubAgentName(
  requestedName: string,
  db: AgentHubDatabase
): string {
  const existingNames = new Set(getAgentContacts(db).map((agent) => agent.name));

  if (!existingNames.has(requestedName)) {
    return requestedName;
  }

  let suffix = 2;
  let candidate = `${requestedName} ${suffix}`;

  while (existingNames.has(candidate)) {
    suffix += 1;
    candidate = `${requestedName} ${suffix}`;
  }

  return candidate;
}

export function buildManualSubAgentSystemPrompt(input: {
  name: string;
  description: string;
  workspaceRoot: string;
}): string {
  const responsibility = input.description
    ? `Your specialist responsibility is: ${input.description}`
    : "Complete the task according to the user request, system prompt, tool permissions, and current workspace.";

  return [
    "You are a specialist sub-agent in AgentHub.",
    `Agent name: ${input.name}`,
    responsibility,
    `You may work only inside the current workspace: ${input.workspaceRoot}`,
    "Do not access files outside the current workspace.",
    "For code changes, prioritize producing a DiffProposal.",
    "Do not modify files directly unless the current runtime explicitly allows it.",
    "Keep responses focused on your specialist responsibility."
  ].join("\n");
}

function getExistingMainAgent(workspace: Workspace, db: AgentHubDatabase): Agent | null {
  if (workspace.mainAgentId) {
    const linkedAgent = getAgentById(workspace.mainAgentId, db);

    if (linkedAgent?.workspaceId === workspace.id && linkedAgent.role === "main") {
      return linkedAgent;
    }
  }

  return getMainAgentByWorkspace(workspace.id, db);
}

export function createMainAgentForWorkspace(
  workspace: Workspace,
  runtimeProviderOrDb: RuntimeProvider | AgentHubDatabase = defaultMainAgent.runtimeProvider,
  dbOrUndefined?: AgentHubDatabase
): MainAgentCreationResult {
  const runtimeProvider = isRuntimeProvider(runtimeProviderOrDb)
    ? runtimeProviderOrDb
    : defaultMainAgent.runtimeProvider;
  const db = isRuntimeProvider(runtimeProviderOrDb)
    ? dbOrUndefined ?? getDatabase()
    : runtimeProviderOrDb;
  const existingMainAgent = getExistingMainAgent(workspace, db);
  const agent =
    existingMainAgent ??
    createAgent(
      {
        workspaceId: workspace.id,
        name: `${workspace.name} Main Agent`,
        role: defaultMainAgent.role,
        runtimeProvider,
        systemPrompt: buildMainAgentSystemPrompt(workspace.rootPath, runtimeProvider),
        capabilities: defaultMainAgent.capabilities,
        tools: defaultMainAgent.tools,
        fileScope: ["**/*"],
        status: "available"
      },
      db
    );
  const defaultConversation = createDefaultConversationForAgent(agent, db);

  ensureMainAgentGuideMessage(workspace, agent, defaultConversation, db);

  return {
    agent,
    defaultConversation
  };
}

export function createMainAgent(
  workspace: Workspace,
  runtimeProviderOrDb: RuntimeProvider | AgentHubDatabase = defaultMainAgent.runtimeProvider,
  dbOrUndefined?: AgentHubDatabase
): MainAgentCreationResult {
  return createMainAgentForWorkspace(workspace, runtimeProviderOrDb, dbOrUndefined);
}

export function listAgentsByWorkspace(
  workspaceId: string,
  db: AgentHubDatabase = getDatabase()
): Agent[] {
  return getAgentsByWorkspace(workspaceId, db);
}

export function listAgentContacts(db: AgentHubDatabase = getDatabase()): Agent[] {
  return getAgentContacts(db);
}

export function getAgentStatus(
  agentId: string,
  db: AgentHubDatabase = getDatabase()
): AgentStatus | null {
  const normalizedAgentId = normalizeAgentId(agentId);
  return getAgentById(normalizedAgentId, db)?.status ?? null;
}

export function updateAgentStatus(
  input: UpdateAgentStatusInput,
  db: AgentHubDatabase = getDatabase()
): Agent | null {
  if (!input || typeof input !== "object") {
    throw new AgentValidationError("Agent status input is required.");
  }

  const agentId = normalizeAgentId(input.agentId);
  const status = normalizeRuntimeAgentStatus(input.status);

  try {
    return updateAgentStatusInRepo(agentId, status, db);
  } catch (error) {
    console.warn("Failed to update Agent status.", error);
    return null;
  }
}

export function createSubAgentManually(
  input: CreateSubAgentManuallyInput,
  db: AgentHubDatabase = getDatabase()
): CreateSubAgentManuallyOutput {
  const normalizedInput = normalizeCreateSubAgentManuallyInput(input);
  const createSubAgent = db.transaction(
    (manualInput: CreateSubAgentManuallyInput): CreateSubAgentManuallyOutput => {
      const requestedWorkspace = manualInput.workspaceId
        ? getWorkspaceById(manualInput.workspaceId, db)
        : null;
      if (manualInput.workspaceId && !requestedWorkspace) {
        throw new AgentValidationError("Workspace not found.");
      }

      const agentId = randomUUID();
      const name = getUniqueSubAgentName(manualInput.name, db);
      const description = manualInput.description?.trim() ?? "";
      const skillIds = manualInput.skillIds ?? [];
      const skillCapabilities = getAgentSkillCapabilities(skillIds);
      const defaultRootPath = requestedWorkspace
        ? requestedWorkspace.rootPath
        : getDefaultAgentWorkspaceRoot(agentId, name);
      const workspace =
        requestedWorkspace ??
        insertWorkspace(
          {
            name: `${name} Context`,
            rootPath: defaultRootPath,
            mainAgentId: getActiveMainAgent(db)?.id ?? null,
            gitEnabled: false
          },
          db
        );
      // WorkspaceContext is the execution directory. The Workspace row remains as a hidden
      // compatibility owner for legacy foreign keys and old workspace-first flows.
      const workspaceContext = createWorkspaceContext(
        {
          ownerType: "agent",
          ownerId: agentId,
          rootPath: defaultRootPath,
          gitEnabled: false
        },
        db
      );
      const agent = createAgent(
        {
          id: agentId,
          workspaceId: workspace.id,
          defaultWorkspaceContextId: workspaceContext.id,
          name,
          description,
          role: "sub",
          type: "specialist",
          runtimeProvider: manualInput.provider,
          systemPrompt: buildManualSubAgentSystemPrompt({
            name,
            description,
            workspaceRoot: workspaceContext.rootPath
          }),
          capabilities: skillCapabilities.length > 0 ? skillCapabilities : ["specialist"],
          skillIds,
          tools: DEFAULT_MANUAL_SUB_AGENT_TOOLS,
          fileScope: [workspaceContext.rootPath],
          status: "available"
        },
        db
      );
      const conversation = createDefaultConversationForAgent(agent, db);

      insertMessage(
        {
          workspaceId: workspace.id,
          conversationId: conversation.id,
          senderType: "system",
          senderId: "agent-creation",
          messageType: "text",
          content: {
            text: `Sub Agent created manually: ${agent.name}`
          }
        },
        db
      );

      return {
        agent,
        conversation
      };
    }
  );

  return createSubAgent(normalizedInput);
}

export function deleteAgentById(id: string, db: AgentHubDatabase = getDatabase()): boolean {
  const agent = getAgentById(id, db);

  if (!agent || agent.role === "main" || agent.type === "orchestrator") {
    return false;
  }

  return deleteAgent(id, db);
}

export function updateAgentProfile(
  input: UpdateAgentProfileInput,
  db: AgentHubDatabase = getDatabase()
): Agent | null {
  const agentId = assertNonEmptyString(input.agentId, "agentId");
  const currentAgent = getAgentById(agentId, db);
  if (!currentAgent) {
    return null;
  }

  const skillIds =
    input.skillIds === undefined
      ? undefined
      : validateAgentSkillIds(normalizeAgentSkillIds(input.skillIds));
  const skillCapabilities = skillIds === undefined ? [] : getAgentSkillCapabilities(skillIds);
  const patch = {
    ...(input.name === undefined ? {} : { name: assertNonEmptyString(input.name, "name") }),
    ...(input.description === undefined
      ? {}
      : { description: input.description.trim() }),
    ...(input.avatar === undefined ? {} : { avatar: input.avatar.trim() || undefined }),
    ...(skillIds === undefined
      ? {}
      : {
          skillIds,
          capabilities:
            skillCapabilities.length > 0
              ? skillCapabilities
              : currentAgent.role === "sub"
                ? ["specialist"]
                : defaultMainAgent.capabilities
        })
  };
  return updateAgent(agentId, patch, db);
}

export function updateAgentDefaultWorkspace(
  input: UpdateAgentDefaultWorkspaceInput,
  db: AgentHubDatabase = getDatabase()
): Agent | null {
  const agentId = assertNonEmptyString(input.agentId, "agentId");
  const rootPath = assertNonEmptyString(input.rootPath, "rootPath");
  const agent = getAgentById(agentId, db);
  if (!agent) {
    return null;
  }

  const context = agent.defaultWorkspaceContextId
    ? updateWorkspaceContext(
        agent.defaultWorkspaceContextId,
        {
          rootPath,
          gitEnabled: input.gitEnabled
        },
        db
      )
    : null;
  const ensuredContext = context ?? ensureWorkspaceContextForAgent(agent.id, agent.name, db);
  const updatedContext =
    ensuredContext.rootPath === rootPath
      ? ensuredContext
      : updateWorkspaceContext(
          ensuredContext.id,
          {
            rootPath,
            gitEnabled: input.gitEnabled
          },
          db
        ) ?? ensuredContext;

  const updatedAgent = updateAgent(
    agent.id,
    { defaultWorkspaceContextId: updatedContext.id },
    db
  );
  if (!updatedAgent) {
    return null;
  }

  const rebuiltPrompt =
    updatedAgent.role === "main"
      ? buildMainAgentSystemPrompt(rootPath, updatedAgent.runtimeProvider)
      : buildManualSubAgentSystemPrompt({
          name: updatedAgent.name,
          description: updatedAgent.description ?? "",
          workspaceRoot: rootPath
        });

  markActiveSessionsAsReplacedForAgent(updatedAgent.id, updatedAgent.runtimeProvider, db);

  return updateAgent(updatedAgent.id, { systemPrompt: rebuiltPrompt }, db);
}

type GroupRow = {
  conversation_id: string;
  title: string;
  avatar: string | null;
  description: string | null;
  member_count: number;
  last_message_at: string | null;
  wc_id: string | null;
  wc_root_path: string | null;
};

type ExperienceRow = {
  group_conversation_id: string;
  group_name: string;
  summary: string;
  responsibilities_json: string;
  key_decisions_json: string;
  files_touched_json: string;
  diff_summaries_json: string;
  unresolved_issues_json: string;
  updated_at: string | null;
};

import type { AgentProfileDto } from "../../shared/types";
import { getWorkspaceContextById } from "../db/repositories/workspaceContextRepo";

export function getAgentProfile(
  agentId: string,
  db: AgentHubDatabase = getDatabase()
): AgentProfileDto {
  const agent = getAgentById(agentId, db);
  if (!agent || agent.status === "deleted") {
    throw new AgentValidationError("Agent not found.");
  }

  // Default workspace context
  let defaultWorkspaceContext: AgentProfileDto["defaultWorkspaceContext"] = null;
  if (agent.defaultWorkspaceContextId) {
    const wc = getWorkspaceContextById(agent.defaultWorkspaceContextId, db);
    if (wc) {
      defaultWorkspaceContext = {
        id: wc.id,
        rootPath: wc.rootPath,
        gitEnabled: wc.gitEnabled
      };
    }
  }

  // Tools - force applyDiff to false as system invariant
  const tools: AgentProfileDto["tools"] = {
    ...agent.tools,
    applyDiff: false
  };

  // Groups: query conversation_members + conversations
  const groupRows = db
    .prepare<[string], GroupRow>(
      `SELECT
        c.id AS conversation_id,
        c.title,
        c.avatar,
        c.description,
        (SELECT COUNT(*) FROM conversation_members cm2 WHERE cm2.conversation_id = c.id AND cm2.status = 'active') AS member_count,
        c.last_message_at,
        wc.id AS wc_id,
        wc.root_path AS wc_root_path
      FROM conversation_members cm
      JOIN conversations c ON c.id = cm.conversation_id
      LEFT JOIN workspace_contexts wc ON wc.id = c.workspace_context_id
      WHERE cm.member_id = ? AND cm.member_type = 'agent' AND cm.status = 'active' AND c.type = 'group' AND c.status = 'active'
      ORDER BY c.last_message_at DESC`
    )
    .all(agentId);

  const groups: AgentProfileDto["groups"] = groupRows.map((row) => ({
    conversationId: row.conversation_id,
    name: row.title,
    avatar: row.avatar,
    description: row.description,
    memberCount: row.member_count,
    lastMessageAt: row.last_message_at,
    workspaceContext: row.wc_id
      ? { id: row.wc_id, rootPath: row.wc_root_path ?? "" }
      : null
  }));

  // Project experiences
  const experienceRows = db
    .prepare<[string], ExperienceRow>(
      `SELECT
        group_conversation_id,
        group_name,
        summary,
        responsibilities_json,
        key_decisions_json,
        files_touched_json,
        diff_summaries_json,
        unresolved_issues_json,
        updated_at
      FROM agent_project_experiences
      WHERE agent_id = ?
      ORDER BY updated_at DESC`
    )
    .all(agentId);

  const projectExperiences: AgentProfileDto["projectExperiences"] = experienceRows.map((row) => ({
    groupConversationId: row.group_conversation_id,
    groupName: row.group_name,
    summary: row.summary,
    responsibilities: parseJsonSafe(row.responsibilities_json, []),
    keyDecisions: parseJsonSafe(row.key_decisions_json, []),
    filesTouched: parseJsonSafe(row.files_touched_json, []),
    diffSummaries: parseJsonSafe(row.diff_summaries_json, []),
    unresolvedIssues: parseJsonSafe(row.unresolved_issues_json, []),
    updatedAt: row.updated_at
  }));

  return {
    agent: {
      id: agent.id,
      name: agent.name,
      avatar: agent.avatar,
      description: agent.description,
      capabilities: agent.capabilities,
      skillIds: agent.skillIds ?? [],
      role: agent.role,
      type: agent.type,
      runtimeProvider: agent.runtimeProvider,
      modelProviderId: agent.modelProviderId,
      model: agent.model,
      status: agent.status,
      createdAt: agent.createdAt,
      updatedAt: agent.updatedAt
    },
    skills: getAgentSkillSummaries(agent.skillIds ?? []),
    defaultWorkspaceContext,
    tools,
    groups,
    projectExperiences
  };
}

function parseJsonSafe<T>(value: string, fallback: T): T {
  try {
    const parsed = JSON.parse(value);
    return parsed ?? fallback;
  } catch {
    return fallback;
  }
}
