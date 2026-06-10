import type { Agent, Conversation } from "../../../shared/domain";
import { AgentStatusBadge } from "../agents/AgentStatusBadge";
import { RuntimeBadge } from "../agents/RuntimeBadge";

type AgentNodeProps = {
  agent: Agent;
  conversations: Conversation[];
  activeAgentId: string | null;
  onSelectAgent: (agentId: string, conversationId: string) => void;
};

export function AgentNode({
  agent,
  conversations,
  activeAgentId,
  onSelectAgent
}: AgentNodeProps) {
  const displayName = agent.type === "orchestrator"
    ? `${agent.name} (Orchestrator)`
    : agent.role === "main"
      ? "Main Agent"
      : agent.name;
  const isActive = agent.id === activeAgentId;

  function handleClick(): void {
    const conversation = conversations[0];
    if (conversation) {
      onSelectAgent(agent.id, conversation.id);
    }
  }

  return (
    <div className="agent-node">
      <button
        className={isActive ? "agent-item active" : "agent-item"}
        type="button"
        onClick={handleClick}
      >
        <AgentStatusBadge
          className="agent-item-name"
          label={displayName}
          status={agent.status}
        />
        <RuntimeBadge
          provider={agent.runtimeProvider}
          modelProviderId={agent.modelProviderId}
        />
      </button>
    </div>
  );
}
