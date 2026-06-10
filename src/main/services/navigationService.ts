import type { Agent, Conversation, Workspace } from "../../shared/domain";
import type { WorkspaceTreeDTO } from "../../shared/types";
import { getDatabase, type AgentHubDatabase } from "../db";
import {
  getAgentsByWorkspace,
  getActiveMainAgent
} from "../db/repositories/agentRepo";
import { getConversationsByAgent } from "../db/repositories/conversationRepo";
import { getWorkspaces, updateWorkspace } from "../db/repositories/workspaceRepo";
import { createDefaultConversationForAgent } from "./conversationService";

function compareIsoAscending(left: string, right: string): number {
  return left.localeCompare(right);
}

function sortAgentsForTree(agents: Agent[]): Agent[] {
  return [...agents].sort((left, right) => {
    if (left.role !== right.role) {
      return left.role === "main" ? -1 : 1;
    }

    return compareIsoAscending(left.createdAt, right.createdAt);
  });
}

function sortConversationsForTree(conversations: Conversation[]): Conversation[] {
  return [...conversations].sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
}

function ensureWorkspaceMainAgent(
  workspace: Workspace,
  db: AgentHubDatabase
): Workspace {
  const mainAgent = getActiveMainAgent(db);

  if (!mainAgent) {
    return workspace;
  }

  createDefaultConversationForAgent(mainAgent, db);
  if (workspace.mainAgentId === mainAgent.id) {
    return workspace;
  }

  const updatedWorkspace = updateWorkspace(
    workspace.id,
    {
      mainAgentId: mainAgent.id
    },
    db
  );

  return updatedWorkspace ?? workspace;
}

function ensureAgentConversations(agent: Agent, db: AgentHubDatabase): Conversation[] {
  const conversations = getConversationsByAgent(agent.id, db);

  if (conversations.length > 0) {
    return sortConversationsForTree(conversations);
  }

  return [createDefaultConversationForAgent(agent, db)];
}

export function getNavigationTree(db: AgentHubDatabase = getDatabase()): WorkspaceTreeDTO[] {
  const readTree = db.transaction(() => {
    return getWorkspaces(db).map((workspace) => {
      const workspaceWithMainAgent = ensureWorkspaceMainAgent(workspace, db);
      const agents = sortAgentsForTree(getAgentsByWorkspace(workspace.id, db));

      return {
        workspace: workspaceWithMainAgent,
        agents: agents.map((agent) => ({
          agent,
          conversations: ensureAgentConversations(agent, db)
        }))
      };
    });
  });

  return readTree();
}
