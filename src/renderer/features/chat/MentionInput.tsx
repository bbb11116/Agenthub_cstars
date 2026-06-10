import { useCallback, useEffect, useRef, useState } from "react";
import type { GroupMemberWithAgent } from "../../../shared/domain";
import { AppIcon } from "../../components/ui/AppIcon";

type MentionInputProps = {
  members: GroupMemberWithAgent[];
  disabled: boolean;
  placeholder?: string;
  onSend: (text: string, mentionAgentIds: string[]) => void;
};

export function MentionInput({
  members,
  disabled,
  placeholder,
  onSend
}: MentionInputProps) {
  const [text, setText] = useState("");
  const [showMentionMenu, setShowMentionMenu] = useState(false);
  const [mentionFilter, setMentionFilter] = useState("");
  const [mentionStartIndex, setMentionStartIndex] = useState(-1);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const agentMembers = members.filter(
    (m) =>
      m.memberType === "agent" &&
      m.status === "active" &&
      m.agent?.status === "available" &&
      (m.role === "member" ||
        (m.role === "main_agent" && m.agent.role === "main"))
  );

  const filteredAgents = agentMembers.filter((m) =>
    m.agent!.name.toLowerCase().includes(mentionFilter.toLowerCase())
  );

  const detectMention = useCallback(
    (value: string, cursorPos: number) => {
      const textBeforeCursor = value.slice(0, cursorPos);
      const lastAtIndex = textBeforeCursor.lastIndexOf("@");

      if (lastAtIndex === -1) {
        setShowMentionMenu(false);
        return;
      }

      const textAfterAt = textBeforeCursor.slice(lastAtIndex + 1);

      if (textAfterAt.includes(" ") && textAfterAt.split(" ").length > 2) {
        setShowMentionMenu(false);
        return;
      }

      setMentionStartIndex(lastAtIndex);
      setMentionFilter(textAfterAt);
      setShowMentionMenu(true);
    },
    []
  );

  const insertMention = useCallback(
    (agentName: string) => {
      if (mentionStartIndex === -1) return;

      const before = text.slice(0, mentionStartIndex);
      const after = text.slice(textareaRef.current?.selectionStart ?? text.length);
      const newText = `${before}@${agentName} ${after}`;

      setText(newText);
      setShowMentionMenu(false);
      setMentionStartIndex(-1);

      setTimeout(() => {
        if (textareaRef.current) {
          const pos = before.length + agentName.length + 2;
          textareaRef.current.setSelectionRange(pos, pos);
          textareaRef.current.focus();
        }
      }, 0);
    },
    [text, mentionStartIndex]
  );

  const handleChange = useCallback(
    (e: React.ChangeEvent<HTMLTextAreaElement>) => {
      const value = e.target.value;
      setText(value);
      detectMention(value, e.target.selectionStart ?? value.length);
    },
    [detectMention]
  );

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
      if (e.key === "Enter" && !e.shiftKey && !showMentionMenu) {
        e.preventDefault();

        if (text.trim().length > 0 && !disabled) {
          const mentionRegex = /@([\w一-鿿][\w一-鿿\s-]*?)(?=[\s,，]|$|@)/g;
          const mentionAgentIds: string[] = [];
          let match;

          while ((match = mentionRegex.exec(text)) !== null) {
            const name = match[1].trim();
            const member = agentMembers.find(
              (m) => m.agent!.name.toLowerCase() === name.toLowerCase()
            );

            if (member && !mentionAgentIds.includes(member.memberId)) {
              mentionAgentIds.push(member.memberId);
            }
          }

          onSend(text.trim(), mentionAgentIds);
          setText("");
        }
      }
    },
    [text, disabled, showMentionMenu, agentMembers, onSend]
  );

  return (
    <div className="mention-input-wrapper">
      <textarea
        ref={textareaRef}
        className="mention-input-textarea"
        aria-label="Group message"
        disabled={disabled}
        placeholder={placeholder ?? "输入消息，使用 @ 提及 Agent..."}
        rows={1}
        value={text}
        onChange={handleChange}
        onKeyDown={handleKeyDown}
      />

      {showMentionMenu && filteredAgents.length > 0 ? (
        <div className="mention-menu">
          {filteredAgents.map((member) => (
            <button
              key={member.id}
              className={
                member.role === "main_agent"
                  ? "mention-menu-item is-main"
                  : "mention-menu-item"
              }
              type="button"
              onMouseDown={(e) => {
                e.preventDefault();
                insertMention(member.agent!.name);
              }}
            >
              {member.role === "main_agent" ? (
                <span className="mention-menu-badge">主</span>
              ) : null}
              <span className="mention-menu-name">{member.agent!.name}</span>
            </button>
          ))}
        </div>
      ) : null}

      <button
        className="mention-send-btn"
        type="button"
        aria-label="发送群聊消息"
        disabled={disabled || text.trim().length === 0}
        onClick={() => {
          if (text.trim().length > 0) {
            const mentionRegex = /@([\w一-鿿][\w一-鿿\s-]*?)(?=[\s,，]|$|@)/g;
            const mentionAgentIds: string[] = [];
            let match;

            while ((match = mentionRegex.exec(text)) !== null) {
              const name = match[1].trim();
              const member = agentMembers.find(
                (m) => m.agent!.name.toLowerCase() === name.toLowerCase()
              );

              if (member && !mentionAgentIds.includes(member.memberId)) {
                mentionAgentIds.push(member.memberId);
              }
            }

            onSend(text.trim(), mentionAgentIds);
            setText("");
          }
        }}
      >
        <AppIcon name="send" />
      </button>
    </div>
  );
}
