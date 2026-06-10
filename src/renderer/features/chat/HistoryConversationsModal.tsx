import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { Conversation } from "../../../shared/domain";
import { AppIcon } from "../../components/ui/AppIcon";
import { useWorkspaceStore } from "../../state/workspaceStore";

type HistoryConversationsModalProps = {
  open: boolean;
  onClose: () => void;
};

function getConversationLabel(
  conversation: Conversation,
  contacts: ReturnType<typeof useWorkspaceStore>["contacts"]
): string {
  if (conversation.type === "group") {
    return conversation.title;
  }
  return contacts.find((agent) => agent.id === conversation.agentId)?.name ?? conversation.title;
}

function formatTime(value: string | null): string {
  if (!value) {
    return "—";
  }
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return "—";
  }
  return date.toLocaleString([], {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit"
  });
}

function getPreviewText(value: string | undefined): string {
  if (!value) {
    return "暂无消息";
  }
  return value.length > 80 ? `${value.slice(0, 80)}…` : value;
}

export function HistoryConversationsModal({
  open,
  onClose
}: HistoryConversationsModalProps): JSX.Element | null {
  const {
    activeConversation,
    chats,
    contacts,
    deleteConversation,
    deleteGroupConversation,
    groupChats,
    groupConversationsByWorkspace,
    selectChat
  } = useWorkspaceStore();
  const [pendingDeleteId, setPendingDeleteId] = useState<string | null>(null);
  const dialogRef = useRef<HTMLDivElement | null>(null);

  const historyEntries = useMemo<Conversation[]>(() => {
    if (!activeConversation) {
      return [];
    }

    let pool: Conversation[];
    if (activeConversation.type === "group") {
      const workspaceGroups = groupConversationsByWorkspace[activeConversation.workspaceId] ?? [];
      pool = workspaceGroups.length > 0
        ? workspaceGroups
        : groupChats.filter((c) => c.workspaceId === activeConversation.workspaceId);
    } else {
      const agentChats = chats.filter(
        (c) => c.type === "direct" && c.agentId === activeConversation.agentId
      );
      pool = agentChats.length > 0
        ? agentChats
        : chats.filter((c) => c.type === "direct" && c.agentId === activeConversation.agentId);
    }

    return [...pool]
      .filter((c) => c.id !== activeConversation.id)
      .sort((a, b) => {
        const aTime = a.lastMessageAt ?? a.updatedAt;
        const bTime = b.lastMessageAt ?? b.updatedAt;
        return bTime.localeCompare(aTime);
      });
  }, [activeConversation, chats, groupChats, groupConversationsByWorkspace]);

  useEffect(() => {
    if (!open) {
      return;
    }

    function handleKeyDown(event: KeyboardEvent): void {
      if (event.key === "Escape") {
        onClose();
      }
    }

    window.addEventListener("keydown", handleKeyDown);
    dialogRef.current?.focus();
    return () => {
      window.removeEventListener("keydown", handleKeyDown);
    };
  }, [open, onClose]);

  if (!open || !activeConversation) {
    return null;
  }

  const scopeLabel = activeConversation.type === "group"
    ? getConversationLabel(activeConversation, contacts)
    : getConversationLabel(activeConversation, contacts);

  function handleSelect(conversation: Conversation): void {
    selectChat(conversation.id);
    onClose();
  }

  async function handleDelete(event: React.MouseEvent, conversation: Conversation): Promise<void> {
    event.stopPropagation();
    event.preventDefault();
    if (pendingDeleteId) {
      return;
    }
    const label = getConversationLabel(conversation, contacts);
    const confirmed = window.confirm(
      `确定删除「${label}」吗？\n\n此操作会永久删除该对话的所有消息、运行记录、Artifacts 等信息，且不可撤销。`
    );
    if (!confirmed) {
      return;
    }
    setPendingDeleteId(conversation.id);
    try {
      const deleted =
        conversation.type === "group"
          ? await deleteGroupConversation(conversation.id)
          : await deleteConversation(conversation.id);
      if (!deleted) {
        window.alert("删除失败：未找到该对话。");
      }
    } catch (error) {
      window.alert(error instanceof Error ? error.message : "删除对话失败。");
    } finally {
      setPendingDeleteId(null);
    }
  }

  return createPortal(
    <div
      className="history-modal-backdrop"
      role="presentation"
      onClick={onClose}
    >
      <div
        className="history-modal"
        role="dialog"
        aria-modal="true"
        aria-label="历史对话"
        ref={dialogRef}
        tabIndex={-1}
        onClick={(event) => event.stopPropagation()}
      >
        <header className="history-modal-header">
          <div>
            <span className="eyebrow">历史对话</span>
            <h2>
              {activeConversation.type === "group" ? "群聊" : "与"} {scopeLabel} 的历史对话
            </h2>
          </div>
          <button
            className="history-modal-close"
            type="button"
            aria-label="关闭"
            onClick={onClose}
          >
            <AppIcon name="close" />
          </button>
        </header>

        <div className="history-modal-body">
          {historyEntries.length === 0 ? (
            <p className="history-modal-empty">暂无历史对话</p>
          ) : (
            <ul className="history-modal-list">
              {historyEntries.map((conversation) => (
                <li key={conversation.id}>
                  <div className="history-modal-item-row">
                    <button
                      className="history-modal-item"
                      type="button"
                      onClick={() => handleSelect(conversation)}
                    >
                      <span
                        className={
                          conversation.type === "group"
                            ? "hub-avatar hub-avatar--group"
                            : "hub-avatar hub-avatar--agent"
                        }
                      >
                        {getConversationLabel(conversation, contacts).slice(0, 1)}
                      </span>
                      <span className="history-modal-item-copy">
                        <strong>{getConversationLabel(conversation, contacts)}</strong>
                        <small>{getPreviewText(conversation.lastMessagePreview)}</small>
                      </span>
                      <time>{formatTime(conversation.lastMessageAt ?? conversation.updatedAt)}</time>
                    </button>
                    <button
                      className="history-modal-item-delete"
                      type="button"
                      aria-label={`删除 ${getConversationLabel(conversation, contacts)}`}
                      title="删除对话"
                      disabled={pendingDeleteId === conversation.id}
                      onClick={(event) => void handleDelete(event, conversation)}
                    >
                      <AppIcon name="trash" />
                    </button>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
    </div>,
    document.body
  );
}
