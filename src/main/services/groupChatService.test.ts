import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { closeDatabase, initializeDatabase, type AgentHubDatabase } from "../db";
import { listByGroup, upsertExperience } from "../db/repositories/agentProjectExperienceRepo";
import { createAgent } from "../db/repositories/agentRepo";
import { getMember } from "../db/repositories/conversationMemberRepo";
import { getConversationById } from "../db/repositories/conversationRepo";
import { getMessagesByConversation } from "../db/repositories/messageRepo";
import { getWorkspaceContextById } from "../db/repositories/workspaceContextRepo";
import { createWorkspace, updateWorkspace } from "../db/repositories/workspaceRepo";
import {
  addAgentMembers,
  createGroupConversation,
  deleteGroupConversation,
  listGroupAgents
} from "./groupChatService";
import { createMessage } from "./messageService";

let tempDir: string | null = null;

function initializeTempDatabase(): AgentHubDatabase {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "agenthub-group-chat-"));
  return initializeDatabase({ dbPath: path.join(tempDir, "agenthub.db") });
}

function createTestWorkspace(db: AgentHubDatabase) {
  const workspace = createWorkspace(
    {
      name: "Group Test",
      rootPath: path.join(tempDir!, "workspace"),
      gitEnabled: false
    },
    db
  );
  const mainAgent = createAgent(
    {
      workspaceId: workspace.id,
      name: "Main Agent",
      role: "main",
      type: "orchestrator",
      runtimeProvider: "mock",
      status: "available"
    },
    db
  );
  updateWorkspace(workspace.id, { mainAgentId: mainAgent.id }, db);
  return { workspace, mainAgent };
}

function createSpecialist(
  db: AgentHubDatabase,
  workspaceId: string,
  name: string,
  status: "available" | "error" | "unavailable" | "disabled" | "deleted" = "available"
) {
  return createAgent(
    {
      workspaceId,
      name,
      role: "sub",
      type: "specialist",
      runtimeProvider: "mock",
      status
    },
    db
  );
}

afterEach(() => {
  closeDatabase();
  if (tempDir) {
    fs.rmSync(tempDir, { recursive: true, force: true });
    tempDir = null;
  }
});

describe("groupChatService membership", () => {
  it("creates a group with trimmed profile fields and deduplicated optional members", () => {
    const db = initializeTempDatabase();
    const { workspace } = createTestWorkspace(db);
    const specialist = createSpecialist(db, workspace.id, "API Agent");

    expect(() =>
      createGroupConversation({ workspaceId: workspace.id, title: "  " }, db)
    ).toThrow("title is required.");

    const result = createGroupConversation(
      {
        workspaceId: workspace.id,
        title: "  Release Room  ",
        description: "   ",
        memberAgentIds: [specialist.id, specialist.id]
      },
      db
    );

    expect(result.conversation).toMatchObject({
      title: "Release Room",
      description: ""
    });
    expect(result.memberAgentIds).toEqual([specialist.id]);
    expect(result.members.map((member) => member.role)).toEqual([
      "owner",
      "main_agent",
      "member"
    ]);
    expect(getWorkspaceContextById(result.conversation.workspaceContextId!, db)).toMatchObject({
      ownerType: "group",
      ownerId: result.conversation.id
    });
    expect(listGroupAgents(result.conversation.id, db).map((agent) => agent.agentId)).toEqual([
      specialist.id
    ]);
  });

  it("rejects invalid initial members before creating the group", () => {
    const db = initializeTempDatabase();
    const { workspace, mainAgent } = createTestWorkspace(db);
    const deleted = createSpecialist(db, workspace.id, "Deleted Agent", "deleted");

    expect(() =>
      createGroupConversation(
        { workspaceId: workspace.id, title: "Invalid Main", memberAgentIds: [mainAgent.id] },
        db
      )
    ).toThrow(`Agent cannot be added to a group: ${mainAgent.id}`);
    expect(() =>
      createGroupConversation(
        { workspaceId: workspace.id, title: "Invalid Deleted", memberAgentIds: [deleted.id] },
        db
      )
    ).toThrow(`Agent cannot be added to a group: ${deleted.id}`);
    expect(() =>
      createGroupConversation(
        { workspaceId: workspace.id, title: "Missing", memberAgentIds: ["missing-agent"] },
        db
      )
    ).toThrow("Agent not found: missing-agent");
  });

  it("adds members in one transaction without duplicate member rows", () => {
    const db = initializeTempDatabase();
    const { workspace } = createTestWorkspace(db);
    const first = createSpecialist(db, workspace.id, "First Agent");
    const disabled = createSpecialist(db, workspace.id, "Disabled Agent", "disabled");
    const { conversation } = createGroupConversation(
      { workspaceId: workspace.id, title: "Batch Room" },
      db
    );

    expect(
      addAgentMembers(
        {
          groupConversationId: conversation.id,
          agentIds: [first.id, first.id, disabled.id, "missing-agent"]
        },
        db
      )
    ).toEqual({
      addedAgentIds: [first.id],
      skippedAgentIds: [],
      invalidAgentIds: [disabled.id, "missing-agent"]
    });
    expect(
      addAgentMembers({ groupConversationId: conversation.id, agentIds: [first.id] }, db)
    ).toEqual({
      addedAgentIds: [],
      skippedAgentIds: [first.id],
      invalidAgentIds: []
    });
    expect(
      addAgentMembers({ groupConversationId: conversation.id, agentIds: [] }, db)
    ).toEqual({
      addedAgentIds: [],
      skippedAgentIds: [],
      invalidAgentIds: []
    });
    expect(getMember(conversation.id, "agent", first.id, db)?.status).toBe("active");
    expect(
      db.prepare(
        "SELECT COUNT(*) AS count FROM conversation_members WHERE conversation_id = ? AND member_id = ?"
      ).get(conversation.id, first.id)
    ).toEqual({ count: 1 });
  });

  it("allows adding a specialist whose status is 'error'", () => {
    const db = initializeTempDatabase();
    const { workspace } = createTestWorkspace(db);
    const errored = createSpecialist(db, workspace.id, "Errored Agent", "error");
    const unavailable = createSpecialist(db, workspace.id, "Unavailable Agent", "unavailable");
    const { conversation } = createGroupConversation(
      { workspaceId: workspace.id, title: "Recoverable" },
      db
    );

    expect(
      addAgentMembers(
        {
          groupConversationId: conversation.id,
          agentIds: [errored.id, unavailable.id]
        },
        db
      )
    ).toEqual({
      addedAgentIds: [errored.id],
      skippedAgentIds: [],
      invalidAgentIds: [unavailable.id]
    });
    expect(getMember(conversation.id, "agent", errored.id, db)?.status).toBe("active");
  });

  it("dissolves a group and removes agent group records", () => {
    const db = initializeTempDatabase();
    const { workspace } = createTestWorkspace(db);
    const specialist = createSpecialist(db, workspace.id, "Release Agent");
    const { conversation } = createGroupConversation(
      {
        workspaceId: workspace.id,
        title: "Dissolve Room",
        memberAgentIds: [specialist.id]
      },
      db
    );
    const workspaceContextId = conversation.workspaceContextId!;

    createMessage(
      {
        workspaceId: conversation.workspaceId,
        conversationId: conversation.id,
        senderType: "user",
        senderId: "local-user",
        messageType: "text",
        content: { text: "Ship it" }
      },
      db
    );
    upsertExperience(
      specialist.id,
      conversation.id,
      {
        groupName: conversation.title,
        summary: "Worked on the dissolved group."
      },
      db
    );

    expect(getMember(conversation.id, "agent", specialist.id, db)?.status).toBe("active");
    expect(getMessagesByConversation(conversation.id, db)).toHaveLength(1);
    expect(listByGroup(conversation.id, db)).toHaveLength(1);

    expect(deleteGroupConversation(conversation.id, db)).toBe(true);

    expect(getConversationById(conversation.id, db)).toBeNull();
    expect(getWorkspaceContextById(workspaceContextId, db)).toBeNull();
    expect(getMember(conversation.id, "agent", specialist.id, db)).toBeNull();
    expect(getMessagesByConversation(conversation.id, db)).toEqual([]);
    expect(listByGroup(conversation.id, db)).toEqual([]);
  });
});
