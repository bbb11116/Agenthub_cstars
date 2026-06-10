import fs from "node:fs";
import path from "node:path";
import type {
  CreateWorkspaceInput,
  CreateWorkspaceOutput,
  PreparedWorkspaceCreate,
  PrepareCreateWorkspaceInput,
  RuntimeProvider,
  RuntimeStatus,
  Workspace
} from "../../shared/domain";
import { isBuiltinProvider, isRuntimeProvider, RUNTIME_PROVIDERS } from "../../shared/runtime";
import { getDatabase, type AgentHubDatabase } from "../db";
import { getActiveMainAgent } from "../db/repositories/agentRepo";
import {
  createWorkspace as insertWorkspace,
  deleteWorkspace as deleteWorkspaceRecord,
  getWorkspaceByRootPath,
  getWorkspaces,
  updateWorkspace
} from "../db/repositories/workspaceRepo";
import { createMainAgentForWorkspace } from "./agentService";
import { createDefaultConversationForAgent } from "./conversationService";
import {
  checkAllRuntimeProviders,
  checkRuntimeProvider
} from "./runtimeService";
import { loadAgentFilesFromWorkspace } from "../config/agenthub-config-loader";
import { syncWorkspaceAgentsFromFiles } from "../config/agent-file-loader";

const ENABLE_AGENT_FILE_SYNC = false;

export class WorkspaceFolderError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "WorkspaceFolderError";
  }
}

export class WorkspaceInitializationError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "WorkspaceInitializationError";
  }
}

function getErrorCode(error: unknown): string | undefined {
  return typeof error === "object" && error !== null && "code" in error
    ? String((error as { code: unknown }).code)
    : undefined;
}

function toReadablePath(rootPath: string): string {
  try {
    return fs.realpathSync.native(rootPath);
  } catch {
    return path.resolve(rootPath);
  }
}

export function validateWorkspaceFolder(rootPath: string): string {
  const trimmedPath = rootPath.trim();

  if (!trimmedPath) {
    throw new WorkspaceFolderError("Workspace path is required.");
  }

  const resolvedPath = path.resolve(trimmedPath);
  let stats: fs.Stats;

  try {
    stats = fs.statSync(resolvedPath);
  } catch (error) {
    const code = getErrorCode(error);

    if (code === "ENOENT") {
      throw new WorkspaceFolderError("The selected path does not exist.", { cause: error });
    }

    if (code === "EACCES" || code === "EPERM") {
      throw new WorkspaceFolderError(
        "AgentHub does not have permission to access the selected folder.",
        { cause: error }
      );
    }

    throw new WorkspaceFolderError("Unable to read the selected folder.", { cause: error });
  }

  if (!stats.isDirectory()) {
    throw new WorkspaceFolderError("The selected path is not a directory.");
  }

  try {
    fs.accessSync(resolvedPath, fs.constants.R_OK);
  } catch (error) {
    throw new WorkspaceFolderError(
      "AgentHub does not have permission to read the selected folder.",
      { cause: error }
    );
  }

  return toReadablePath(resolvedPath);
}

function inferWorkspaceName(rootPath: string): string {
  return path.basename(rootPath) || rootPath;
}

function isGitRepository(rootPath: string): boolean {
  const gitPath = path.join(rootPath, ".git");

  try {
    const stats = fs.lstatSync(gitPath);
    return stats.isDirectory() || stats.isFile() || stats.isSymbolicLink();
  } catch {
    return false;
  }
}

function getDefaultRuntimeProvider(runtimeStatuses: RuntimeStatus[]): RuntimeProvider {
  return "builtin_openai";
}

function createUnavailableRuntimeStatuses(error: unknown): RuntimeStatus[] {
  const message = error instanceof Error ? error.message : "Runtime check failed.";
  const checkedAt = new Date().toISOString();

  return RUNTIME_PROVIDERS.map((provider) => ({
    provider,
    available: provider === "mock",
    checkedAt,
    error: provider === "mock" ? undefined : message
  }));
}

async function checkRuntimeStatusesSafely(
  checkRuntimeProviders: () => Promise<RuntimeStatus[]>
): Promise<RuntimeStatus[]> {
  try {
    return await checkRuntimeProviders();
  } catch (error) {
    return createUnavailableRuntimeStatuses(error);
  }
}

function normalizePrepareCreateWorkspaceInput(
  input: PrepareCreateWorkspaceInput
): PrepareCreateWorkspaceInput {
  if (!input || typeof input !== "object") {
    throw new WorkspaceFolderError("Workspace input is required.");
  }

  if (typeof input.rootPath !== "string") {
    throw new WorkspaceFolderError("Workspace rootPath is required.");
  }

  return {
    rootPath: input.rootPath
  };
}

function normalizeCreateWorkspaceInput(input: CreateWorkspaceInput): CreateWorkspaceInput {
  if (!input || typeof input !== "object") {
    throw new WorkspaceFolderError("Workspace input is required.");
  }

  if (typeof input.rootPath !== "string") {
    throw new WorkspaceFolderError("Workspace rootPath is required.");
  }

  if (input.name !== undefined && typeof input.name !== "string") {
    throw new WorkspaceFolderError("Workspace name must be a string.");
  }

  const provider = isRuntimeProvider(input.mainAgentRuntimeProvider)
    ? input.mainAgentRuntimeProvider
    : "builtin_openai";

  return {
    rootPath: input.rootPath,
    name: input.name,
    mainAgentRuntimeProvider: provider
  };
}

function normalizeWorkspaceId(workspaceId: unknown): string {
  if (typeof workspaceId !== "string" || workspaceId.trim().length === 0) {
    throw new WorkspaceInitializationError("Workspace id is required.");
  }

  return workspaceId.trim();
}

export function listWorkspaces(): Workspace[] {
  return getWorkspaces();
}

function ensureMainAgentForWorkspace(
  workspace: Workspace,
  runtimeProvider: RuntimeProvider,
  db: AgentHubDatabase
): CreateWorkspaceOutput {
  const activeMainAgent = getActiveMainAgent(db);
  const { agent, defaultConversation } = activeMainAgent
    ? {
        agent: activeMainAgent,
        defaultConversation: createDefaultConversationForAgent(activeMainAgent, db)
      }
    : createMainAgentForWorkspace(workspace, runtimeProvider, db);

  const workspaceWithMainAgent =
    workspace.mainAgentId === agent.id
      ? workspace
      : updateWorkspace(
          workspace.id,
          {
            mainAgentId: agent.id
          },
          db
        );

  if (!workspaceWithMainAgent) {
    throw new WorkspaceInitializationError("Unable to link the main Agent to the Workspace.");
  }

  return {
    workspace: workspaceWithMainAgent,
    mainAgent: agent,
    mainConversation: defaultConversation
  };
}

async function assertRuntimeAvailable(
  runtimeProvider: RuntimeProvider,
  checkRuntime: (provider: RuntimeProvider) => Promise<RuntimeStatus>
): Promise<void> {
  const runtimeStatus =
    runtimeProvider === "mock" || isBuiltinProvider(runtimeProvider)
      ? {
          provider: runtimeProvider,
          available: true,
          checkedAt: new Date().toISOString()
        }
      : await checkRuntime(runtimeProvider);

  if (!runtimeStatus.available) {
    throw new WorkspaceInitializationError(
      `${runtimeProvider} is unavailable. Select an available runtime or AgentHub Built-in.`
    );
  }
}

export async function prepareCreateWorkspace(
  input: PrepareCreateWorkspaceInput,
  db: AgentHubDatabase = getDatabase(),
  checkRuntimeProviders: () => Promise<RuntimeStatus[]> = checkAllRuntimeProviders
): Promise<PreparedWorkspaceCreate> {
  const normalizedInput = normalizePrepareCreateWorkspaceInput(input);
  const rootPath = validateWorkspaceFolder(normalizedInput.rootPath);
  const runtimeStatuses = await checkRuntimeStatusesSafely(checkRuntimeProviders);

  return {
    rootPath,
    inferredName: inferWorkspaceName(rootPath),
    gitEnabled: isGitRepository(rootPath),
    runtimeStatuses,
    defaultRuntimeProvider: getDefaultRuntimeProvider(runtimeStatuses),
    existingWorkspace: getWorkspaceByRootPath(rootPath, db) ?? undefined
  };
}

export async function createWorkspaceFromFolder(
  input: CreateWorkspaceInput,
  db: AgentHubDatabase = getDatabase(),
  checkRuntime: (provider: RuntimeProvider) => Promise<RuntimeStatus> = checkRuntimeProvider
): Promise<CreateWorkspaceOutput> {
  const normalizedInput = normalizeCreateWorkspaceInput(input);
  const rootPath = validateWorkspaceFolder(normalizedInput.rootPath);
  const runtimeProvider = normalizedInput.mainAgentRuntimeProvider as RuntimeProvider;
  const existingWorkspace = getWorkspaceByRootPath(rootPath, db);

  if (existingWorkspace) {
    const ensureMainAgent = db.transaction((workspace: Workspace) =>
      ensureMainAgentForWorkspace(workspace, runtimeProvider, db)
    );

    const result = ensureMainAgent(existingWorkspace);

    // Sync agent files on re-open
    syncAgentFilesFromWorkspace(rootPath, result.workspace.id, db);

    return result;
  }

  await assertRuntimeAvailable(runtimeProvider, checkRuntime);

  const createWorkspaceWithMainAgent = db.transaction((createInput: CreateWorkspaceInput) => {
    const workspace = insertWorkspace(createInput, db);

    return ensureMainAgentForWorkspace(workspace, runtimeProvider, db);
  });

  const result = createWorkspaceWithMainAgent({
    rootPath,
    name: normalizedInput.name?.trim() || inferWorkspaceName(rootPath),
    gitEnabled: isGitRepository(rootPath)
  });

  // Sync agent files from .agenthub/agents/
  syncAgentFilesFromWorkspace(rootPath, result.workspace.id, db);

  return result;
}

function ensureWorkspaceConfigDir(rootPath: string): void {
  const agenthubDir = path.join(rootPath, ".agenthub");
  const agentsDir = path.join(agenthubDir, "agents");
  const promptsDir = path.join(agenthubDir, "prompts");

  try {
    if (!fs.existsSync(agentsDir)) {
      fs.mkdirSync(agentsDir, { recursive: true });
    }
    if (!fs.existsSync(promptsDir)) {
      fs.mkdirSync(promptsDir, { recursive: true });
    }
  } catch {
    // Directory creation is non-fatal
  }
}

function syncAgentFilesFromWorkspace(rootPath: string, workspaceId: string, db: AgentHubDatabase): void {
  if (!ENABLE_AGENT_FILE_SYNC) {
    return;
  }

  try {
    ensureWorkspaceConfigDir(rootPath);
    const agentFiles = loadAgentFilesFromWorkspace(rootPath);
    if (agentFiles.length > 0) {
      syncWorkspaceAgentsFromFiles(workspaceId, rootPath, agentFiles, db);
    }
  } catch {
    // Agent file sync is non-fatal
  }
}

export function createWorkspace(input: CreateWorkspaceInput): Promise<CreateWorkspaceOutput> {
  return createWorkspaceFromFolder(input);
}

export function deleteWorkspaceById(
  workspaceId: string,
  db: AgentHubDatabase = getDatabase()
): boolean {
  const normalizedWorkspaceId = normalizeWorkspaceId(workspaceId);
  const deleteWorkspaceTransaction = db.transaction((id: string) =>
    deleteWorkspaceRecord(id, db)
  );

  return deleteWorkspaceTransaction(normalizedWorkspaceId);
}
