import { useCallback, useEffect, useMemo, useState } from "react";
import type { GroupProfileDto } from "../../../shared/types";
import { useWorkspaceStore } from "../../state/workspaceStore";

const MAX_ARRAY_DISPLAY = 5;
const DISPATCH_STATUS_LABELS: Record<string, string> = {
  planning: "规划中",
  running_subagents: "执行子任务",
  reviewing: "编排者审查",
  redispatching: "重新分发",
  completed: "已完成",
  partial: "部分完成",
  failed: "失败",
  waiting_for_user: "等待用户",
  running: "执行中",
  cancelled: "已取消"
};

type GroupProfileViewProps = {
  conversationId: string;
};

function getApi() {
  if (!window.agenthub) {
    throw new Error("AgentHub API is unavailable.");
  }
  return window.agenthub;
}

function formatTime(value: string | null | undefined): string {
  if (!value) return "";
  return new Date(value).toLocaleString([], {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit"
  });
}

function dispatchStatusLabel(status: string): string {
  return DISPATCH_STATUS_LABELS[status] ?? status;
}

function ArraySection({ label, items }: { label: string; items: string[] }) {
  if (items.length === 0) return null;
  const shown = items.slice(0, MAX_ARRAY_DISPLAY);
  const remaining = items.length - shown.length;
  return (
    <div className="profile-array-section">
      <span className="profile-array-label">{label}</span>
      <ul className="profile-array-list">
        {shown.map((item, i) => (
          <li key={i}>{item}</li>
        ))}
      </ul>
      {remaining > 0 && (
        <span className="profile-array-more">还有 {remaining} 条</span>
      )}
    </div>
  );
}

function memberRoleLabel(role: string): string {
  if (role === "owner") return "群主";
  if (role === "main_agent") return "主 Agent";
  return "子 Agent";
}

function memberRoleClass(role: string): string {
  if (role === "owner") return "group-owner";
  if (role === "main_agent") return "group-main";
  return "group-sub";
}

export function GroupProfileView({ conversationId }: GroupProfileViewProps) {
  const [profile, setProfile] = useState<GroupProfileDto | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const { selectChat, setNavigationSection, openAgentContact, openDirectChatForAgent } = useWorkspaceStore();

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);

    getApi()
      .groupConversation.getGroupProfile(conversationId)
      .then((data) => {
        if (!cancelled) {
          setProfile(data);
          setLoading(false);
        }
      })
      .catch((err) => {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : "Failed to load group profile.");
          setLoading(false);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [conversationId]);

  const handleOpenChat = useCallback(() => {
    setNavigationSection("chats");
    selectChat(conversationId);
  }, [conversationId, selectChat, setNavigationSection]);

  const handleOpenSettings = useCallback(() => {
    window.dispatchEvent(
      new CustomEvent("agenthub:open-conversation-settings", {
        detail: { conversationId }
      })
    );
  }, [conversationId]);

  const { ownerMembers, mainAgentMembers, subAgentMembers } = useMemo(() => {
    const owners = profile?.members.filter((m) => m.role === "owner") ?? [];
    const mainAgents = profile?.members.filter((m) => m.role === "main_agent") ?? [];
    const subs = profile?.members.filter((m) => m.role === "member") ?? [];
    return { ownerMembers: owners, mainAgentMembers: mainAgents, subAgentMembers: subs };
  }, [profile]);

  const handleActivateSubAgent = useCallback(
    (agentId: string) => {
      void openDirectChatForAgent(agentId);
    },
    [openDirectChatForAgent]
  );

  const handleActivateMainAgent = useCallback(
    (agentId: string) => {
      openAgentContact(agentId);
    },
    [openAgentContact]
  );

  if (loading) {
    return (
      <div className="group-profile-view">
        <div className="profile-loading">Loading group profile...</div>
      </div>
    );
  }

  if (error || !profile) {
    return (
      <div className="group-profile-view">
        <div className="profile-error">{error ?? "群聊未找到。"}</div>
      </div>
    );
  }

  const { conversation, workspaceContext, mainAgent, projectExperiences, recentDispatches } = profile;

  return (
    <div className="group-profile-view">
      {/* Identity Section */}
      <section className="profile-section profile-identity">
        <div className="profile-avatar">{conversation.title.slice(0, 1)}</div>
        <div className="profile-identity-info">
          <h2 className="profile-name">{conversation.title}</h2>
          <div className="profile-meta-row">
            <span className="profile-role-badge group-badge">Group</span>
            <span className="profile-role-badge group-dispatch">
              {conversation.autoDispatchEnabled ? "自动分发" : "手动分发"}
            </span>
            {conversation.lastMessageAt && (
              <span className="profile-runtime-info">
                最近活跃：{formatTime(conversation.lastMessageAt)}
              </span>
            )}
          </div>
          <p className="profile-description">
            {conversation.description || "暂无描述"}
          </p>
          {mainAgent && (
            <div className="profile-runtime-info">
              <span className="profile-runtime-label">主 Agent：</span>
              <span className="profile-runtime-value">{mainAgent.name}</span>
              {mainAgent.runtimeProvider && (
                <>
                  <span className="profile-runtime-sep">·</span>
                  <span className="profile-runtime-value">{mainAgent.runtimeProvider}</span>
                </>
              )}
              {mainAgent.model && (
                <>
                  <span className="profile-runtime-sep">·</span>
                  <span className="profile-runtime-value">{mainAgent.model}</span>
                </>
              )}
            </div>
          )}
        </div>
      </section>

      {/* Quick Actions */}
      <section className="profile-section profile-actions">
        <button
          className="profile-action-btn primary"
          type="button"
          onClick={handleOpenChat}
        >
          进入群聊
        </button>
        <button
          className="profile-action-btn"
          type="button"
          onClick={handleOpenSettings}
        >
          群聊设置
        </button>
      </section>

      {/* Workspace Context */}
      <section className="profile-section">
        <h3 className="profile-section-title">项目上下文</h3>
        {workspaceContext ? (
          <div className="profile-context-card">
            <div className="profile-context-path">{workspaceContext.rootPath}</div>
            <div className="profile-context-meta">
              <span>Git: {workspaceContext.gitEnabled ? "启用" : "禁用"}</span>
              <span> · 共 {profile.memberCount} 位成员</span>
            </div>
            <p className="profile-context-note">
              群聊内所有 Agent 在该项目上下文中协作；用户单聊仍使用各自 Agent 的默认项目上下文。
            </p>
          </div>
        ) : (
          <p className="profile-empty">暂未绑定项目上下文</p>
        )}
      </section>

      {/* Members Section */}
      <section className="profile-section">
        <h3 className="profile-section-title">群成员</h3>
        {ownerMembers.length === 0 && mainAgentMembers.length === 0 && subAgentMembers.length === 0 ? (
          <p className="profile-empty">暂无成员</p>
        ) : (
          <div className="profile-members-list">
            {ownerMembers.length > 0 && (
              <div className="profile-member-group">
                <span className="profile-member-group-title">群主</span>
                {ownerMembers.map((m) => (
                  <MemberCard key={m.memberId} member={m} />
                ))}
              </div>
            )}
            {mainAgentMembers.length > 0 && (
              <div className="profile-member-group">
                <span className="profile-member-group-title">主 Agent</span>
                {mainAgentMembers.map((m) => (
                  <MemberCard
                    key={m.memberId}
                    member={m}
                    onActivate={handleActivateMainAgent}
                  />
                ))}
              </div>
            )}
            {subAgentMembers.length > 0 && (
              <div className="profile-member-group">
                <span className="profile-member-group-title">子 Agent（{subAgentMembers.length}）</span>
                {subAgentMembers.map((m) => (
                  <MemberCard
                    key={m.memberId}
                    member={m}
                    onActivate={handleActivateSubAgent}
                  />
                ))}
              </div>
            )}
          </div>
        )}
      </section>

      {/* Project Experience Section */}
      <section className="profile-section">
        <h3 className="profile-section-title">完成的项目总结</h3>
        {projectExperiences.length === 0 ? (
          <p className="profile-empty">暂无项目经验，群聊协作完成后会自动沉淀。</p>
        ) : (
          <div className="profile-experiences-list">
            {projectExperiences.map((exp) => (
              <div className="profile-experience-card" key={exp.agentId}>
                <div className="profile-experience-header">
                  <strong className="profile-experience-group">{exp.agentName}</strong>
                  {exp.updatedAt && (
                    <time className="profile-experience-time">{formatTime(exp.updatedAt)}</time>
                  )}
                </div>
                {exp.summary && <p className="profile-experience-summary">{exp.summary}</p>}
                <ArraySection label="职责" items={exp.responsibilities} />
                <ArraySection label="关键决策" items={exp.keyDecisions} />
                <ArraySection label="涉及文件" items={exp.filesTouched} />
                <ArraySection label="Diff 摘要" items={exp.diffSummaries} />
                <ArraySection label="未解决问题" items={exp.unresolvedIssues} />
              </div>
            ))}
          </div>
        )}
      </section>

      {/* Recent Dispatches Section */}
      {recentDispatches.length > 0 && (
        <section className="profile-section">
          <h3 className="profile-section-title">最近任务分发</h3>
          <div className="profile-dispatch-list">
            {recentDispatches.map((run) => (
              <div className="profile-dispatch-row" key={run.runId}>
                <span className="profile-dispatch-status">{dispatchStatusLabel(run.status)}</span>
                <span className="profile-dispatch-time">
                  {formatTime(run.createdAt)}
                  {run.finishedAt ? ` → ${formatTime(run.finishedAt)}` : ""}
                </span>
              </div>
            ))}
          </div>
        </section>
      )}
    </div>
  );
}

function MemberCard({
  member,
  onActivate
}: {
  member: GroupProfileDto["members"][number];
  onActivate?: (agentId: string) => void;
}) {
  const isAgent = member.memberType === "agent" && Boolean(onActivate);
  const handleClick = isAgent ? () => onActivate?.(member.memberRefId) : undefined;
  const cardClass = isAgent
    ? "profile-member-card is-clickable"
    : "profile-member-card";
  return (
    <div className={cardClass}>
      {isAgent ? (
        <button
          type="button"
          className="profile-member-card-button"
          onClick={handleClick}
          title="点击切换到该 Agent 的对话"
        >
          <MemberCardBody member={member} />
        </button>
      ) : (
        <MemberCardBody member={member} />
      )}
    </div>
  );
}

function MemberCardBody({
  member
}: {
  member: GroupProfileDto["members"][number];
}) {
  return (
    <>
      <div className="profile-member-avatar">
        {member.avatar ? member.avatar : member.name.slice(0, 1)}
      </div>
      <div className="profile-member-info">
        <div className="profile-member-header">
          <strong className="profile-member-name">{member.name}</strong>
          <span className={`profile-role-badge ${memberRoleClass(member.role)}`}>
            {memberRoleLabel(member.role)}
          </span>
        </div>
        <span className="profile-member-joined">加入：{formatTime(member.joinedAt)}</span>
      </div>
    </>
  );
}
