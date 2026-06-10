import type { Conversation } from "../../../shared/domain";

type ConversationNodeProps = {
  agentId: string;
  conversation: Conversation;
  isActive: boolean;
  onSelectConversation: (agentId: string, conversationId: string) => void;
};

export function ConversationNode({
  agentId,
  conversation,
  isActive,
  onSelectConversation
}: ConversationNodeProps) {
  return (
    <button
      className={isActive ? "conversation-item active" : "conversation-item"}
      type="button"
      onClick={() => onSelectConversation(agentId, conversation.id)}
    >
      {conversation.title}
    </button>
  );
}
