import { randomUUID } from "node:crypto";
import type { Agent, Conversation } from "../../shared/domain";
import type {
  AddGroupMembersInput,
  AddGroupMembersResult,
  ConversationMember,
  CreateGroupConversationInput,
  CreateGroupConversationOutput,
  GroupMemberWithAgent,
  AddGroupMemberInput,
  RemoveGroupMemberInput,
  GroupAgentInfo,
  UpdateGroupProfileInput,
  UpdateGroupWorkspaceInput
} from "../../shared/groupChat";
import type { GroupProfileDto } from "../../shared/types";
import { getDatabase, type AgentHubDatabase } from "../db";
import {
  createConversation,
  deleteConversation,
  getConversationById,
  getGroupConversations,
  getGroupConversationsByWorkspace,
  updateConversation
} from "../db/repositories/conversationRepo";
import {
  createMember,
  getActiveMembers,
  getMember,
  updateMemberStatus
} from "../db/repositories/conversationMemberRepo";
import {
  getAgentById,
  getAgentContacts,
  getActiveMainAgent,
  updateAgent
} from "../db/repositories/agentRepo";
import { getWorkspaceById } from "../db/repositories/workspaceRepo";
import {
  createWorkspace as insertWorkspace,
  updateWorkspace
} from "../db/repositories/workspaceRepo";
import {
  createWorkspaceContext,
  getDefaultGroupWorkspaceRoot,
  getWorkspaceContextById,
  getWorkspaceContextByOwner,
  deleteWorkspaceContext,
  updateWorkspaceContext
} from "../db/repositories/workspaceContextRepo";
import { buildMainAgentSystemPrompt, createMainAgentForWorkspace } from "./agentService";
import { resolveExecutionWorkspaceForGroup } from "./workspaceContextResolver";
import { markActiveSessionsAsReplacedForAgent } from "../db/repositories/providerSessionRepo";
import { listByGroup as listExperiencesByGroup } from "../db/repositories/agentProjectExperienceRepo";
import { getDispatchRunsByConversation } from "../db/repositories/dispatchRunRepo";
import { RUNTIME_PROVIDER_LABELS } from "../../shared/runtime";
import { getEffectiveAgentCapabilities } from "./agentSkillCatalogService";

class GroupChatError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GroupChatError";
  }
}

function assertRecord(value: unknown, label: string): asserts value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new GroupChatError(`${label} is required.`);
  }
}

function assertNonEmptyString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new GroupChatError(`${label} is required.`);
  }

  return value.trim();
}

function normalizeDescription(value: unknown): string {
  if (value === undefined) {
    return "";
  }
  if (typeof value !== "string") {
    throw new GroupChatError("description must be a string.");
  }
  return value.trim();
}

function normalizeAgentIds(value: unknown): string[] {
  if (value === undefined) {
    return [];
  }
  if (!Array.isArray(value)) {
    throw new GroupChatError("agentIds must be an array.");
  }

  return [
    ...new Set(value.map((agentId) => assertNonEmptyString(agentId, "agentId")))
  ];
}

function isAddableGroupAgent(agent: Agent | null): agent is Agent {
  return (
    agent?.role === "sub" &&
    agent.type === "specialist" &&
    (agent.status === "available" || agent.status === "error")
  );
}

function validateCreateMemberAgentIds(
  memberAgentIds: string[],
  db: AgentHubDatabase
): void {
  memberAgentIds.forEach((agentId) => {
    const agent = getAgentById(agentId, db);
    if (!agent) {
      throw new GroupChatError(`Agent not found: ${agentId}`);
    }
    if (!isAddableGroupAgent(agent)) {
      throw new GroupChatError(`Agent cannot be added to a group: ${agentId}`);
    }
  });
}

export function createGroupConversation(
  input: CreateGroupConversationInput,
  db: AgentHubDatabase = getDatabase()
): CreateGroupConversationOutput {
  assertRecord(input, "Group conversation input");
  const workspaceId =
    input.workspaceId === undefined
      ? undefined
      : assertNonEmptyString(input.workspaceId, "workspaceId");
  const title = assertNonEmptyString(input.title, "title");
  const description = normalizeDescription(input.description);
  const memberAgentIds = normalizeAgentIds(input.memberAgentIds);
  const existingWorkspace = workspaceId ? getWorkspaceById(workspaceId, db) : null;
  if (workspaceId && !existingWorkspace) {
    throw new GroupChatError("Workspace not found.");
  }
  validateCreateMemberAgentIds(memberAgentIds, db);

  return db.transaction(() => {
    const conversationId = randomUUID();
    const defaultRootPath = existingWorkspace
      ? existingWorkspace.rootPath
      : getDefaultGroupWorkspaceRoot(conversationId, title);
    let workspace =
      existingWorkspace ??
      insertWorkspace(
        {
          name: `${title} Context`,
          rootPath: defaultRootPath,
          gitEnabled: false
        },
        db
      );
    let mainAgent = getActiveMainAgent(db);

    if (!mainAgent) {
      const created = createMainAgentForWorkspace(workspace, db);
      mainAgent = created.agent;
      workspace =
        updateWorkspace(workspace.id, { mainAgentId: mainAgent.id }, db) ?? workspace;
    }
    if (workspace.mainAgentId !== mainAgent.id) {
      workspace =
        updateWorkspace(workspace.id, { mainAgentId: mainAgent.id }, db) ?? workspace;
    }

    // WorkspaceContext is the group execution directory. It is shared by every
    // sub-agent dispatched inside this group conversation.
    const workspaceContext = createWorkspaceContext(
      {
        ownerType: "group",
        ownerId: conversationId,
        rootPath: defaultRootPath,
        gitEnabled: false
      },
      db
    );
    const conversation = createConversation(
      {
        id: conversationId,
        workspaceId: workspace.id,
        workspaceContextId: workspaceContext.id,
        agentId: mainAgent.id,
        title,
        mode: "single",
        type: "group",
        description,
        ownerUserId: "local-user",
        mainAgentId: mainAgent.id,
        autoDispatchEnabled: true
      },
      db
    );

    const ownerMember = createMember(
      {
        conversationId: conversation.id,
        memberType: "user",
        memberId: "local-user",
        role: "owner"
      },
      db
    );

    const mainAgentMember = createMember(
      {
        conversationId: conversation.id,
        memberType: "agent",
        memberId: mainAgent.id,
        role: "main_agent"
      },
      db
    );

    const selectedMembers = memberAgentIds.map((agentId) =>
      createMember(
        {
          conversationId: conversation.id,
          memberType: "agent",
          memberId: agentId,
          role: "member"
        },
        db
      )
    );

    return {
      conversation,
      members: [ownerMember, mainAgentMember, ...selectedMembers],
      memberAgentIds
    };
  })();
}

export function addAgentMember(
  input: AddGroupMemberInput,
  db: AgentHubDatabase = getDatabase()
): ConversationMember {
  assertRecord(input, "Group member input");
  const conversationId = assertNonEmptyString(input.conversationId, "conversationId");
  const agentId = assertNonEmptyString(input.agentId, "agentId");
  const result = addAgentMembers({ groupConversationId: conversationId, agentIds: [agentId] }, db);
  if (result.invalidAgentIds.length > 0) {
    throw new GroupChatError("Agent is not available for group membership.");
  }
  if (result.skippedAgentIds.length > 0) {
    throw new GroupChatError("Agent is already a member of this group.");
  }
  const member = getMember(conversationId, "agent", agentId, db);
  if (!member) {
    throw new GroupChatError("Failed to add group member.");
  }
  return member;
}

export function addAgentMembers(
  input: AddGroupMembersInput,
  db: AgentHubDatabase = getDatabase()
): AddGroupMembersResult {
  assertRecord(input, "Group members input");
  const groupConversationId = assertNonEmptyString(
    input.groupConversationId,
    "groupConversationId"
  );
  const agentIds = normalizeAgentIds(input.agentIds);
  const conversation = getConversationById(groupConversationId, db);

  if (!conversation) {
    throw new GroupChatError("Conversation not found.");
  }
  if (conversation.type !== "group") {
    throw new GroupChatError("Not a group conversation.");
  }

  return db.transaction(() => {
    const result: AddGroupMembersResult = {
      addedAgentIds: [],
      skippedAgentIds: [],
      invalidAgentIds: []
    };

    agentIds.forEach((agentId) => {
      const agent = getAgentById(agentId, db);
      if (!isAddableGroupAgent(agent)) {
        result.invalidAgentIds.push(agentId);
        return;
      }

      const existing = getMember(groupConversationId, "agent", agentId, db);
      if (existing?.status === "active") {
        result.skippedAgentIds.push(agentId);
        return;
      }

      if (existing) {
        updateMemberStatus(existing.id, "active", db);
      } else {
        createMember(
          {
            conversationId: groupConversationId,
            memberType: "agent",
            memberId: agentId,
            role: "member"
          },
          db
        );
      }
      result.addedAgentIds.push(agentId);
    });

    if (result.addedAgentIds.length > 0) {
      updateConversation(groupConversationId, {}, db);
    }

    return result;
  })();
}

export function removeAgentMember(
  input: RemoveGroupMemberInput,
  db: AgentHubDatabase = getDatabase()
): boolean {
  const conversation = getConversationById(input.conversationId, db);

  if (!conversation) {
    throw new GroupChatError("Conversation not found.");
  }

  if (conversation.type !== "group") {
    throw new GroupChatError("Not a group conversation.");
  }

  const members = getActiveMembers(input.conversationId, db);
  const member = members.find((m) => m.id === input.memberId);

  if (!member) {
    throw new GroupChatError("Member not found.");
  }

  if (member.role === "owner") {
    throw new GroupChatError("Cannot remove the group owner.");
  }

  if (member.role === "main_agent") {
    throw new GroupChatError("Cannot remove the main agent.");
  }

  return updateMemberStatus(input.memberId, "removed", db);
}

export function listGroupMembers(
  conversationId: string,
  db: AgentHubDatabase = getDatabase()
): GroupMemberWithAgent[] {
  const members = getActiveMembers(conversationId, db);

  return members.map((member) => {
    let agent = null;

    if (member.memberType === "agent") {
      agent = getAgentById(member.memberId, db);
    }

    return {
      ...member,
      agent
    };
  });
}

export function listGroupConversationsByWorkspace(
  workspaceId: string,
  db: AgentHubDatabase = getDatabase()
): Conversation[] {
  return getGroupConversationsByWorkspace(workspaceId, db);
}

export function listGroupConversations(db: AgentHubDatabase = getDatabase()): Conversation[] {
  return getGroupConversations(db);
}

export function getGroupConversation(
  conversationId: string,
  db: AgentHubDatabase = getDatabase()
): Conversation {
  const conversation = getConversationById(conversationId, db);

  if (!conversation) {
    throw new GroupChatError("Conversation not found.");
  }

  if (conversation.type !== "group") {
    throw new GroupChatError("Not a group conversation.");
  }

  return conversation;
}

export function deleteGroupConversation(
  conversationId: string,
  db: AgentHubDatabase = getDatabase()
): boolean {
  const normalizedConversationId = assertNonEmptyString(conversationId, "conversationId");
  const conversation = getConversationById(normalizedConversationId, db);

  if (!conversation || conversation.type !== "group" || conversation.status !== "active") {
    throw new GroupChatError("Group conversation not found.");
  }

  return db.transaction(() => {
    const contextById = new Map(
      [
        conversation.workspaceContextId
          ? getWorkspaceContextById(conversation.workspaceContextId, db)
          : null,
        getWorkspaceContextByOwner("group", conversation.id, db)
      ].flatMap((context) =>
        context?.ownerType === "group" && context.ownerId === conversation.id
          ? [[context.id, context] as const]
          : []
      )
    );

    const deleted = deleteConversation(conversation.id, db);

    for (const context of contextById.values()) {
      deleteWorkspaceContext(context.id, db);
    }

    return deleted;
  })();
}

export function getAvailableAgentsForGroup(
  conversationId: string,
  db: AgentHubDatabase = getDatabase()
): import("../../shared/domain").Agent[] {
  const conversation = getConversationById(conversationId, db);

  if (!conversation || conversation.type !== "group") {
    return [];
  }

  const allAgents = getAgentContacts(db);
  const activeMembers = getActiveMembers(conversationId, db);
  const memberAgentIds = new Set(
    activeMembers.filter((m) => m.memberType === "agent").map((m) => m.memberId)
  );

  return allAgents.filter(
    (agent) => isAddableGroupAgent(agent) && !memberAgentIds.has(agent.id)
  );
}

export function listGroupAgents(
  conversationId: string,
  db: AgentHubDatabase = getDatabase()
): GroupAgentInfo[] {
  const conversation = getConversationById(conversationId, db);

  if (!conversation || conversation.type !== "group") {
    return [];
  }

  const executionWorkspace = resolveExecutionWorkspaceForGroup(conversation.id, db);
  const members = getActiveMembers(conversationId, db);
  const agentMembers = members.filter((m) => m.memberType === "agent");

  const result: GroupAgentInfo[] = [];

  for (const member of agentMembers) {
    const agent = getAgentById(member.memberId, db);
    if (!isAddableGroupAgent(agent)) continue;

    result.push({
      agentId: agent.id,
      name: agent.name,
      role: agent.role as string,
      provider: agent.runtimeProvider,
      capabilities: getEffectiveAgentCapabilities(agent),
      tools: agent.tools as unknown as Record<string, boolean>,
      status: agent.status,
      workspaceId: agent.workspaceId,
      rootPath: executionWorkspace.rootPath
    });
  }

  return result;
}

export function updateGroupProfile(
  input: UpdateGroupProfileInput,
  db: AgentHubDatabase = getDatabase()
): Conversation {
  const conversation = getGroupConversation(input.conversationId, db);
  const updated = updateConversation(
    conversation.id,
    {
      ...(input.title === undefined ? {} : { title: input.title.trim() || conversation.title }),
      ...(input.description === undefined ? {} : { description: input.description.trim() }),
      ...(input.avatar === undefined ? {} : { avatar: input.avatar.trim() || null }),
      ...(input.autoDispatchEnabled === undefined
        ? {}
        : { autoDispatchEnabled: input.autoDispatchEnabled })
    },
    db
  );
  return updated ?? conversation;
}

export function updateGroupWorkspace(
  input: UpdateGroupWorkspaceInput,
  db: AgentHubDatabase = getDatabase()
): Conversation {
  const conversation = getGroupConversation(input.conversationId, db);
  const resolved = resolveExecutionWorkspaceForGroup(conversation.id, db);
  const context =
    updateWorkspaceContext(
      resolved.workspaceContextId,
      {
        rootPath: input.rootPath,
        gitEnabled: input.gitEnabled
      },
      db
    ) ?? getWorkspaceContextById(resolved.workspaceContextId, db);
  if (!context) {
    throw new GroupChatError("WorkspaceContext not found.");
  }
  const updated = updateConversation(
    conversation.id,
    { workspaceContextId: context.id },
    db
  ) ?? conversation;

  if (updated.mainAgentId) {
    const mainAgent = getAgentById(updated.mainAgentId, db);
    if (mainAgent && mainAgent.role === "main") {
      const rebuiltPrompt = buildMainAgentSystemPrompt(
        input.rootPath,
        mainAgent.runtimeProvider
      );
      if (mainAgent.systemPrompt !== rebuiltPrompt) {
        updateAgent(mainAgent.id, { systemPrompt: rebuiltPrompt }, db);
      }
      markActiveSessionsAsReplacedForAgent(
        mainAgent.id,
        mainAgent.runtimeProvider,
        db
      );
    }
  }

  return updated;
}

export function getGroupProfile(
  conversationId: string,
  db: AgentHubDatabase = getDatabase()
): GroupProfileDto {
  const conversation = getConversationById(conversationId, db);
  if (!conversation || conversation.type !== "group" || conversation.status === "archived") {
    throw new GroupChatError("Group conversation not found.");
  }

  const resolved = resolveExecutionWorkspaceForGroup(conversation.id, db);
  const workspaceContext: GroupProfileDto["workspaceContext"] = {
    id: resolved.workspaceContextId,
    rootPath: resolved.workspaceContext.rootPath,
    gitEnabled: resolved.workspaceContext.gitEnabled
  };

  const mainAgent = conversation.mainAgentId ? getAgentById(conversation.mainAgentId, db) : null;
  const allMembers = listGroupMembers(conversation.id, db);
  const members: GroupProfileDto["members"] = allMembers.map((member) => {
    if (member.memberType === "agent" && member.agent) {
      return {
        memberId: member.id,
        memberType: "agent" as const,
        memberRefId: member.memberId,
        name: member.agent.name,
        avatar: member.agent.avatar ?? null,
        role: member.role,
        joinedAt: member.joinedAt
      };
    }
    return {
      memberId: member.id,
      memberType: "user" as const,
      memberRefId: member.memberId,
      name: "群主",
      avatar: null,
      role: member.role,
      joinedAt: member.joinedAt
    };
  });

  const experiences = listExperiencesByGroup(conversation.id, db);
  const agentNameLookup = new Map<string, string>();
  for (const member of allMembers) {
    if (member.memberType === "agent" && member.agent) {
      agentNameLookup.set(member.agent.id, member.agent.name);
    }
  }
  for (const exp of experiences) {
    if (!agentNameLookup.has(exp.agentId)) {
      const agent = getAgentById(exp.agentId, db);
      if (agent) agentNameLookup.set(agent.id, agent.name);
    }
  }
  const projectExperiences: GroupProfileDto["projectExperiences"] = experiences.map((exp) => ({
    agentId: exp.agentId,
    agentName: agentNameLookup.get(exp.agentId) ?? exp.groupName ?? "Agent",
    summary: exp.summary,
    responsibilities: exp.responsibilities,
    keyDecisions: exp.keyDecisions,
    filesTouched: exp.filesTouched,
    diffSummaries: exp.diffSummaries,
    unresolvedIssues: exp.unresolvedIssues,
    updatedAt: exp.updatedAt
  }));

  const recentDispatches: GroupProfileDto["recentDispatches"] = getDispatchRunsByConversation(
    conversation.id,
    db
  )
    .slice(0, 5)
    .map((run) => ({
      runId: run.id,
      status: run.status,
      createdAt: run.createdAt,
      finishedAt: run.finishedAt
    }));

  return {
    conversation: {
      id: conversation.id,
      title: conversation.title,
      avatar: conversation.avatar,
      description: conversation.description ?? "",
      autoDispatchEnabled: conversation.autoDispatchEnabled,
      type: "group",
      createdAt: conversation.createdAt,
      updatedAt: conversation.updatedAt,
      lastMessageAt: conversation.lastMessageAt
    },
    workspaceContext,
    mainAgent: mainAgent
      ? {
          id: mainAgent.id,
          name: mainAgent.name,
          avatar: mainAgent.avatar ?? null,
          description: mainAgent.description ?? null,
          role: mainAgent.role,
          type: mainAgent.type,
          status: mainAgent.status,
          runtimeProvider:
            RUNTIME_PROVIDER_LABELS[mainAgent.runtimeProvider] ?? mainAgent.runtimeProvider,
          model: mainAgent.model ?? null
        }
      : null,
    members,
    memberCount: members.length,
    projectExperiences,
    recentDispatches
  };
}
