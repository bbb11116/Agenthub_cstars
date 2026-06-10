import type { GroupMemberWithAgent } from "../../../shared/domain";
import { useWorkspaceStore } from "../../state/workspaceStore";

type GroupMemberStripProps = {
  members: GroupMemberWithAgent[];
};

function ChipLabel({ isMain, isOwner }: { isMain: boolean; isOwner: boolean }) {
  if (isOwner) {
    return <span className="group-member-strip-label">群主</span>;
  }
  if (isMain) {
    return <span className="group-member-strip-label">主</span>;
  }
  return null;
}

function AgentChip({
  member,
  isMain,
  onActivate
}: {
  member: GroupMemberWithAgent;
  isMain: boolean;
  onActivate: (agentId: string) => void;
}) {
  const agentId = member.agent?.id ?? member.memberId;
  const name = member.agent?.name ?? "Agent";
  return (
    <button
      type="button"
      className={`group-member-strip-chip is-clickable ${isMain ? "is-main" : ""}`}
      onClick={() => onActivate(agentId)}
      title={isMain ? "查看主 Agent 详情" : "打开子 Agent 对话"}
    >
      <ChipLabel isMain={isMain} isOwner={false} />
      <span className="group-member-strip-name">{name}</span>
    </button>
  );
}

export function GroupMemberStrip({ members }: GroupMemberStripProps) {
  const { openAgentContact, openDirectChatForAgent } = useWorkspaceStore();
  const owner = members.find((m) => m.role === "owner");
  const mainAgent = members.find((m) => m.role === "main_agent");
  const subAgents = members.filter((m) => m.role === "member" && m.status === "active");

  return (
    <div className="group-member-strip" aria-label="群聊成员">
      <div className="group-member-strip-chip is-owner">
        <ChipLabel isMain={false} isOwner />
        <span className="group-member-strip-name">{owner?.memberId ?? "local-user"}</span>
      </div>

      {mainAgent ? (
        <AgentChip member={mainAgent} isMain onActivate={openAgentContact} />
      ) : null}

      {subAgents.map((member) => (
        <AgentChip
          key={member.id}
          member={member}
          isMain={false}
          onActivate={(agentId) => void openDirectChatForAgent(agentId)}
        />
      ))}
    </div>
  );
}
