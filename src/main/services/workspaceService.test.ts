import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { closeDatabase, initializeDatabase } from "../db";
import {
  deleteAgent,
  getAgentsByWorkspace,
  getNonDeletedMainAgents
} from "../db/repositories/agentRepo";
import { getConversationsByAgent } from "../db/repositories/conversationRepo";
import { getWorkspaceById, getWorkspaces } from "../db/repositories/workspaceRepo";
import {
  buildMainAgentSystemPrompt,
  createMainAgentForWorkspace,
  defaultMainAgent
} from "./agentService";
import { DEFAULT_MAIN_CONVERSATION_TITLE } from "./conversationService";
import {
  createWorkspaceFromFolder,
  deleteWorkspaceById,
  prepareCreateWorkspace
} from "./workspaceService";

let tempDir: string | null = null;

function createTempRoot(): string {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "agenthub-workspace-service-"));
  return tempDir;
}

afterEach(() => {
  closeDatabase();

  if (tempDir) {
    fs.rmSync(tempDir, { recursive: true, force: true });
    tempDir = null;
  }
});

describe("workspaceService", () => {
  it("prepares a workspace without writing data and defaults to the built-in orchestrator", async () => {
    const rootPath = createTempRoot();
    initializeDatabase({ dbPath: path.join(rootPath, "agenthub.db") });
    const prepared = await prepareCreateWorkspace(
      { rootPath },
      undefined,
      async () => [
        {
          provider: "codex_local",
          available: true,
          version: "1.2.3",
          checkedAt: new Date().toISOString()
        },
        {
          provider: "claude_code",
          available: true,
          checkedAt: new Date().toISOString()
        },
        {
          provider: "opencode",
          available: false,
          error: "command not found",
          checkedAt: new Date().toISOString()
        },
        {
          provider: "mock",
          available: true,
          checkedAt: new Date().toISOString()
        }
      ]
    );

    expect(prepared.rootPath).toBe(fs.realpathSync.native(rootPath));
    expect(prepared.inferredName).toBe(path.basename(rootPath));
    expect(prepared.gitEnabled).toBe(false);
    expect(prepared.defaultRuntimeProvider).toBe("builtin_openai");
    expect(getWorkspaces()).toHaveLength(0);
  });

  it("creates a non-git workspace and reuses the same folder on repeat create", async () => {
    const rootPath = createTempRoot();
    initializeDatabase({ dbPath: path.join(rootPath, "agenthub.db") });

    const { workspace } = await createWorkspaceFromFolder({
      rootPath,
      mainAgentRuntimeProvider: "mock"
    });
    const duplicateResult = await createWorkspaceFromFolder({
      rootPath,
      mainAgentRuntimeProvider: "mock"
    });

    expect(workspace.rootPath).toBe(fs.realpathSync.native(rootPath));
    expect(workspace.name).toBe(path.basename(rootPath));
    expect(workspace.gitEnabled).toBe(false);
    expect(duplicateResult.workspace).toEqual(workspace);
  });

  it("creates a fixed main agent and default conversation for a new workspace", async () => {
    const rootPath = createTempRoot();
    initializeDatabase({ dbPath: path.join(rootPath, "agenthub.db") });

    const { workspace, mainAgent, mainConversation } = await createWorkspaceFromFolder({
      rootPath,
      mainAgentRuntimeProvider: "codex_local"
    }, undefined, async (provider) => ({
      provider,
      available: true,
      checkedAt: new Date().toISOString()
    }));
    const agents = getAgentsByWorkspace(workspace.id);

    expect(agents).toHaveLength(1);
    expect(workspace.mainAgentId).toBe(agents[0].id);
    expect(getWorkspaceById(workspace.id)?.mainAgentId).toBe(agents[0].id);
    expect(mainAgent).toMatchObject({
      workspaceId: workspace.id,
      name: `${workspace.name} Main Agent`,
      role: "main",
      runtimeProvider: "codex_local",
      systemPrompt: buildMainAgentSystemPrompt(workspace.rootPath, "codex_local"),
      capabilities: defaultMainAgent.capabilities,
      tools: defaultMainAgent.tools,
      status: "available"
    });

    const conversations = getConversationsByAgent(agents[0].id);

    expect(conversations).toHaveLength(1);
    expect(mainConversation).toMatchObject({
      workspaceId: workspace.id,
      agentId: mainAgent.id,
      title: DEFAULT_MAIN_CONVERSATION_TITLE,
      mode: "single"
    });
  });

  it("does not duplicate the main agent or default conversation on repeat initialization", async () => {
    const rootPath = createTempRoot();
    initializeDatabase({ dbPath: path.join(rootPath, "agenthub.db") });

    const { workspace } = await createWorkspaceFromFolder({
      rootPath,
      mainAgentRuntimeProvider: "mock"
    });
    const firstAgent = getAgentsByWorkspace(workspace.id)[0];
    const firstConversation = getConversationsByAgent(firstAgent.id)[0];
    const repeatedMainAgent = createMainAgentForWorkspace(workspace);
    const duplicateResult = await createWorkspaceFromFolder({
      rootPath,
      mainAgentRuntimeProvider: "codex_local"
    });
    const agents = getAgentsByWorkspace(workspace.id);
    const conversations = getConversationsByAgent(firstAgent.id);

    expect(repeatedMainAgent.agent.id).toBe(firstAgent.id);
    expect(repeatedMainAgent.defaultConversation.id).toBe(firstConversation.id);
    expect(duplicateResult.workspace.mainAgentId).toBe(firstAgent.id);
    expect(duplicateResult.mainAgent.runtimeProvider).toBe("mock");
    expect(agents).toHaveLength(1);
    expect(conversations).toHaveLength(1);
  });

  it("reuses the global main Agent when creating a second workspace", async () => {
    const rootPath = createTempRoot();
    const firstRoot = path.join(rootPath, "first");
    const secondRoot = path.join(rootPath, "second");
    fs.mkdirSync(firstRoot);
    fs.mkdirSync(secondRoot);
    initializeDatabase({ dbPath: path.join(rootPath, "agenthub.db") });

    const first = await createWorkspaceFromFolder({
      rootPath: firstRoot,
      mainAgentRuntimeProvider: "mock"
    });
    const second = await createWorkspaceFromFolder({
      rootPath: secondRoot,
      mainAgentRuntimeProvider: "codex_local"
    });

    expect(second.mainAgent.id).toBe(first.mainAgent.id);
    expect(second.workspace.mainAgentId).toBe(first.mainAgent.id);
    expect(getAgentsByWorkspace(second.workspace.id)).toHaveLength(0);
    expect(getNonDeletedMainAgents().map((agent) => agent.id)).toEqual([first.mainAgent.id]);
  });

  it("does not allow the main agent to be deleted by ordinary agent deletion", async () => {
    const rootPath = createTempRoot();
    initializeDatabase({ dbPath: path.join(rootPath, "agenthub.db") });

    const { workspace } = await createWorkspaceFromFolder({
      rootPath,
      mainAgentRuntimeProvider: "mock"
    });
    const mainAgent = getAgentsByWorkspace(workspace.id)[0];

    expect(deleteAgent(mainAgent.id)).toBe(false);
    expect(getAgentsByWorkspace(workspace.id)).toHaveLength(1);
  });

  it("rolls back the workspace and main agent when default conversation creation fails", async () => {
    const rootPath = createTempRoot();
    const db = initializeDatabase({ dbPath: path.join(rootPath, "agenthub.db") });

    db.prepare("DROP TABLE conversations").run();

    await expect(
      createWorkspaceFromFolder({
        rootPath,
        mainAgentRuntimeProvider: "mock"
      })
    ).rejects.toThrow();
    expect(getWorkspaces(db)).toHaveLength(0);
    expect(getAgentsByWorkspace("missing-workspace", db)).toHaveLength(0);
  });

  it("detects a selected git repository without rejecting it", async () => {
    const rootPath = createTempRoot();
    fs.mkdirSync(path.join(rootPath, ".git"));
    initializeDatabase({ dbPath: path.join(rootPath, "agenthub.db") });

    const { workspace } = await createWorkspaceFromFolder({
      rootPath,
      mainAgentRuntimeProvider: "mock"
    });

    expect(workspace.gitEnabled).toBe(true);
  });

  it("does not auto-create sub Agents from .agenthub/agents files when opening a workspace", async () => {
    const rootPath = createTempRoot();
    const agentsDir = path.join(rootPath, ".agenthub", "agents");

    fs.mkdirSync(agentsDir, { recursive: true });
    fs.writeFileSync(
      path.join(agentsDir, "frontend.agent.json"),
      JSON.stringify({
        version: 1,
        name: "File Frontend Agent",
        type: "specialist",
        provider: "codex_local",
        description: "Should not be synchronized automatically.",
        systemPrompt: "Review frontend code.",
        tools: ["read_file"]
      })
    );
    initializeDatabase({ dbPath: path.join(rootPath, "agenthub.db") });

    const { workspace } = await createWorkspaceFromFolder({
      rootPath,
      mainAgentRuntimeProvider: "mock"
    });
    await createWorkspaceFromFolder({
      rootPath,
      mainAgentRuntimeProvider: "mock"
    });

    expect(getAgentsByWorkspace(workspace.id).map((agent) => agent.name)).toEqual([
      `${workspace.name} Main Agent`
    ]);
  });

  it("deletes only AgentHub workspace data and keeps the local folder", async () => {
    const rootPath = createTempRoot();
    initializeDatabase({ dbPath: path.join(rootPath, "agenthub.db") });

    const { workspace, mainAgent } = await createWorkspaceFromFolder({
      rootPath,
      mainAgentRuntimeProvider: "mock"
    });

    expect(getAgentsByWorkspace(workspace.id)).toHaveLength(1);
    expect(getConversationsByAgent(mainAgent.id)).toHaveLength(1);

    const deleted = deleteWorkspaceById(workspace.id);

    expect(deleted).toBe(true);
    expect(getWorkspaceById(workspace.id)).toBeNull();
    expect(getAgentsByWorkspace(workspace.id)).toHaveLength(0);
    expect(getConversationsByAgent(mainAgent.id)).toHaveLength(0);
    expect(fs.existsSync(rootPath)).toBe(true);
  });
});
