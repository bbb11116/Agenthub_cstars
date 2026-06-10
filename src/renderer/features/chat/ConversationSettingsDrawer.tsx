import { useEffect, useMemo, useState } from "react";
import type { AgentHubApi, AgentSkillCategory } from "../../../shared/types";
import { useWorkspaceStore } from "../../state/workspaceStore";
import { AgentPickerDialog } from "../agents/AgentPickerDialog";
import { SkillMultiSelect } from "../agents/SkillMultiSelect";
import { AgentAvatar } from "./AgentAvatar";

function getApi(): AgentHubApi {
  if (!window.agenthub) {
    throw new Error("AgentHub API is unavailable.");
  }
  return window.agenthub;
}

export function ConversationSettingsDrawer({
  open,
  onClose,
  agentId
}: {
  open: boolean;
  onClose: () => void;
  agentId?: string;
}) {
  const {
    activeAgent,
    activeConversation,
    activeWorkspaceContext,
    addGroupMembers,
    contacts,
    loadGroupMembers,
    loadHubCollections,
    membersByGroupConversation,
    refreshActiveWorkspaceContext,
    removeGroupMember
  } = useWorkspaceStore();
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [rootPath, setRootPath] = useState("");
  const [skillIds, setSkillIds] = useState<string[]>([]);
  const [skillCatalog, setSkillCatalog] = useState<AgentSkillCategory[]>([]);
  const [skillsLoading, setSkillsLoading] = useState(false);
  const [skillsError, setSkillsError] = useState<string | null>(null);
  const [autoDispatchEnabled, setAutoDispatchEnabled] = useState(true);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [memberNotice, setMemberNotice] = useState<string | null>(null);
  const [pickingFolder, setPickingFolder] = useState(false);

  const isGroup = activeConversation?.type === "group";
  const drawerAgent = agentId
    ? contacts.find((a) => a.id === agentId) ?? activeAgent
    : activeAgent;
  const members = activeConversation
    ? membersByGroupConversation[activeConversation.id] ?? []
    : [];
  const memberAgentIds = useMemo(
    () =>
      members
        .filter((member) => member.memberType === "agent")
        .map((member) => member.memberId),
    [members]
  );
  const ownerMember = useMemo(
    () => members.find((member) => member.role === "owner") ?? null,
    [members]
  );
  const mainAgentMember = useMemo(
    () => members.find((member) => member.role === "main_agent") ?? null,
    [members]
  );
  const subAgentMembers = useMemo(
    () => members.filter((member) => member.role === "member"),
    [members]
  );

  useEffect(() => {
    if (!open) {
      return;
    }
    if (activeConversation) {
      setName(isGroup ? activeConversation.title : activeAgent?.name ?? activeConversation.title);
      setDescription(isGroup ? activeConversation.description : activeAgent?.description ?? "");
      setRootPath(activeWorkspaceContext?.rootPath ?? "");
      setSkillIds(isGroup ? [] : activeAgent?.skillIds ?? []);
      setAutoDispatchEnabled(activeConversation.autoDispatchEnabled);
      if (isGroup) {
        void loadGroupMembers(activeConversation.id);
      }
    } else if (drawerAgent) {
      setName(drawerAgent.name);
      setDescription(drawerAgent.description ?? "");
      setRootPath("");
      setSkillIds(drawerAgent.skillIds ?? []);
      setAutoDispatchEnabled(true);
    }
    setPickerOpen(false);
    setError(null);
    setMemberNotice(null);
    setSkillsError(null);
  }, [
    activeAgent?.description,
    activeAgent?.name,
    activeConversation?.id,
    activeWorkspaceContext?.rootPath,
    drawerAgent,
    isGroup,
    loadGroupMembers,
    open
  ]);

  useEffect(() => {
    if (!open || isGroup || !drawerAgent) {
      return;
    }

    let cancelled = false;
    setSkillsLoading(true);
    getApi()
      .skill.listCatalog()
      .then((catalog) => {
        if (!cancelled) {
          setSkillCatalog(catalog);
          setSkillsLoading(false);
        }
      })
      .catch((loadError) => {
        if (!cancelled) {
          setSkillsError(loadError instanceof Error ? loadError.message : "加载 Skills 失败。");
          setSkillsLoading(false);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [drawerAgent, isGroup, open]);

  if (!open) {
    return null;
  }
  if (!activeConversation && !drawerAgent) {
    return null;
  }
  const activeConversationId = activeConversation?.id ?? "";

  async function handleSave(): Promise<void> {
    setSaving(true);
    setError(null);
    try {
      if (isGroup && activeConversation) {
        await getApi().groupConversation.updateProfile({
          conversationId: activeConversation.id,
          title: name,
          description,
          autoDispatchEnabled
        });
        if (rootPath.trim()) {
          await getApi().groupConversation.updateWorkspace({
            conversationId: activeConversation.id,
            rootPath: rootPath.trim()
          });
        }
      } else if (drawerAgent) {
        await getApi().agent.updateProfile({
          agentId: drawerAgent.id,
          name,
          description,
          skillIds
        });
        if (rootPath.trim()) {
          await getApi().agent.updateDefaultWorkspace({
            agentId: drawerAgent.id,
            rootPath: rootPath.trim()
          });
        }
      }
      await loadHubCollections();
      await refreshActiveWorkspaceContext();
      onClose();
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : "保存失败。");
    } finally {
      setSaving(false);
    }
  }

  async function handleOpenPicker(): Promise<void> {
    setError(null);
    try {
      await loadHubCollections();
      setPickerOpen(true);
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : "加载 Agent 列表失败。");
    }
  }

  async function handlePickFolder(): Promise<void> {
    if (pickingFolder) {
      return;
    }
    setError(null);
    setPickingFolder(true);
    try {
      const pickedPath = await getApi().workspace.selectFolder();
      if (pickedPath) {
        setRootPath(pickedPath);
      }
    } catch (pickError) {
      setError(pickError instanceof Error ? pickError.message : "选择文件夹失败。");
    } finally {
      setPickingFolder(false);
    }
  }

  async function handleAddMembers(agentIds: string[]): Promise<void> {
    const result = await addGroupMembers(activeConversationId, agentIds);
    if (result.invalidAgentIds.length > 0) {
      throw new Error(`以下 Agent 当前不可添加：${result.invalidAgentIds.join(", ")}`);
    }
    setMemberNotice(
      result.addedAgentIds.length > 0
        ? `已添加 ${result.addedAgentIds.length} 个 Agent。`
        : "所选 Agent 已在群聊中。"
    );
  }

  return (
    <>
      <aside className="conversation-settings-drawer" aria-label="Conversation settings">
      <header>
        <div>
          <span className="eyebrow">{isGroup ? "Group Chat" : "Agent"}</span>
          <h2>设置</h2>
        </div>
        <button type="button" onClick={onClose} aria-label="Close settings drawer">
          x
        </button>
      </header>

      {!activeConversation && drawerAgent ? (
        <p className="drawer-agent-hint">
          编辑 {drawerAgent.name} 的配置。保存后会更新 Agent 全局设置。
        </p>
      ) : null}

      <label>
        <span>{isGroup && activeConversation ? "群聊名称" : "Agent 名称"}</span>
        <input value={name} onChange={(event) => setName(event.target.value)} />
      </label>
      <label>
        <span>描述</span>
        <textarea rows={4} value={description} onChange={(event) => setDescription(event.target.value)} />
      </label>
      <label>
        <span>{isGroup && activeConversation ? "群聊工作目录" : "默认工作目录"}</span>
        <div className="drawer-folder-picker">
          <input
            className="drawer-folder-picker-input"
            placeholder="未选择文件夹，点击右侧按钮选择"
            readOnly
            tabIndex={-1}
            value={rootPath}
          />
          <div className="drawer-folder-picker-actions">
            {rootPath ? (
              <button
                disabled={saving || pickingFolder}
                type="button"
                onClick={() => setRootPath("")}
              >
                清除
              </button>
            ) : null}
            <button
              disabled={saving || pickingFolder}
              type="button"
              onClick={() => void handlePickFolder()}
            >
              {pickingFolder ? "选择中..." : "选择文件夹"}
            </button>
          </div>
        </div>
      </label>

      {!isGroup && drawerAgent ? (
        <SkillMultiSelect
          catalog={skillCatalog}
          disabled={saving}
          error={skillsError}
          loading={skillsLoading}
          selectedSkillIds={skillIds}
          onChange={setSkillIds}
        />
      ) : null}

      {isGroup ? (
        <>
          <label className="drawer-toggle">
            <span>自动分派</span>
            <input
              checked={autoDispatchEnabled}
              type="checkbox"
              onChange={(event) => setAutoDispatchEnabled(event.target.checked)}
            />
          </label>
          <section className="drawer-members">
            <div className="drawer-members-header">
              <h3>成员</h3>
              <button type="button" onClick={() => void handleOpenPicker()}>
                添加 Agent
              </button>
            </div>
            <ul className="drawer-member-list">
              {ownerMember ? (
                <li className="drawer-member-row" key={ownerMember.id}>
                  <AgentAvatar
                    alt={ownerMember.memberId}
                    name={ownerMember.memberId}
                    size={32}
                  />
                  <div className="drawer-member-info">
                    <span className="drawer-member-name">{ownerMember.memberId}</span>
                    <span className="drawer-member-role is-owner">群主</span>
                  </div>
                </li>
              ) : null}
              {mainAgentMember ? (
                <li className="drawer-member-row is-main" key={mainAgentMember.id}>
                  <AgentAvatar
                    alt={mainAgentMember.agent?.name ?? "主 Agent"}
                    avatar={mainAgentMember.agent?.avatar}
                    name={mainAgentMember.agent?.name ?? "主 Agent"}
                    size={32}
                  />
                  <div className="drawer-member-info">
                    <span className="drawer-member-name">
                      {mainAgentMember.agent?.name ?? "主 Agent"}
                    </span>
                    <span className="drawer-member-role is-main">主 Agent</span>
                  </div>
                </li>
              ) : null}
              {subAgentMembers.length === 0 && !ownerMember && !mainAgentMember ? (
                <p className="drawer-member-empty">
                  当前群聊还没有子 Agent，可以点击“添加 Agent”拉入成员。
                </p>
              ) : null}
              {subAgentMembers.map((member) => (
                <li className="drawer-member-row" key={member.id}>
                  <AgentAvatar
                    alt={member.agent?.name ?? member.memberId}
                    avatar={member.agent?.avatar}
                    name={member.agent?.name ?? member.memberId}
                    size={32}
                  />
                  <div className="drawer-member-info">
                    <span className="drawer-member-name">
                      {member.agent?.name ?? member.memberId}
                    </span>
                    <span className="drawer-member-role">成员</span>
                  </div>
                  <button
                    className="drawer-member-remove"
                    type="button"
                    onClick={() => void removeGroupMember(activeConversation.id, member.id)}
                  >
                    移除
                  </button>
                </li>
              ))}
            </ul>
            {memberNotice ? <p className="drawer-member-notice" role="status">{memberNotice}</p> : null}
          </section>
        </>
      ) : null}

      {error ? <p className="drawer-error">{error}</p> : null}
      <footer>
        <button type="button" onClick={onClose}>
          关闭
        </button>
        <button disabled={saving || !name.trim()} type="button" onClick={() => void handleSave()}>
          {saving ? "保存中..." : "保存"}
        </button>
      </footer>
      </aside>
      <AgentPickerDialog
        agents={contacts}
        disabledAgentIds={memberAgentIds}
        open={pickerOpen}
        onCancel={() => setPickerOpen(false)}
        onConfirm={handleAddMembers}
      />
    </>
  );
}
