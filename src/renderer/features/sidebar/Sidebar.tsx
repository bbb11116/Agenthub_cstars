import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import type { Agent, Conversation } from "../../../shared/domain";
import { AddAgentEntry } from "../agents/AddAgentEntry";
import { CreateGroupChatEntry } from "../chat/CreateGroupChatEntry";
import { AppIcon } from "../../components/ui/AppIcon";
import { useWorkspaceStore } from "../../state/workspaceStore";

type ContactContextMenuState = {
  target: "agent" | "group";
  targetId: string;
  source: "chats" | "contacts";
  x: number;
  y: number;
};

const PINNED_STORAGE_KEY = "agenthub:pinned-conversation-ids";

function loadPinnedIds(): Set<string> {
  try {
    const stored = window.localStorage.getItem(PINNED_STORAGE_KEY);
    if (!stored) {
      return new Set();
    }
    const parsed = JSON.parse(stored) as unknown;
    if (Array.isArray(parsed)) {
      return new Set(parsed.filter((value): value is string => typeof value === "string"));
    }
  } catch {
    // ignore corrupted storage
  }
  return new Set();
}

function savePinnedIds(ids: Set<string>): void {
  try {
    window.localStorage.setItem(PINNED_STORAGE_KEY, JSON.stringify([...ids]));
  } catch {
    // ignore quota errors
  }
}

export function canDeleteAgentFromContacts(
  agent: Pick<Agent, "role" | "type" | "status">
): boolean {
  return (
    agent.role !== "main" &&
    agent.type !== "orchestrator" &&
    agent.status !== "running" &&
    agent.status !== "deleted"
  );
}

type SidebarProps = {
  compact?: boolean;
  listPaneCollapsed?: boolean;
  onListPaneChange?: (collapsed: boolean) => void;
};

export function Sidebar({
  compact = false,
  listPaneCollapsed = false,
  onListPaneChange
}: SidebarProps) {
  const {
    appView,
    activeAgentId,
    activeConversationId,
    contacts,
    groupChats,
    navigationSection,
    deleteGroupConversation,
    deleteSubAgent,
    openAgentContact,
    openDirectChatForAgent,
    selectChat,
    setAppView,
    setNavigationSection
  } = useWorkspaceStore();
  const [contextMenu, setContextMenu] = useState<ContactContextMenuState | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [tooltip, setTooltip] = useState<{ label: string; x: number; y: number } | null>(null);
  const [pinnedIds, setPinnedIds] = useState<Set<string>>(() => loadPinnedIds());

  function handleTooltipEnter(label: string, event: React.MouseEvent<HTMLButtonElement>): void {
    setTooltip({ label, x: event.clientX, y: event.clientY });
  }

  function handleTooltipMove(event: React.MouseEvent<HTMLButtonElement>): void {
    setTooltip((prev) => (prev ? { ...prev, x: event.clientX, y: event.clientY } : prev));
  }

  function handleTooltipLeave(): void {
    setTooltip(null);
  }

  useEffect(() => {
    savePinnedIds(pinnedIds);
  }, [pinnedIds]);

  function togglePin(id: string): void {
    setPinnedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }
      return next;
    });
  }
  const contextMenuAgent = contextMenu?.target === "agent"
    ? contacts.find((agent) => agent.id === contextMenu.targetId) ?? null
    : null;
  const contextMenuGroupChat = contextMenu?.target === "group"
    ? groupChats.find((conversation) => conversation.id === contextMenu.targetId) ?? null
    : null;
  const sortedGroupChats = [...groupChats].sort((a, b) => {
    const aTime = a.lastMessageAt ? Date.parse(a.lastMessageAt) : 0;
    const bTime = b.lastMessageAt ? Date.parse(b.lastMessageAt) : 0;
    return bTime - aTime;
  });
  const sortedContactsByPin = [...contacts].sort((a, b) => {
    const aPinned = pinnedIds.has(a.id);
    const bPinned = pinnedIds.has(b.id);
    if (aPinned !== bPinned) {
      return aPinned ? -1 : 1;
    }
    return a.name.localeCompare(b.name);
  });
  const sortedGroupChatsByPin = [...sortedGroupChats].sort((a, b) => {
    const aPinned = pinnedIds.has(a.id);
    const bPinned = pinnedIds.has(b.id);
    if (aPinned !== bPinned) {
      return aPinned ? -1 : 1;
    }
    return 0;
  });

  useEffect(() => {
    if (!contextMenu) {
      return;
    }

    function closeMenu(): void {
      setContextMenu(null);
    }

    function handleKeyDown(event: KeyboardEvent): void {
      if (event.key === "Escape") {
        closeMenu();
      }
    }

    window.addEventListener("click", closeMenu);
    window.addEventListener("keydown", handleKeyDown);
    return () => {
      window.removeEventListener("click", closeMenu);
      window.removeEventListener("keydown", handleKeyDown);
    };
  }, [contextMenu]);

  function handleOpenAgent(agent: Agent): void {
    setContextMenu(null);
    openAgentContact(agent.id);
  }

  async function handleSendMessage(agent: Agent): Promise<void> {
    setContextMenu(null);
    try {
      await openDirectChatForAgent(agent.id);
    } catch (err) {
      window.alert(err instanceof Error ? err.message : "Failed to open conversation.");
    }
  }

  function handleEditAgent(agent: Agent): void {
    handleOpenAgent(agent);
    window.dispatchEvent(
      new CustomEvent("agenthub:open-conversation-settings", {
        detail: { agentId: agent.id }
      })
    );
  }

  async function handleDeleteAgent(agent: Agent): Promise<void> {
    setContextMenu(null);
    setNotice(null);
    const confirmed = window.confirm(
      `确定删除「${agent.name}」吗？\n\n此操作会删除该 Agent 的基础资料、System Prompt、工具权限、单聊记录、记忆、项目经历、默认 WorkspaceContext 和群聊成员关系。\n\n群聊历史消息会作为项目审计记录保留，并显示为已删除 Agent 的历史消息。\n\n此操作不可撤销。`
    );
    if (!confirmed) {
      return;
    }

    try {
      const result = await deleteSubAgent({ agentId: agent.id });
      setNotice("Agent 已删除。");
      if (result.warning) {
        window.alert(result.warning);
      }
    } catch (error) {
      window.alert(error instanceof Error ? error.message : "删除 Agent 失败。");
    }
  }

  function handleOpenGroupChat(conversation: Conversation): void {
    setContextMenu(null);
    selectChat(conversation.id);
  }

  async function handleDeleteGroupChat(conversation: Conversation): Promise<void> {
    setContextMenu(null);
    setNotice(null);
    const confirmed = window.confirm(
      `确定解散群聊「${conversation.title}」吗？\n\n此操作会删除该群聊的成员关系、运行记录和草稿，所有 Agent 不再属于此群聊。\n\n群聊历史消息会作为项目审计记录保留。\n\n此操作不可撤销。`
    );
    if (!confirmed) {
      return;
    }

    try {
      const deleted = await deleteGroupConversation(conversation.id);
      if (deleted) {
        setNotice("群聊已解散。");
      }
    } catch (error) {
      window.alert(error instanceof Error ? error.message : "解散群聊失败。");
    }
  }

  function handleSelectNavigation(section: "chats" | "contacts" | "skills"): void {
    setAppView("main");
    if (section === navigationSection) {
      onListPaneChange?.(!listPaneCollapsed);
    } else {
      onListPaneChange?.(false);
      setNavigationSection(section);
    }
  }

  const headerMeta = {
    chats: {
      eyebrow: "Local workspace",
      title: "对话",
      description: "继续你的 Agent 协作流"
    },
    contacts: {
      eyebrow: "Agent network",
      title: "通讯录",
      description: "管理本地 Agent 协作成员"
    },
    skills: {
      eyebrow: "Skill library",
      title: "技能点",
      description: "浏览和发现 Agent 可用技能"
    }
  }[navigationSection];

  return (
    <aside
      className={
        compact
          ? "hub-sidebar compact"
          : listPaneCollapsed
            ? "hub-sidebar list-pane-collapsed"
            : "hub-sidebar"
      }
      aria-label="AgentHub navigation"
    >
      <nav className="hub-rail" aria-label="Primary navigation">
        <div className="hub-logo">AH</div>
        <button
          className={appView !== "settings" && navigationSection === "chats" ? "active" : ""}
          type="button"
          aria-label="对话"
          onClick={() => handleSelectNavigation("chats")}
          onMouseEnter={(event) => handleTooltipEnter("对话", event)}
          onMouseMove={handleTooltipMove}
          onMouseLeave={handleTooltipLeave}
        >
          <AppIcon name="chat" />
        </button>
        <button
          className={appView !== "settings" && navigationSection === "contacts" ? "active" : ""}
          type="button"
          aria-label="通讯录"
          onClick={() => handleSelectNavigation("contacts")}
          onMouseEnter={(event) => handleTooltipEnter("通讯录", event)}
          onMouseMove={handleTooltipMove}
          onMouseLeave={handleTooltipLeave}
        >
          <AppIcon name="users" />
        </button>
        <button
          className={appView !== "settings" && navigationSection === "skills" ? "active" : ""}
          type="button"
          aria-label="技能点"
          onClick={() => handleSelectNavigation("skills")}
          onMouseEnter={(event) => handleTooltipEnter("技能点", event)}
          onMouseMove={handleTooltipMove}
          onMouseLeave={handleTooltipLeave}
        >
          <AppIcon name="sparkle" />
        </button>
        <button
          className={appView === "settings" ? "hub-rail-settings active" : "hub-rail-settings"}
          type="button"
          aria-label="设置"
          onClick={() => setAppView("settings")}
          onMouseEnter={(event) => handleTooltipEnter("设置", event)}
          onMouseMove={handleTooltipMove}
          onMouseLeave={handleTooltipLeave}
        >
          <AppIcon name="settings" />
        </button>
      </nav>

      {compact ? null : (
      <section className="hub-list-pane">
        <header className="hub-list-header">
          <div>
            <span className="eyebrow">{headerMeta.eyebrow}</span>
            <h1>{headerMeta.title}</h1>
            <p>{headerMeta.description}</p>
          </div>
        </header>

        {navigationSection === "chats" ? (
          <div className="hub-contact-list">
            <h3>Agents</h3>
            {sortedContactsByPin.map((agent) => (
              <button
                className={
                  agent.id === activeAgentId
                    ? "hub-contact-item active"
                    : "hub-contact-item"
                }
                key={agent.id}
                type="button"
                onClick={() => void openDirectChatForAgent(agent.id)}
                onContextMenu={(event) => {
                  event.preventDefault();
                  setContextMenu({
                    target: "agent",
                    targetId: agent.id,
                    source: "chats",
                    x: event.clientX,
                    y: event.clientY
                  });
                }}
              >
                <span className="hub-avatar hub-avatar--agent">{agent.name.slice(0, 1)}</span>
                <span className="hub-contact-copy">
                  <strong>{agent.name}</strong>
                  <small>{agent.description || "开始对话"}</small>
                </span>
                {pinnedIds.has(agent.id) ? (
                  <span className="hub-pin-indicator" aria-label="已置顶">
                    <AppIcon name="pin" />
                  </span>
                ) : null}
              </button>
            ))}
            <h3>群聊</h3>
            {sortedGroupChatsByPin.length === 0 ? (
              <p className="hub-empty-copy">还没有群聊，去通讯录创建。</p>
            ) : null}
            {sortedGroupChatsByPin.map((conversation) => (
              <button
                className={
                  conversation.id === activeConversationId
                    ? "hub-contact-item active"
                    : "hub-contact-item"
                }
                key={conversation.id}
                type="button"
                onClick={() => selectChat(conversation.id)}
                onContextMenu={(event) => {
                  event.preventDefault();
                  setContextMenu({
                    target: "group",
                    targetId: conversation.id,
                    source: "chats",
                    x: event.clientX,
                    y: event.clientY
                  });
                }}
              >
                <span className="hub-avatar hub-avatar--group">群</span>
                <span className="hub-contact-copy">
                  <strong>{conversation.title}</strong>
                  <small>{conversation.lastMessagePreview ?? "群聊"}</small>
                </span>
                {pinnedIds.has(conversation.id) ? (
                  <span className="hub-pin-indicator" aria-label="已置顶">
                    <AppIcon name="pin" />
                  </span>
                ) : null}
              </button>
            ))}
          </div>
        ) : (
        <div className="hub-contact-list">
            {navigationSection === "contacts" ? (
              <>
                <AddAgentEntry />
                <CreateGroupChatEntry />
              </>
            ) : null}
            {notice ? (
              <p className="hub-contact-notice" role="status">
                {notice}
              </p>
            ) : null}
            <h3>{navigationSection === "skills" ? "可用 Agent" : "Agents"}</h3>
            {contacts.map((agent) => (
              <button
                className={
                  agent.id === activeAgentId
                    ? "hub-contact-item active"
                    : "hub-contact-item"
                }
                key={agent.id}
                type="button"
                onContextMenu={(event) => {
                  event.preventDefault();
                  setContextMenu({
                    target: "agent",
                    targetId: agent.id,
                    source: "contacts",
                    x: event.clientX,
                    y: event.clientY
                  });
                }}
                onClick={() => openAgentContact(agent.id)}
              >
                <span className="hub-avatar hub-avatar--agent">{agent.name.slice(0, 1)}</span>
                <span className="hub-contact-copy">
                  <strong>{agent.name}</strong>
                  <small>{agent.description || "暂无描述"}</small>
                </span>
              </button>
            ))}
            {navigationSection === "contacts" ? (
              <>
                <h3>群聊</h3>
                {sortedGroupChats.length === 0 ? (
                  <p className="hub-empty-copy">还没有群聊，点击上方"+ 创建群聊"开始。</p>
                ) : null}
                {sortedGroupChats.map((conversation) => (
                  <button
                    className={
                      conversation.id === activeConversationId
                        ? "hub-contact-item active"
                        : "hub-contact-item"
                    }
                    key={conversation.id}
                    type="button"
                    onContextMenu={(event) => {
                      event.preventDefault();
                      setContextMenu({
                        target: "group",
                        targetId: conversation.id,
                        source: "contacts",
                        x: event.clientX,
                        y: event.clientY
                      });
                    }}
                    onClick={() => selectChat(conversation.id)}
                  >
                    <span className="hub-avatar hub-avatar--group">群</span>
                    <span className="hub-contact-copy">
                      <strong>{conversation.title}</strong>
                      <small>{conversation.lastMessagePreview ?? "群聊"}</small>
                    </span>
                  </button>
                ))}
              </>
            ) : null}
            {contextMenu && contextMenuAgent
              ? createPortal(
                  <div
                    className="hub-contact-context-menu"
                    role="menu"
                    style={{
                      left: contextMenu.x,
                      top: contextMenu.y
                    }}
                    onClick={(event) => event.stopPropagation()}
                  >
                    {contextMenu.source === "chats" ? (
                      <button
                        type="button"
                        role="menuitem"
                        onClick={() => {
                          togglePin(contextMenuAgent.id);
                          setContextMenu(null);
                        }}
                      >
                        {pinnedIds.has(contextMenuAgent.id) ? "取消置顶" : "置顶"}
                      </button>
                    ) : null}
                    <button
                      type="button"
                      role="menuitem"
                      onClick={() => void handleSendMessage(contextMenuAgent)}
                    >
                      发送消息
                    </button>
                    <button
                      type="button"
                      role="menuitem"
                      onClick={() => handleEditAgent(contextMenuAgent)}
                    >
                      编辑 Agent
                    </button>
                    {canDeleteAgentFromContacts(contextMenuAgent) ? (
                      <button
                        className="hub-contact-context-menu-danger"
                        type="button"
                        role="menuitem"
                        onClick={() => void handleDeleteAgent(contextMenuAgent)}
                      >
                        删除 Agent
                      </button>
                    ) : null}
                  </div>,
                  document.body
                )
              : null}
            {contextMenu && contextMenuGroupChat
              ? createPortal(
                  <div
                    className="hub-contact-context-menu"
                    role="menu"
                    style={{
                      left: contextMenu.x,
                      top: contextMenu.y
                    }}
                    onClick={(event) => event.stopPropagation()}
                  >
                    {contextMenu.source === "chats" ? (
                      <button
                        type="button"
                        role="menuitem"
                        onClick={() => {
                          togglePin(contextMenuGroupChat.id);
                          setContextMenu(null);
                        }}
                      >
                        {pinnedIds.has(contextMenuGroupChat.id) ? "取消置顶" : "置顶"}
                      </button>
                    ) : null}
                    <button
                      type="button"
                      role="menuitem"
                      onClick={() => handleOpenGroupChat(contextMenuGroupChat)}
                    >
                      打开群聊
                    </button>
                    <button
                      className="hub-contact-context-menu-danger"
                      type="button"
                      role="menuitem"
                      onClick={() => void handleDeleteGroupChat(contextMenuGroupChat)}
                    >
                      解散群聊
                    </button>
                  </div>,
                  document.body
                )
              : null}
          </div>
        )}
      </section>
      )}
      {tooltip
        ? createPortal(
            <div
              className="hub-nav-tooltip"
              role="tooltip"
              style={{ left: tooltip.x, top: tooltip.y }}
            >
              {tooltip.label}
            </div>,
            document.body
          )
        : null}
    </aside>
  );
}
