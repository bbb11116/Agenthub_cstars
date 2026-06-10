import type { Conversation } from "../../shared/domain";
import { useWorkspaceStore, type WorkspaceStatus } from "./workspaceStore";

export type ConversationStoreSnapshot = {
  conversationsByAgent: Record<string, Conversation[]>;
  activeAgentConversations: Conversation[];
  activeConversation: Conversation | null;
  activeConversationId: string | null;
  status: WorkspaceStatus;
  error: string | null;
  selectConversation: (agentId: string, conversationId: string) => void;
};

export function useConversationStore(): ConversationStoreSnapshot {
  const {
    activeAgentConversations,
    activeConversation,
    activeConversationId,
    agentTreeError,
    agentTreeStatus,
    conversationsByAgent,
    selectConversation
  } = useWorkspaceStore();

  return {
    conversationsByAgent,
    activeAgentConversations,
    activeConversation,
    activeConversationId,
    status: agentTreeStatus,
    error: agentTreeError,
    selectConversation
  };
}
