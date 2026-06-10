import type { Workspace, WorkspaceContext } from "../../shared/domain";
import { getDatabase, type AgentHubDatabase } from "../db";
import { getAgentById, updateAgent } from "../db/repositories/agentRepo";
import {
  getConversationById,
  updateConversation
} from "../db/repositories/conversationRepo";
import {
  createWorkspaceContext,
  getWorkspaceContextById,
  getWorkspaceContextByOwner
} from "../db/repositories/workspaceContextRepo";
import { getWorkspaceById } from "../db/repositories/workspaceRepo";

export type ResolvedExecutionWorkspace = {
  workspace: Workspace;
  workspaceContext: WorkspaceContext;
  workspaceId: string;
  workspaceContextId: string;
  rootPath: string;
  gitEnabled: boolean;
};

function toResolved(
  workspace: Workspace,
  workspaceContext: WorkspaceContext
): ResolvedExecutionWorkspace {
  return {
    workspace,
    workspaceContext,
    workspaceId: workspace.id,
    workspaceContextId: workspaceContext.id,
    rootPath: workspaceContext.rootPath,
    gitEnabled: workspaceContext.gitEnabled
  };
}

function resolveLegacyWorkspace(
  workspaceId: string,
  db: AgentHubDatabase
): ResolvedExecutionWorkspace {
  const workspace = getWorkspaceById(workspaceId, db);
  if (!workspace) {
    throw new Error("Workspace not found.");
  }

  const workspaceContext =
    getWorkspaceContextByOwner("legacy_workspace", workspace.id, db) ??
    createWorkspaceContext(
      {
        ownerType: "legacy_workspace",
        ownerId: workspace.id,
        rootPath: workspace.rootPath,
        gitEnabled: workspace.gitEnabled
      },
      db
    );
  return toResolved(workspace, workspaceContext);
}

export function resolveExecutionWorkspaceForAgentDirect(
  agentId: string,
  conversationId?: string,
  db: AgentHubDatabase = getDatabase()
): ResolvedExecutionWorkspace {
  const agent = getAgentById(agentId, db);
  if (!agent) {
    throw new Error("Agent not found.");
  }

  if (agent.role === "main") {
    const workspace = getWorkspaceById(agent.workspaceId, db);
    if (!workspace) {
      throw new Error("Workspace not found.");
    }

    const workspaceContext = agent.defaultWorkspaceContextId
      ? getWorkspaceContextById(agent.defaultWorkspaceContextId, db)
      : null;

    if (workspaceContext) {
      if (conversationId) {
        const conversation = getConversationById(conversationId, db);
        if (conversation && conversation.workspaceContextId !== workspaceContext.id) {
          updateConversation(conversation.id, { workspaceContextId: workspaceContext.id }, db);
        }
      }

      return toResolved(workspace, workspaceContext);
    }

    return resolveLegacyWorkspace(agent.workspaceId, db);
  }

  const workspace = getWorkspaceById(agent.workspaceId, db);
  if (!workspace) {
    throw new Error("Workspace not found.");
  }

  const existingContext = agent.defaultWorkspaceContextId
    ? getWorkspaceContextById(agent.defaultWorkspaceContextId, db)
    : null;
  const workspaceContext =
    existingContext ?? getWorkspaceContextByOwner("agent", agent.id, db);
  if (!workspaceContext) {
    const legacy = resolveLegacyWorkspace(agent.workspaceId, db);
    if (conversationId) {
      updateConversation(conversationId, { workspaceContextId: legacy.workspaceContextId }, db);
    }
    return legacy;
  }

  if (agent.defaultWorkspaceContextId !== workspaceContext.id) {
    updateAgent(agent.id, { defaultWorkspaceContextId: workspaceContext.id }, db);
  }

  if (conversationId) {
    const conversation = getConversationById(conversationId, db);
    if (conversation && conversation.workspaceContextId !== workspaceContext.id) {
      updateConversation(conversation.id, { workspaceContextId: workspaceContext.id }, db);
    }
  }

  return toResolved(workspace, workspaceContext);
}

export function resolveExecutionWorkspaceForGroup(
  conversationId: string,
  db: AgentHubDatabase = getDatabase()
): ResolvedExecutionWorkspace {
  const conversation = getConversationById(conversationId, db);
  if (!conversation || conversation.type !== "group") {
    throw new Error("Group conversation not found.");
  }

  const workspace = getWorkspaceById(conversation.workspaceId, db);
  if (!workspace) {
    throw new Error("Workspace not found.");
  }

  const existingContext = conversation.workspaceContextId
    ? getWorkspaceContextById(conversation.workspaceContextId, db)
    : null;
  const workspaceContext =
    existingContext ?? getWorkspaceContextByOwner("group", conversation.id, db);
  if (!workspaceContext) {
    const legacy = resolveLegacyWorkspace(conversation.workspaceId, db);
    updateConversation(conversation.id, { workspaceContextId: legacy.workspaceContextId }, db);
    return legacy;
  }

  if (conversation.workspaceContextId !== workspaceContext.id) {
    updateConversation(conversation.id, { workspaceContextId: workspaceContext.id }, db);
  }

  return toResolved(workspace, workspaceContext);
}

export function resolveExecutionWorkspaceForConversation(
  conversationId: string,
  agentId?: string,
  db: AgentHubDatabase = getDatabase()
): ResolvedExecutionWorkspace {
  const conversation = getConversationById(conversationId, db);
  if (!conversation) {
    throw new Error("Conversation not found.");
  }

  if (conversation.type === "group") {
    return resolveExecutionWorkspaceForGroup(conversation.id, db);
  }

  return resolveExecutionWorkspaceForAgentDirect(
    agentId ?? conversation.agentId,
    conversation.id,
    db
  );
}

export function resolveExecutionWorkspace(
  input: {
    workspaceId: string;
    conversationId?: string;
    agentId?: string;
  },
  db: AgentHubDatabase = getDatabase()
): ResolvedExecutionWorkspace {
  if (input.conversationId) {
    return resolveExecutionWorkspaceForConversation(input.conversationId, input.agentId, db);
  }

  if (input.agentId) {
    return resolveExecutionWorkspaceForAgentDirect(input.agentId, undefined, db);
  }

  return resolveLegacyWorkspace(input.workspaceId, db);
}
