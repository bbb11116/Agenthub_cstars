import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { closeDatabase, initializeDatabase } from "../db";
import { getAgentById, getAgentContacts } from "../db/repositories/agentRepo";
import { createAgentRun, getAgentRunsByConversation } from "../db/repositories/agentRunRepo";
import { createArtifact, getArtifactsByConversation } from "../db/repositories/artifactRepo";
import {
  createConversationCompactSummary,
  getLatestConversationCompactSummary
} from "../db/repositories/conversationCompactSummaryRepo";
import {
  getChats,
  getConversationById
} from "../db/repositories/conversationRepo";
import { getMember } from "../db/repositories/conversationMemberRepo";
import { createDiffProposal, getDiffProposalsByConversation } from "../db/repositories/diffRepo";
import { createDispatchRun } from "../db/repositories/dispatchRunRepo";
import {
  createDispatchStep,
  getDispatchStepById
} from "../db/repositories/dispatchStepRepo";
import { createMessage } from "../db/repositories/messageRepo";
import {
  createProviderSession,
  getProviderSessionsByConversation
} from "../db/repositories/providerSessionRepo";
import { upsertExperience, getByAgent } from "../db/repositories/agentProjectExperienceRepo";
import { getWorkspaceContextById } from "../db/repositories/workspaceContextRepo";
import { createWorkspace } from "../db/repositories/workspaceRepo";
import { createSubAgentManually } from "./agentService";
import {
  deleteSubAgent,
  moveDefaultAgentWorkspaceToTrash
} from "./agentDeletionService";
import { ensureDefaultMainAgent } from "./agentBootstrapService";
import { addAgentMember, createGroupConversation } from "./groupChatService";
import { listMessagesByConversation } from "./messageService";

let tempDir: string | null = null;

function initializeTempDatabase() {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "agenthub-delete-agent-"));
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

describe("deleteSubAgent", () => {
  it("cleans private data, preserves group history, and moves a default directory to trash", async () => {
    const db = initializeTempDatabase();
    await ensureDefaultMainAgent(db);
    const { agent, conversation: directConversation } = createSubAgentManually(
      {
        provider: "codex_local",
        name: "Disposable Agent"
      },
      db
    );
    const workspaceContext = getWorkspaceContextById(agent.defaultWorkspaceContextId!, db)!;
    const directMessage = createMessage(
      {
        workspaceId: directConversation.workspaceId,
        conversationId: directConversation.id,
        senderType: "user",
        senderId: "local-user",
        messageType: "text",
        content: { text: "private" }
      },
      db
    );
    createConversationCompactSummary(
      {
        conversationId: directConversation.id,
        coveredMessageStartId: directMessage.id,
        coveredMessageEndId: directMessage.id,
        summary: "private summary"
      },
      db
    );
    createProviderSession(
      {
        conversationId: directConversation.id,
        workspaceId: directConversation.workspaceId,
        agentId: agent.id,
        provider: agent.runtimeProvider,
        providerSessionId: "direct-session",
        workspaceContextId: workspaceContext.id,
        rootPath: workspaceContext.rootPath
      },
      db
    );
    createAgentRun(
      {
        conversationId: directConversation.id,
        workspaceId: directConversation.workspaceId,
        agentId: agent.id,
        provider: agent.runtimeProvider,
        rootPath: workspaceContext.rootPath,
        workspaceContextId: workspaceContext.id,
        systemPromptSnapshot: agent.systemPrompt,
        toolPermissionsSnapshot: JSON.stringify(agent.tools)
      },
      db
    );
    createArtifact(
      {
        workspaceId: directConversation.workspaceId,
        agentId: agent.id,
        conversationId: directConversation.id,
        title: "Private Artifact",
        type: "code",
        content: "private"
      },
      db
    );
    createDiffProposal(
      {
        workspaceId: directConversation.workspaceId,
        agentId: agent.id,
        conversationId: directConversation.id,
        filePath: "private.ts",
        oldContentHash: "old",
        newContentHash: "new",
        diffContent: "diff",
        newContent: "next"
      },
      db
    );

    const { conversation: groupConversation } = createGroupConversation(
      { title: "Audit Room" },
      db
    );
    addAgentMember({ conversationId: groupConversation.id, agentId: agent.id }, db);
    const groupMessage = createMessage(
      {
        workspaceId: groupConversation.workspaceId,
        conversationId: groupConversation.id,
        senderType: "agent",
        senderId: agent.id,
        messageType: "text",
        content: { text: "keep for audit" }
      },
      db
    );
    upsertExperience(
      agent.id,
      groupConversation.id,
      { summary: "private experience" },
      db
    );
    const dispatchRun = createDispatchRun(
      {
        conversationId: groupConversation.id,
        triggerMessageId: groupMessage.id,
        mode: "mention"
      },
      db
    );
    const dispatchStep = createDispatchStep(
      {
        dispatchRunId: dispatchRun.id,
        stepIndex: 0,
        agentId: agent.id,
        instruction: "pending work"
      },
      db
    );

    const result = deleteSubAgent({ agentId: agent.id }, db);
    const tombstone = getAgentById(agent.id, db);
    const preservedGroupMessage = listMessagesByConversation(groupConversation.id, db).find(
      (message) => message.id === groupMessage.id
    );

    expect(result.deletedConversationIds).toEqual([directConversation.id]);
    expect(result.trashedWorkspaceDirectory).toContain(
      path.join("Documents", "AgentHub", ".trash", "agents", agent.id)
    );
    expect(fs.existsSync(workspaceContext.rootPath)).toBe(false);
    expect(tombstone).toMatchObject({
      name: "已删除 Agent",
      description: "",
      status: "deleted",
      systemPrompt: "",
      fileScope: []
    });
    expect(getAgentContacts(db).map((contact) => contact.id)).not.toContain(agent.id);
    expect(getChats(db).map((chat) => chat.id)).not.toContain(directConversation.id);
    expect(getConversationById(directConversation.id, db)).toBeNull();
    expect(getLatestConversationCompactSummary(directConversation.id, db)).toBeNull();
    expect(getProviderSessionsByConversation(directConversation.id, db)).toHaveLength(0);
    expect(getAgentRunsByConversation(directConversation.id, db)).toHaveLength(0);
    expect(getArtifactsByConversation(directConversation.id, db)).toHaveLength(0);
    expect(getDiffProposalsByConversation(directConversation.id, db)).toHaveLength(0);
    expect(getByAgent(agent.id, db)).toHaveLength(0);
    expect(getMember(groupConversation.id, "agent", agent.id, db)).toBeNull();
    expect(getDispatchStepById(dispatchStep.id, db)?.status).toBe("cancelled");
    expect(preservedGroupMessage?.metadata?.senderDisplayName).toBe("已删除 Agent");
  });

  it("preserves a user-selected project directory and reports a warning", () => {
    const db = initializeTempDatabase();
    const projectRoot = path.join(tempDir!, "project");
    fs.mkdirSync(projectRoot);
    const workspace = createWorkspace(
      {
        name: "User Project",
        rootPath: projectRoot
      },
      db
    );
    const { agent } = createSubAgentManually(
      {
        workspaceId: workspace.id,
        provider: "codex_local",
        name: "Project Agent"
      },
      db
    );

    const result = deleteSubAgent({ agentId: agent.id }, db);

    expect(result.warning).toContain("不是系统创建的安全目录");
    expect(fs.existsSync(projectRoot)).toBe(true);
  });

  it("does not move an agents directory whose basename omits the stable Agent id", () => {
    initializeTempDatabase();
    const rootPath = path.join(tempDir!, "Documents", "AgentHub", "agents", "unsafe-name");
    fs.mkdirSync(rootPath, { recursive: true });

    const result = moveDefaultAgentWorkspaceToTrash("agent-id", rootPath);

    expect(result.warning).toContain("不是系统创建的安全目录");
    expect(fs.existsSync(rootPath)).toBe(true);
  });
});
