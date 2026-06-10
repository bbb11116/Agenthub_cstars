import { useState } from "react";
import type { Agent, Conversation, GroupMemberWithAgent } from "../../../shared/domain";
import { useWorkspaceStore } from "../../state/workspaceStore";

type GroupMemberPanelProps = {
  conversation: Conversation;
  members: GroupMemberWithAgent[];
  availableAgents: Agent[];
  onAddAgent: (agentId: string) => void;
  onRemoveMember: (memberId: string) => void;
};

type AgentRowProps = {
  member: GroupMemberWithAgent;
  onActivate: (agentId: string) => void;
};

function AgentRow({ member, onActivate }: AgentRowProps) {
  const agentId = member.agent?.id ?? member.memberId;
  return (
    <button
      type="button"
      className="group-member-item is-clickable"
      onClick={() => onActivate(agentId)}
      title="点击查看 / 打开"
    >
      <span className="group-member-name">{member.agent?.name ?? member.memberId}</span>
    </button>
  );
}

export function GroupMemberPanel({
  conversation,
  members,
  availableAgents,
  onAddAgent,
  onRemoveMember
}: GroupMemberPanelProps) {
  const { openAgentContact, openDirectChatForAgent } = useWorkspaceStore();
  const [showAddAgent, setShowAddAgent] = useState(false);

  const owner = members.find((m) => m.role === "owner");
  const mainAgent = members.find((m) => m.role === "main_agent");
  const subAgents = members.filter((m) => m.role === "member");

  return (
    <div className="group-member-panel">
      <div className="group-member-panel-header">
        <h3>{conversation.title}</h3>
        {conversation.description ? (
          <p className="group-description">{conversation.description}</p>
        ) : null}
      </div>

      <div className="group-member-section">
        <span className="group-member-label">群主</span>
        <div className="group-member-item">
          <span className="group-member-name">{owner?.memberId ?? "local-user"}</span>
        </div>
      </div>

      <div className="group-member-section">
        <span className="group-member-label">主 Agent</span>
        {mainAgent ? (
          <AgentRow member={mainAgent} onActivate={openAgentContact} />
        ) : (
          <div className="group-member-item">
            <span className="group-member-name">Main Agent</span>
          </div>
        )}
      </div>

      <div className="group-member-section">
        <span className="group-member-label">子 Agent ({subAgents.length})</span>
        {subAgents.map((member) => (
          <div key={member.id} className="group-member-row">
            <AgentRow
              member={member}
              onActivate={(agentId) => void openDirectChatForAgent(agentId)}
            />
            <button
              className="group-member-remove"
              type="button"
              onClick={() => onRemoveMember(member.id)}
              aria-label={`移除 ${member.agent?.name ?? member.memberId}`}
            >
              移除
            </button>
          </div>
        ))}

        {showAddAgent ? (
          <div className="group-add-agent-select">
            {availableAgents.length === 0 ? (
              <span className="group-add-agent-empty">没有可用的 Agent</span>
            ) : (
              availableAgents.map((agent) => (
                <button
                  key={agent.id}
                  className="group-add-agent-option"
                  type="button"
                  onClick={() => {
                    onAddAgent(agent.id);
                    setShowAddAgent(false);
                  }}
                >
                  {agent.name}
                </button>
              ))
            )}
            <button
              className="group-add-agent-cancel"
              type="button"
              onClick={() => setShowAddAgent(false)}
            >
              取消
            </button>
          </div>
        ) : (
          <button
            className="group-add-agent-btn"
            type="button"
            onClick={() => setShowAddAgent(true)}
          >
            + 添加 Agent
          </button>
        )}
      </div>
    </div>
  );
}
