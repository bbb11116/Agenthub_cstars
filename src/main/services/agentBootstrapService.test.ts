import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { closeDatabase, initializeDatabase } from "../db";
import {
  createAgent,
  getAgentById,
  getAgentContacts,
  getNonDeletedMainAgents
} from "../db/repositories/agentRepo";
import {
  createAgentRun,
  getAgentRunById
} from "../db/repositories/agentRunRepo";
import { createMember, getMembersByConversation } from "../db/repositories/conversationMemberRepo";
import {
  createConversation,
  getChats,
  getConversationById,
  getConversationsByAgent
} from "../db/repositories/conversationRepo";
import {
  createWorkspaceContext,
  getDefaultAgentWorkspaceRoot,
  getWorkspaceContextById
} from "../db/repositories/workspaceContextRepo";
import { createWorkspace, getWorkspaceById } from "../db/repositories/workspaceRepo";
import { deleteSubAgent } from "./agentDeletionService";
import { createDefaultConversationForAgent } from "./conversationService";
import { createMessage, listMessagesByConversation } from "./messageService";
import { getNavigationTree } from "./navigationService";
import { resolveExecutionWorkspaceForAgentDirect } from "./workspaceContextResolver";
import {
  DEFAULT_MAIN_AGENT_DESCRIPTION,
  DEFAULT_MAIN_AGENT_NAME,
  ensureDefaultMainAgent
} from "./agentBootstrapService";
import { recoverStaleRunningAgentState } from "./staleRunRecoveryService";

let tempDir: string | null = null;

function initializeTempDatabase() {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "agenthub-main-agent-"));
  vi.spyOn(os, "homedir").mockReturnValue(tempDir);
  return initializeDatabase({ dbPath: path.join(tempDir, "agenthub.db") });
}

afterEach(() => {
  closeDatabase();
  vi.restoreAllMocks();

  if (tempDir) {
    fs.rmSync(tempDir, { recursive: true, force: true });
    tempDir = null;
  }
});

describe("ensureDefaultMainAgent", () => {
  it("creates one reusable global main Agent with a context, direct chat, and contact entry", async () => {
    const db = initializeTempDatabase();
    const firstAgent = await ensureDefaultMainAgent(db);
    const secondAgent = await ensureDefaultMainAgent(db);
    const context = getWorkspaceContextById(firstAgent.defaultWorkspaceContextId!, db);
    const conversations = getConversationsByAgent(firstAgent.id, db);

    expect(secondAgent.id).toBe(firstAgent.id);
    expect(firstAgent).toMatchObject({
      name: DEFAULT_MAIN_AGENT_NAME,
      description: DEFAULT_MAIN_AGENT_DESCRIPTION,
      role: "main",
      type: "orchestrator",
      runtimeProvider: "builtin_openai",
      status: "available"
    });
    expect(context).toMatchObject({
      ownerType: "agent",
      ownerId: firstAgent.id,
      rootPath: path.join(
        tempDir!,
        "Documents",
        "AgentHub",
        "agents",
        `${firstAgent.id}-main-agent`
      )
    });
    expect(conversations).toHaveLength(1);
    expect(conversations[0].workspaceContextId).toBe(context?.id);
    expect(
      resolveExecutionWorkspaceForAgentDirect(firstAgent.id, conversations[0].id, db)
        .workspaceContextId
    ).toBe(context?.id);
    expect(getAgentContacts(db).map((agent) => agent.id)).toContain(firstAgent.id);
    expect(getChats(db).map((conversation) => conversation.id)).toContain(conversations[0].id);
  });

  it("rejects deletion of the global main Agent without changing its data", async () => {
    const db = initializeTempDatabase();
    const mainAgent = await ensureDefaultMainAgent(db);

    expect(() => deleteSubAgent({ agentId: mainAgent.id }, db)).toThrow(
      "Main agent cannot be deleted."
    );
    expect(getAgentContacts(db).map((agent) => agent.id)).toContain(mainAgent.id);
    expect(getConversationsByAgent(mainAgent.id, db)).toHaveLength(1);
  });

  it("removes redundant main Agents, relinks group history, and trashes safe private directories", async () => {
    const db = initializeTempDatabase();
    const mainAgent = await ensureDefaultMainAgent(db);
    const redundantAgentId = "redundant-main-agent";
    const redundantRoot = getDefaultAgentWorkspaceRoot(redundantAgentId, "redundant-main");
    const redundantWorkspace = createWorkspace(
      {
        name: "Redundant Main Context",
        rootPath: redundantRoot,
        mainAgentId: redundantAgentId,
        gitEnabled: false
      },
      db
    );
    const redundantContext = createWorkspaceContext(
      {
        ownerType: "agent",
        ownerId: redundantAgentId,
        rootPath: redundantRoot,
        gitEnabled: false
      },
      db
    );
    const redundantAgent = createAgent(
      {
        id: redundantAgentId,
        workspaceId: redundantWorkspace.id,
        defaultWorkspaceContextId: redundantContext.id,
        name: "Redundant Main",
        role: "main",
        type: "orchestrator",
        runtimeProvider: "mock",
        status: "available"
      },
      db
    );
    const redundantDirectConversation = createDefaultConversationForAgent(redundantAgent, db);
    const groupWorkspace = createWorkspace(
      {
        name: "Group Context",
        rootPath: path.join(tempDir!, "group"),
        mainAgentId: redundantAgent.id,
        gitEnabled: false
      },
      db
    );
    const groupConversation = createConversation(
      {
        workspaceId: groupWorkspace.id,
        agentId: redundantAgent.id,
        title: "History Group",
        mode: "single",
        type: "group",
        mainAgentId: redundantAgent.id
      },
      db
    );
    createMember(
      {
        conversationId: groupConversation.id,
        memberType: "agent",
        memberId: redundantAgent.id,
        role: "main_agent"
      },
      db
    );
    createMessage(
      {
        workspaceId: groupWorkspace.id,
        conversationId: groupConversation.id,
        senderType: "agent",
        senderId: redundantAgent.id,
        messageType: "text",
        content: { text: "Historical answer" }
      },
      db
    );
    fs.writeFileSync(path.join(redundantRoot, "private.txt"), "remove me");

    await ensureDefaultMainAgent(db);

    expect(getNonDeletedMainAgents(db).map((agent) => agent.id)).toEqual([mainAgent.id]);
    expect(getAgentById(redundantAgent.id, db)).toMatchObject({
      name: "已删除 Agent",
      role: "sub",
      type: "specialist",
      status: "deleted"
    });
    expect(getConversationById(redundantDirectConversation.id, db)).toBeNull();
    expect(getConversationById(groupConversation.id, db)).toMatchObject({
      agentId: mainAgent.id,
      mainAgentId: mainAgent.id
    });
    expect(getMembersByConversation(groupConversation.id, db)).toContainEqual(
      expect.objectContaining({
        memberId: mainAgent.id,
        role: "main_agent"
      })
    );
    expect(getWorkspaceById(redundantWorkspace.id, db)?.mainAgentId).toBe(mainAgent.id);
    expect(getWorkspaceById(groupWorkspace.id, db)?.mainAgentId).toBe(mainAgent.id);
    expect(getWorkspaceContextById(redundantContext.id, db)).toBeNull();
    expect(fs.existsSync(redundantRoot)).toBe(false);
    expect(
      fs
        .readdirSync(path.join(tempDir!, "Documents", "AgentHub", ".trash", "agents"))
        .some((entry) => entry.startsWith(`${redundantAgent.id}-`))
    ).toBe(true);
    expect(listMessagesByConversation(groupConversation.id, db)[0].metadata).toMatchObject({
      senderDisplayName: "已删除 Agent"
    });
  });

  it("relinks legacy workspaces during navigation without creating another main Agent", async () => {
    const db = initializeTempDatabase();
    const mainAgent = await ensureDefaultMainAgent(db);
    const legacyWorkspace = createWorkspace(
      {
        name: "Legacy Workspace",
        rootPath: path.join(tempDir!, "legacy"),
        gitEnabled: false
      },
      db
    );

    const tree = getNavigationTree(db);

    expect(tree.find((entry) => entry.workspace.id === legacyWorkspace.id)?.workspace.mainAgentId)
      .toBe(mainAgent.id);
    expect(getNonDeletedMainAgents(db).map((agent) => agent.id)).toEqual([mainAgent.id]);
  });

  it("recovers stale running sub-agent runs without an active conversation lock", async () => {
    const db = initializeTempDatabase();
    const workspace = createWorkspace(
      {
        name: "Workspace",
        rootPath: path.join(tempDir!, "workspace"),
        gitEnabled: false
      },
      db
    );
    const agent = createAgent(
      {
        workspaceId: workspace.id,
        name: "前端",
        role: "sub",
        type: "specialist",
        runtimeProvider: "mock",
        status: "running"
      },
      db
    );
    const conversation = createConversation(
      {
        workspaceId: workspace.id,
        agentId: agent.id,
        title: "Default Chat",
        mode: "single"
      },
      db
    );
    const run = createAgentRun(
      {
        conversationId: conversation.id,
        workspaceId: workspace.id,
        agentId: agent.id,
        provider: "mock",
        rootPath: workspace.rootPath,
        systemPromptSnapshot: "",
        toolPermissionsSnapshot: "mock"
      },
      db
    );
    db.prepare("UPDATE agent_runs SET started_at = ? WHERE id = ?").run(
      "2026-06-10T00:00:00.000Z",
      run.id
    );

    const result = recoverStaleRunningAgentState(db, {
      now: new Date("2026-06-12T00:00:00.000Z"),
      staleAfterMs: 60_000
    });

    expect(result).toMatchObject({
      recoveredAgentRuns: 1,
      recoveredAgents: 1
    });
    expect(getAgentRunById(run.id, db)).toMatchObject({
      status: "failed",
      errorMessage: "Recovered stale running Agent run."
    });
    expect(getAgentById(agent.id, db)).toMatchObject({
      status: "error"
    });
  });
});
