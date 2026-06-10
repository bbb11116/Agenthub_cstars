import { useState } from "react";
import type { ContextUsage } from "../../../shared/modelProvider";
import { AppIcon } from "../../components/ui/AppIcon";

type MessageComposerProps = {
  disabled: boolean;
  isSending: boolean;
  error: string | null;
  placeholder: string;
  contextUsage?: ContextUsage | null;
  onSend: (text: string) => Promise<void>;
};

export function MessageComposer({
  contextUsage,
  disabled,
  error,
  isSending,
  onSend,
  placeholder
}: MessageComposerProps) {
  const [draft, setDraft] = useState("");
  const canSend = draft.trim().length > 0 && !disabled && !isSending;

  async function submitMessage() {
    if (!canSend) {
      return;
    }

    const text = draft.trim();
    setDraft("");
    await onSend(text);
  }

  return (
    <form
      className="message-composer"
      onSubmit={(event) => {
        event.preventDefault();
        void submitMessage();
      }}
    >
      {error ? (
        <div className="message-send-error" role="alert">
        {error}
      </div>
    ) : null}
      <textarea
        aria-label="Message"
        disabled={disabled}
        placeholder={placeholder}
        rows={1}
        value={draft}
        onChange={(event) => setDraft(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Enter" && !event.shiftKey) {
            event.preventDefault();
            void submitMessage();
          }
        }}
      />
      <div className="message-composer-toolbar">
        <div className="message-composer-tools" aria-label="Composer status">
          <span>Local workspace</span>
          {contextUsage ? (
            <span
              className={`context-usage context-usage-${contextUsage.status}`}
              role={contextUsage.status === "overflow" ? "alert" : "status"}
              title={`Input ${contextUsage.inputTokens.toLocaleString()} + Output reserve ${contextUsage.reservedOutputTokens.toLocaleString()} / Window ${contextUsage.contextWindowTokens.toLocaleString()}`}
            >
              {Math.round(contextUsage.contextPercent)}% context
            </span>
          ) : null}
        </div>
        <button type="submit" disabled={!canSend} aria-label={isSending ? "正在发送" : "发送消息"}>
          {isSending ? <span className="composer-sending-dot" /> : <AppIcon name="send" />}
        </button>
      </div>
    </form>
  );
}
