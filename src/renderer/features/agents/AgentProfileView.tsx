import { useCallback, useEffect, useState } from "react";
import type { AgentProfileDto } from "../../../shared/types";
import { RUNTIME_PROVIDER_LABELS } from "../../../shared/runtime";
import { AgentStatusBadge } from "./AgentStatusBadge";
import { useWorkspaceStore } from "../../state/workspaceStore";

const MAX_ARRAY_DISPLAY = 5;

type AgentProfileViewProps = {
  agentId: string;
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

export function AgentProfileView({ agentId }: AgentProfileViewProps) {
  const [profile, setProfile] = useState<AgentProfileDto | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const { selectChat, setNavigationSection } = useWorkspaceStore();

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);

    getApi()
      .agent.getAgentProfile(agentId)
      .then((data) => {
        if (!cancelled) {
          setProfile(data);
          setLoading(false);
        }
      })
      .catch((err) => {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : "Failed to load agent profile.");
          setLoading(false);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [agentId]);

  const handleSendMessage = useCallback(async () => {
    try {
      const conversation = await getApi().conversation.findOrCreateDirectConversationForAgent(agentId);
      setNavigationSection("chats");
      selectChat(conversation.id);
    } catch (err) {
      window.alert(err instanceof Error ? err.message : "Failed to open conversation.");
    }
  }, [agentId, selectChat, setNavigationSection]);

  const handleOpenSettings = useCallback(() => {
    window.dispatchEvent(
      new CustomEvent("agenthub:open-conversation-settings", {
        detail: { agentId }
      })
    );
  }, [agentId]);

  const handleGroupClick = useCallback(
    (conversationId: string) => {
      setNavigationSection("chats");
      selectChat(conversationId);
    },
    [selectChat, setNavigationSection]
  );

  if (loading) {
    return (
      <div className="agent-profile-view">
        <div className="profile-loading">Loading agent profile...</div>
      </div>
    );
  }

  if (error || !profile) {
    return (
      <div className="agent-profile-view">
        <div className="profile-error">{error ?? "Agent not found."}</div>
      </div>
    );
  }

  const { agent, defaultWorkspaceContext, tools, groups, projectExperiences, skills } = profile;
  const isOrchestrator = agent.role === "main" || agent.type === "orchestrator";
  const runtimeLabel =
    RUNTIME_PROVIDER_LABELS[agent.runtimeProvider as keyof typeof RUNTIME_PROVIDER_LABELS] ??
    agent.runtimeProvider ??
    "Unknown";

  return (
    <div className="agent-profile-view">
      {/* Identity Section */}
      <section className="profile-section profile-identity">
        <div className="profile-avatar">{agent.name.slice(0, 1)}</div>
        <div className="profile-identity-info">
          <h2 className="profile-name">{agent.name}</h2>
          <div className="profile-meta-row">
            <span className={`profile-role-badge ${isOrchestrator ? "orchestrator" : "specialist"}`}>
              {isOrchestrator ? "Orchestrator" : "Specialist"}
            </span>
            {agent.status && <AgentStatusBadge status={agent.status as any} />}
          </div>
          <p className="profile-description">
            {agent.description || (isOrchestrator
              ? "负责群聊任务拆解、分派、审查与总结。"
              : "暂无描述")}
          </p>
          <div className="profile-runtime-info">
            <span className="profile-runtime-label">Runtime:</span>
            <span className="profile-runtime-value">{runtimeLabel}</span>
            {agent.model && (
              <>
                <span className="profile-runtime-sep">|</span>
                <span className="profile-runtime-label">Model:</span>
                <span className="profile-runtime-value">{agent.model}</span>
              </>
            )}
          </div>
        </div>
      </section>

      {/* Quick Actions */}
      <section className="profile-section profile-actions">
        <button
          className="profile-action-btn primary"
          type="button"
          onClick={() => void handleSendMessage()}
        >
          发消息
        </button>
        {!isOrchestrator && (
          <button
            className="profile-action-btn"
            type="button"
            onClick={() => {
              // TODO: open group chat picker or reuse existing group member add flow
              window.alert("加入群聊功能开发中。请在群聊设置中添加此 Agent。");
            }}
          >
            加入群聊
          </button>
        )}
        <button
          className="profile-action-btn"
          type="button"
          onClick={handleOpenSettings}
        >
          {isOrchestrator ? "查看编排设置" : "查看设置"}
        </button>
      </section>

      {/* Skills Section */}
      <section className="profile-section">
        <h3 className="profile-section-title">技能</h3>
        {skills.length === 0 ? (
          <p className="profile-empty">暂未绑定技能</p>
        ) : (
          <div className="profile-skills-list">
            {skills.map((skill) => (
              <div className="profile-skill-item" key={skill.id}>
                <strong>{skill.name}</strong>
                <span>{skill.category}</span>
                {skill.description ? <p>{skill.description}</p> : null}
              </div>
            ))}
          </div>
        )}
      </section>

      {/* Tools Section */}
      <section className="profile-section">
        <h3 className="profile-section-title">能力权限</h3>
        <div className="profile-tools-grid">
          <div className={`profile-tool-item ${tools.readFile ? "enabled" : "disabled"}`}>
            <span className="profile-tool-icon">{tools.readFile ? "✓" : "✗"}</span>
            <span>readFile</span>
          </div>
          <div className={`profile-tool-item ${tools.writeDiff ? "enabled" : "disabled"}`}>
            <span className="profile-tool-icon">{tools.writeDiff ? "✓" : "✗"}</span>
            <span>writeDiff</span>
          </div>
          <div className="profile-tool-item disabled" title="applyDiff 由系统策略强制禁用，代码变更必须通过 Diff Proposal 并由用户确认后应用">
            <span className="profile-tool-icon">✗</span>
            <span>applyDiff</span>
            <span className="profile-tool-lock">系统禁用</span>
          </div>
          <div className={`profile-tool-item ${tools.previewArtifact ? "enabled" : "disabled"}`}>
            <span className="profile-tool-icon">{tools.previewArtifact ? "✓" : "✗"}</span>
            <span>previewArtifact</span>
          </div>
          <div className={`profile-tool-item ${tools.gitStatus ? "enabled" : "disabled"}`}>
            <span className="profile-tool-icon">{tools.gitStatus ? "✓" : "✗"}</span>
            <span>gitStatus</span>
          </div>
        </div>
      </section>

      {/* Default Workspace Context */}
      <section className="profile-section">
        <h3 className="profile-section-title">默认项目上下文</h3>
        {defaultWorkspaceContext ? (
          <div className="profile-context-card">
            <div className="profile-context-path">{defaultWorkspaceContext.rootPath}</div>
            <div className="profile-context-meta">
              <span>Git: {defaultWorkspaceContext.gitEnabled ? "启用" : "禁用"}</span>
            </div>
            <p className="profile-context-note">
              单聊执行时使用该默认项目上下文；群聊执行时使用群聊项目上下文。
            </p>
          </div>
        ) : (
          <p className="profile-empty">暂未绑定默认项目上下文</p>
        )}
      </section>

      {/* Groups Section */}
      <section className="profile-section">
        <h3 className="profile-section-title">所在群聊</h3>
        {groups.length === 0 ? (
          <p className="profile-empty">暂未加入任何群聊</p>
        ) : (
          <div className="profile-groups-list">
            {groups.map((group) => (
              <button
                className="profile-group-card"
                key={group.conversationId}
                type="button"
                onClick={() => handleGroupClick(group.conversationId)}
              >
                <div className="profile-group-header">
                  <span className="profile-group-avatar">{group.name.slice(0, 1)}</span>
                  <div className="profile-group-info">
                    <strong className="profile-group-name">{group.name}</strong>
                    <span className="profile-group-meta">
                      {group.memberCount} 成员
                      {group.lastMessageAt ? ` · ${formatTime(group.lastMessageAt)}` : ""}
                    </span>
                  </div>
                </div>
                {group.description && (
                  <p className="profile-group-desc">{group.description}</p>
                )}
                {group.workspaceContext && (
                  <div className="profile-group-context">
                    项目路径: {group.workspaceContext.rootPath}
                  </div>
                )}
              </button>
            ))}
          </div>
        )}
      </section>

      {/* Project Experiences Section */}
      <section className="profile-section">
        <h3 className="profile-section-title">项目经验</h3>
        {projectExperiences.length === 0 ? (
          <p className="profile-empty">暂无项目经验，参与群聊协作后会自动沉淀。</p>
        ) : (
          <div className="profile-experiences-list">
            {projectExperiences.map((exp) => (
              <div className="profile-experience-card" key={exp.groupConversationId}>
                <div className="profile-experience-header">
                  <strong className="profile-experience-group">{exp.groupName}</strong>
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
    </div>
  );
}
