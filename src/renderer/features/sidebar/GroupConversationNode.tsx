import type { Conversation } from "../../../shared/domain";

type GroupConversationNodeProps = {
  conversation: Conversation;
  isActive: boolean;
  onSelect: (conversationId: string) => void;
};

export function GroupConversationNode({
  conversation,
  isActive,
  onSelect
}: GroupConversationNodeProps) {
  return (
    <button
      className={isActive ? "conversation-node active" : "conversation-node"}
      type="button"
      onClick={() => onSelect(conversation.id)}
    >
      <span className="conversation-node-icon">👥</span>
      <span className="conversation-node-title">{conversation.title}</span>
    </button>
  );
}
