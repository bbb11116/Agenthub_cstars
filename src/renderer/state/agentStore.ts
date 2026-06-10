import type { Agent } from "../../shared/domain";
import { useWorkspaceStore, type WorkspaceStatus } from "./workspaceStore";

export type AgentStoreSnapshot = {
  agentsByWorkspace: Record<string, Agent[]>;
  activeWorkspaceAgents: Agent[];
  activeAgent: Agent | null;
  activeAgentId: string | null;
  status: WorkspaceStatus;
  error: string | null;
  loadWorkspaceAgents: (workspaceId: string) => Promise<void>;
  openMainAgentConversation: (workspaceId?: string) => Promise<void>;
};

export function useAgentStore(): AgentStoreSnapshot {
  const {
    activeAgent,
    activeAgentId,
    activeWorkspaceAgents,
    agentTreeError,
    agentTreeStatus,
    agentsByWorkspace,
    loadWorkspaceTree,
    openMainAgentConversation
  } = useWorkspaceStore();

  return {
    agentsByWorkspace,
    activeWorkspaceAgents,
    activeAgent,
    activeAgentId,
    status: agentTreeStatus,
    error: agentTreeError,
    loadWorkspaceAgents: loadWorkspaceTree,
    openMainAgentConversation
  };
}
