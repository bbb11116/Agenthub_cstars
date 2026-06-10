import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { closeDatabase, initializeDatabase, type AgentHubDatabase } from "../db";
import { getAgentById } from "../db/repositories/agentRepo";
import { getLatestConversationCompactSummary } from "../db/repositories/conversationCompactSummaryRepo";
import { getMessagesByConversation, createMessage } from "../db/repositories/messageRepo";
import {
  createProviderSession,
  getActiveProviderSession,
  getProviderSessionsByConversation,
  markActiveSessionsAsReplacedForAgent
} from "../db/repositories/providerSessionRepo";
import { getWorkspaceContextById } from "../db/repositories/workspaceContextRepo";
import { getWorkspaceById } from "../db/repositories/workspaceRepo";
import {
  buildMainAgentSystemPrompt,
  buildManualSubAgentSystemPrompt,
  createSubAgentManually,
  updateAgentDefaultWorkspace,
  updateAgentProfile
} from "./agentService";
import { readWorkspaceFile } from "./fileService";
import { readGitStatus } from "./gitService";
import {
  addAgentMember,
  createGroupConversation,
  getAvailableAgentsForGroup,
  removeAgentMember,
  updateGroupProfile,
  updateGroupWorkspace
} from "./groupChatService";
import { buildDirectAgentMemoryContext } from "./memoryContextService";
import {
  resolveExecutionWorkspaceForAgentDirect,
  resolveExecutionWorkspaceForGroup
} from "./workspaceContextResolver";

let tempDir: string | null = null;

function initializeTempDatabase(): AgentHubDatabase {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "agenthub-context-"));
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

describe("WorkspaceContext architecture", () => {
  it("creates a global Agent contact with a hidden canonical workspace context", () => {
    const db = initializeTempDatabase();
    const { agent, conversation } = createSubAgentManually(
      {
        provider: "codex_local",
        name: "Frontend Agent",
        description: "Own React implementation."
      },
      db
    );

    const context = getWorkspaceContextById(agent.defaultWorkspaceContextId!, db);
    const workspace = getWorkspaceById(agent.workspaceId, db);

    expect(context).toMatchObject({
      ownerType: "agent",
      ownerId: agent.id,
      rootPath: path.join(
        tempDir!,
        "Documents",
        "AgentHub",
        "agents",
        `${agent.id}-frontend-agent`
      )
    });
    expect(workspace?.rootPath).toBe(context?.rootPath);
    expect(conversation.workspaceContextId).toBe(context?.id);
    expect(fs.statSync(context!.rootPath).isDirectory()).toBe(true);

    updateAgentProfile({ agentId: agent.id, name: "Renamed Agent" }, db);
    expect(resolveExecutionWorkspaceForAgentDirect(agent.id, conversation.id, db).rootPath).toBe(
      context?.rootPath
    );
  });

  it("uses the stable group context root for members created under different hidden workspaces", async () => {
    const db = initializeTempDatabase();
    const { agent } = createSubAgentManually(
      {
        provider: "codex_local",
        name: "API Agent",
        description: "Own API implementation."
      },
      db
    );
    const { conversation } = createGroupConversation({ title: "Release Room" }, db);

    expect(getAvailableAgentsForGroup(conversation.id, db).map((item) => item.id)).toContain(
      agent.id
    );
    const member = addAgentMember({ conversationId: conversation.id, agentId: agent.id }, db);

    const resolved = resolveExecutionWorkspaceForGroup(conversation.id, db);
    expect(agent.workspaceId).not.toBe(conversation.workspaceId);
    expect(resolved.workspaceContext.ownerType).toBe("group");
    expect(resolved.workspaceContext.ownerId).toBe(conversation.id);
    expect(resolved.rootPath).toContain(
      path.join("Documents", "AgentHub", "groups", conversation.id)
    );

    updateGroupProfile({ conversationId: conversation.id, title: "Renamed Room" }, db);
    expect(resolveExecutionWorkspaceForGroup(conversation.id, db).rootPath).toBe(
      resolved.rootPath
    );

    fs.writeFileSync(path.join(resolved.rootPath, "group-only.txt"), "group-context");
    await expect(
      readWorkspaceFile(
        {
          workspaceId: agent.workspaceId,
          conversationId: conversation.id,
          relativePath: "group-only.txt"
        },
        db
      )
    ).resolves.toMatchObject({ content: "group-context" });
    await expect(
      readGitStatus({ workspaceId: agent.workspaceId, conversationId: conversation.id }, db)
    ).resolves.toMatchObject({ isGitRepo: false });

    expect(removeAgentMember({ conversationId: conversation.id, memberId: member.id }, db)).toBe(
      true
    );
    expect(getAvailableAgentsForGroup(conversation.id, db).map((item) => item.id)).toContain(
      agent.id
    );
  });

  it("keeps provider sessions isolated by context and execution scope", () => {
    const db = initializeTempDatabase();
    const { agent } = createSubAgentManually(
      {
        provider: "claude_code",
        name: "Session Agent",
        description: "Test provider sessions."
      },
      db
    );
    const { agent: secondAgent } = createSubAgentManually(
      {
        provider: "claude_code",
        name: "Second Session Agent",
        description: "Test parallel group provider sessions."
      },
      db
    );
    const { conversation } = createGroupConversation({ title: "Session Group" }, db);
    const directContext = getWorkspaceContextById(agent.defaultWorkspaceContextId!, db)!;
    const groupContext = getWorkspaceContextById(conversation.workspaceContextId!, db)!;

    const directSession = createProviderSession(
      {
        conversationId: conversation.id,
        workspaceId: conversation.workspaceId,
        agentId: agent.id,
        provider: "claude_code",
        providerSessionId: "direct-session",
        workspaceContextId: directContext.id,
        rootPath: directContext.rootPath,
        executionScope: "direct"
      },
      db
    );
    const groupSession = createProviderSession(
      {
        conversationId: conversation.id,
        workspaceId: conversation.workspaceId,
        agentId: agent.id,
        provider: "claude_code",
        providerSessionId: "group-session",
        workspaceContextId: groupContext.id,
        rootPath: groupContext.rootPath,
        executionScope: "group_subagent"
      },
      db
    );
    const secondGroupSession = createProviderSession(
      {
        conversationId: conversation.id,
        workspaceId: conversation.workspaceId,
        agentId: secondAgent.id,
        provider: "claude_code",
        providerSessionId: "second-group-session",
        workspaceContextId: groupContext.id,
        rootPath: groupContext.rootPath,
        executionScope: "group_subagent"
      },
      db
    );

    expect(
      getActiveProviderSession(
        conversation.id,
        {
          agentId: agent.id,
          provider: "claude_code",
          workspaceContextId: directContext.id,
          rootPath: directContext.rootPath,
          executionScope: "direct"
        },
        db
      )?.id
    ).toBe(directSession.id);
    expect(
      getActiveProviderSession(
        conversation.id,
        {
          agentId: agent.id,
          provider: "claude_code",
          workspaceContextId: groupContext.id,
          rootPath: groupContext.rootPath,
          executionScope: "group_subagent"
        },
        db
      )?.id
    ).toBe(groupSession.id);
    expect(
      getActiveProviderSession(
        conversation.id,
        {
          agentId: secondAgent.id,
          provider: "claude_code",
          workspaceContextId: groupContext.id,
          rootPath: groupContext.rootPath,
          executionScope: "group_subagent"
        },
        db
      )?.id
    ).toBe(secondGroupSession.id);
    expect(getProviderSessionsByConversation(conversation.id, db)).toHaveLength(3);
  });

  it("compacts older direct messages while retaining a contiguous recent layer", () => {
    const db = initializeTempDatabase();
    const { agent, conversation } = createSubAgentManually(
      {
        provider: "codex_local",
        name: "Memory Agent",
        description: "Test persisted memory."
      },
      db
    );

    for (let index = 0; index < 25; index += 1) {
      createMessage(
        {
          workspaceId: agent.workspaceId,
          conversationId: conversation.id,
          senderType: "user",
          senderId: "local-user",
          messageType: "text",
          content: { text: `memory-message-${index}` }
        },
        db
      );
    }

    const memory = buildDirectAgentMemoryContext(agent.id, conversation.id, undefined, db);
    const messages = getMessagesByConversation(conversation.id, db);
    const summary = getLatestConversationCompactSummary(conversation.id, db)!;
    const coveredEndIndex = messages.findIndex(
      (message) => message.id === summary.coveredMessageEndId
    );

    expect(coveredEndIndex).toBeGreaterThanOrEqual(0);
    expect(messages.slice(coveredEndIndex + 1)).toHaveLength(20);
    expect(summary.summary).toContain("memory-message-0");
    expect(memory).toContain("memory-message-24");
  });

  it("rewrites the sub-agent systemPrompt and invalidates provider sessions when its default workspace moves", () => {
    const db = initializeTempDatabase();
    const { agent, conversation } = createSubAgentManually(
      {
        provider: "claude_code",
        name: "Relocatable Agent",
        description: "Owns the relocatable workspace."
      },
      db
    );
    const initialContext = getWorkspaceContextById(agent.defaultWorkspaceContextId!, db)!;
    const initialPrompt = buildManualSubAgentSystemPrompt({
      name: agent.name,
      description: agent.description ?? "",
      workspaceRoot: initialContext.rootPath
    });
    expect(agent.systemPrompt).toBe(initialPrompt);

    const initialSession = createProviderSession(
      {
        conversationId: conversation.id,
        workspaceId: agent.workspaceId,
        agentId: agent.id,
        provider: "claude_code",
        providerSessionId: "stale-direct-session",
        workspaceContextId: initialContext.id,
        rootPath: initialContext.rootPath,
        executionScope: "direct"
      },
      db
    );

    const newRoot = fs.mkdtempSync(path.join(os.tmpdir(), "agenthub-relocate-"));
    const updated = updateAgentDefaultWorkspace(
      { agentId: agent.id, rootPath: newRoot, gitEnabled: false },
      db
    );
    expect(updated).not.toBeNull();
    const refreshed = getAgentById(agent.id, db)!;
    const refreshedContext = getWorkspaceContextById(refreshed.defaultWorkspaceContextId!, db)!;

    expect(refreshedContext.rootPath).toBe(newRoot);
    expect(refreshed.systemPrompt).toBe(
      buildManualSubAgentSystemPrompt({
        name: refreshed.name,
        description: refreshed.description ?? "",
        workspaceRoot: newRoot
      })
    );
    expect(refreshed.systemPrompt).toContain(newRoot);
    expect(refreshed.systemPrompt).not.toContain(initialContext.rootPath);

    expect(
      getActiveProviderSession(
        conversation.id,
        {
          agentId: agent.id,
          provider: "claude_code",
          workspaceContextId: refreshedContext.id,
          rootPath: refreshedContext.rootPath,
          executionScope: "direct"
        },
        db
      )
    ).toBeNull();
    expect(
      getProviderSessionsByConversation(conversation.id, db).find(
        (session) => session.id === initialSession.id
      )?.status
    ).toBe("replaced");
  });

  it("rewrites the main agent systemPrompt when a group's workspace moves", () => {
    const db = initializeTempDatabase();
    const { conversation } = createGroupConversation({ title: "Mobile Group" }, db);
    const mainAgentId = conversation.mainAgentId!;
    const mainAgent = getAgentById(mainAgentId, db)!;
    const initialContext = getWorkspaceContextById(conversation.workspaceContextId!, db)!;
    expect(mainAgent.systemPrompt).toBe(
      buildMainAgentSystemPrompt(initialContext.rootPath, mainAgent.runtimeProvider)
    );

    const newRoot = fs.mkdtempSync(path.join(os.tmpdir(), "agenthub-group-relocate-"));
    updateGroupWorkspace(
      { conversationId: conversation.id, rootPath: newRoot, gitEnabled: false },
      db
    );

    const refreshed = getAgentById(mainAgentId, db)!;
    expect(refreshed.systemPrompt).toBe(
      buildMainAgentSystemPrompt(newRoot, refreshed.runtimeProvider)
    );
    expect(refreshed.systemPrompt).toContain(newRoot);
    expect(refreshed.systemPrompt).not.toContain(initialContext.rootPath);
  });

  it("does not touch sessions for other agents when invalidating one agent's sessions", () => {
    const db = initializeTempDatabase();
    const { agent: target } = createSubAgentManually(
      { provider: "codex_local", name: "Target", description: "Target agent." },
      db
    );
    const { agent: bystander } = createSubAgentManually(
      { provider: "codex_local", name: "Bystander", description: "Untouched agent." },
      db
    );
    const { conversation } = createGroupConversation({ title: "Mixed Group" }, db);
    const targetSession = createProviderSession(
      {
        conversationId: conversation.id,
        workspaceId: target.workspaceId,
        agentId: target.id,
        provider: "codex_local",
        providerSessionId: "target-session",
        workspaceContextId: target.defaultWorkspaceContextId!,
        rootPath: getWorkspaceContextById(target.defaultWorkspaceContextId!, db)!.rootPath,
        executionScope: "group_subagent"
      },
      db
    );
    const bystanderSession = createProviderSession(
      {
        conversationId: conversation.id,
        workspaceId: bystander.workspaceId,
        agentId: bystander.id,
        provider: "codex_local",
        providerSessionId: "bystander-session",
        workspaceContextId: bystander.defaultWorkspaceContextId!,
        rootPath: getWorkspaceContextById(bystander.defaultWorkspaceContextId!, db)!.rootPath,
        executionScope: "group_subagent"
      },
      db
    );

    markActiveSessionsAsReplacedForAgent(target.id, "codex_local", db);

    const sessions = getProviderSessionsByConversation(conversation.id, db);
    expect(sessions.find((session) => session.id === targetSession.id)?.status).toBe("replaced");
    expect(sessions.find((session) => session.id === bystanderSession.id)?.status).toBe("active");
  });
});
