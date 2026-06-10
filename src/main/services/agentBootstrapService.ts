import { randomUUID } from "node:crypto";
import type { Agent } from "../../shared/domain";
import { getDatabase, type AgentHubDatabase } from "../db";
import {
  createAgent,
  getActiveMainAgent,
  getNonDeletedMainAgents,
  updateAgent
} from "../db/repositories/agentRepo";
import { updateConversation } from "../db/repositories/conversationRepo";
import {
  createWorkspace,
  getWorkspaceById,
  updateWorkspace
} from "../db/repositories/workspaceRepo";
import {
  createWorkspaceContext,
  ensureWorkspaceContextForAgent,
  getDefaultAgentWorkspaceRoot
} from "../db/repositories/workspaceContextRepo";
import { moveDefaultAgentWorkspaceToTrash } from "./agentDeletionService";
import {
  buildMainAgentSystemPrompt,
  defaultMainAgent
} from "./agentService";
import {
  createDefaultConversationForAgent,
  ensureMainAgentGuideMessage
} from "./conversationService";

export const DEFAULT_MAIN_AGENT_NAME = "主 Agent";
export const DEFAULT_MAIN_AGENT_DESCRIPTION =
  "AgentHub 默认编排者，负责任务拆解、群聊调度、结果汇总和系统级答疑。";

export type RedundantMainAgentCleanupResult = {
  removedAgentIds: string[];
  deletedConversationIds: string[];
  trashedWorkspaceDirectories: string[];
  warnings: string[];
};

function ensureMainAgentResources(agent: Agent, db: AgentHubDatabase): Agent {
  const workspace = getWorkspaceById(agent.workspaceId, db);
  if (!workspace) {
    throw new Error("Main agent workspace not found.");
  }

  const workspaceContext = ensureWorkspaceContextForAgent(agent.id, agent.name, db);
  const linkedAgent =
    agent.defaultWorkspaceContextId === workspaceContext.id
      ? agent
      : updateAgent(agent.id, { defaultWorkspaceContextId: workspaceContext.id }, db) ?? agent;
  const defaultConversation = createDefaultConversationForAgent(linkedAgent, db);
  const conversation =
    workspace.rootPath !== workspaceContext.rootPath ||
    defaultConversation.workspaceContextId === workspaceContext.id
      ? defaultConversation
      : updateConversation(
          defaultConversation.id,
          { workspaceContextId: workspaceContext.id },
          db
        ) ?? defaultConversation;

  ensureMainAgentGuideMessage(workspace, linkedAgent, conversation, db);
  return linkedAgent;
}

export function cleanupRedundantMainAgents(
  mainAgent: Agent,
  db: AgentHubDatabase = getDatabase()
): RedundantMainAgentCleanupResult {
  const redundantAgents = getNonDeletedMainAgents(db).filter(
    (agent) => agent.id !== mainAgent.id
  );
  const workspaceContexts = redundantAgents.flatMap((agent) =>
    db
      .prepare<
        [string],
        { id: string; root_path: string }
      >(
        `SELECT id, root_path
         FROM workspace_contexts
         WHERE owner_type = 'agent' AND owner_id = ?`
      )
      .all(agent.id)
      .map((context) => ({
        agentId: agent.id,
        contextId: context.id,
        rootPath: context.root_path
      }))
  );
  const cleanupDatabase = db.transaction(() => {
    const deletedConversationIds: string[] = [];

    db.prepare(
      `UPDATE workspaces
       SET main_agent_id = @mainAgentId,
           updated_at = @updatedAt
       WHERE main_agent_id IS NULL OR main_agent_id <> @mainAgentId`
    ).run({
      mainAgentId: mainAgent.id,
      updatedAt: new Date().toISOString()
    });

    for (const redundantAgent of redundantAgents) {
      deletedConversationIds.push(
        ...db
          .prepare<[string], { id: string }>(
            "SELECT id FROM conversations WHERE agent_id = ? AND type = 'direct'"
          )
          .all(redundantAgent.id)
          .map((conversation) => conversation.id)
      );

      db.prepare(
        `UPDATE conversation_members
         SET role = 'main_agent'
         WHERE member_type = 'agent'
           AND member_id = @mainAgentId
           AND conversation_id IN (
             SELECT conversation_id
             FROM conversation_members
             WHERE member_type = 'agent' AND member_id = @redundantAgentId
           )`
      ).run({
        mainAgentId: mainAgent.id,
        redundantAgentId: redundantAgent.id
      });
      db.prepare(
        `DELETE FROM conversation_members
         WHERE member_type = 'agent'
           AND member_id = @redundantAgentId
           AND EXISTS (
             SELECT 1
             FROM conversation_members AS linked_main_agent
             WHERE linked_main_agent.conversation_id = conversation_members.conversation_id
               AND linked_main_agent.member_type = 'agent'
               AND linked_main_agent.member_id = @mainAgentId
           )`
      ).run({
        mainAgentId: mainAgent.id,
        redundantAgentId: redundantAgent.id
      });
      db.prepare(
        `UPDATE conversation_members
         SET member_id = @mainAgentId,
             role = 'main_agent'
         WHERE member_type = 'agent' AND member_id = @redundantAgentId`
      ).run({
        mainAgentId: mainAgent.id,
        redundantAgentId: redundantAgent.id
      });
      db.prepare(
        `UPDATE conversations
         SET agent_id = @mainAgentId,
             main_agent_id = @mainAgentId,
             updated_at = @updatedAt
         WHERE type = 'group'
           AND (agent_id = @redundantAgentId OR main_agent_id = @redundantAgentId)`
      ).run({
        mainAgentId: mainAgent.id,
        redundantAgentId: redundantAgent.id,
        updatedAt: new Date().toISOString()
      });
      db.prepare("DELETE FROM conversation_provider_sessions WHERE agent_id = ?").run(
        redundantAgent.id
      );
      db.prepare("DELETE FROM conversation_provider_sessions_v2 WHERE agent_id = ?").run(
        redundantAgent.id
      );
      db.prepare("DELETE FROM agent_runs WHERE agent_id = ?").run(redundantAgent.id);
      db.prepare("DELETE FROM agent_project_experiences WHERE agent_id = ?").run(
        redundantAgent.id
      );
      db.prepare(
        `UPDATE dispatch_steps
         SET status = 'cancelled',
             error_message = 'Agent deleted.',
             finished_at = COALESCE(finished_at, @finishedAt)
         WHERE agent_id = @agentId
           AND status IN ('queued', 'running', 'pending', 'streaming')`
      ).run({
        agentId: redundantAgent.id,
        finishedAt: new Date().toISOString()
      });
      db.prepare("DELETE FROM conversations WHERE agent_id = ? AND type = 'direct'").run(
        redundantAgent.id
      );
      db.prepare(
        "DELETE FROM workspace_contexts WHERE owner_type = 'agent' AND owner_id = ?"
      ).run(redundantAgent.id);

      const tombstone = updateAgent(
        redundantAgent.id,
        {
          defaultWorkspaceContextId: undefined,
          avatar: undefined,
          name: "已删除 Agent",
          description: "",
          role: "sub",
          type: "specialist",
          systemPrompt: "",
          capabilities: [],
          tools: {
            readFile: false,
            writeDiff: false,
            applyDiff: false,
            previewArtifact: false,
            gitStatus: false
          },
          fileScope: [],
          claudeCodeConfig: undefined,
          modelProviderId: undefined,
          model: undefined,
          status: "deleted"
        },
        db
      );
      if (!tombstone) {
        throw new Error("Unable to preserve the redundant main Agent tombstone.");
      }
    }

    return deletedConversationIds;
  });
  const deletedConversationIds = cleanupDatabase();
  const trashedWorkspaceDirectories: string[] = [];
  const warnings: string[] = [];

  for (const context of workspaceContexts) {
    const trashResult = moveDefaultAgentWorkspaceToTrash(context.agentId, context.rootPath);
    if (trashResult.trashedWorkspaceDirectory) {
      trashedWorkspaceDirectories.push(trashResult.trashedWorkspaceDirectory);
    }
    if (trashResult.warning) {
      warnings.push(trashResult.warning);
    }
  }

  return {
    removedAgentIds: redundantAgents.map((agent) => agent.id),
    deletedConversationIds,
    trashedWorkspaceDirectories,
    warnings
  };
}

export async function ensureDefaultMainAgent(
  db: AgentHubDatabase = getDatabase()
): Promise<Agent> {
  const ensureMainAgent = db.transaction(() => {
    const existingMainAgent = getActiveMainAgent(db);
    if (existingMainAgent) {
      return ensureMainAgentResources(existingMainAgent, db);
    }

    const agentId = randomUUID();
    const rootPath = getDefaultAgentWorkspaceRoot(agentId, "main-agent");
    const workspace = createWorkspace(
      {
        name: "主 Agent Context",
        rootPath,
        mainAgentId: agentId,
        gitEnabled: false
      },
      db
    );
    const workspaceContext = createWorkspaceContext(
      {
        ownerType: "agent",
        ownerId: agentId,
        rootPath,
        gitEnabled: false
      },
      db
    );
    const agent = createAgent(
      {
        id: agentId,
        workspaceId: workspace.id,
        defaultWorkspaceContextId: workspaceContext.id,
        name: DEFAULT_MAIN_AGENT_NAME,
        description: DEFAULT_MAIN_AGENT_DESCRIPTION,
        role: "main",
        type: "orchestrator",
        runtimeProvider: defaultMainAgent.runtimeProvider,
        systemPrompt: buildMainAgentSystemPrompt(workspace.rootPath, defaultMainAgent.runtimeProvider),
        capabilities: defaultMainAgent.capabilities,
        tools: defaultMainAgent.tools,
        fileScope: [workspaceContext.rootPath],
        status: "available"
      },
      db
    );
    const linkedWorkspace = updateWorkspace(workspace.id, { mainAgentId: agent.id }, db);
    if (!linkedWorkspace) {
      throw new Error("Unable to link the default main agent workspace.");
    }

    const conversation = createDefaultConversationForAgent(agent, db);
    ensureMainAgentGuideMessage(linkedWorkspace, agent, conversation, db);
    return agent;
  });

  const mainAgent = ensureMainAgent();
  const cleanupResult = cleanupRedundantMainAgents(mainAgent, db);
  cleanupResult.warnings.forEach((warning) => console.warn(warning));
  return mainAgent;
}
