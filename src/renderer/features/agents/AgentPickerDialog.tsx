import { useEffect, useState } from "react";
import { AgentPickerList } from "./AgentPickerList";
import type { AgentPickerContact } from "./agentPickerUtils";

type AgentPickerDialogProps = {
  open: boolean;
  title?: string;
  agents: AgentPickerContact[];
  disabledAgentIds?: string[];
  disabledReasonLabel?: string;
  initialSelectedAgentIds?: string[];
  onCancel: () => void;
  onConfirm: (agentIds: string[]) => Promise<void> | void;
};

const EMPTY_AGENT_IDS: string[] = [];

export function AgentPickerDialog({
  open,
  title = "添加 Agent",
  agents,
  disabledAgentIds = [],
  disabledReasonLabel = "已添加",
  initialSelectedAgentIds = EMPTY_AGENT_IDS,
  onCancel,
  onConfirm
}: AgentPickerDialogProps) {
  const [query, setQuery] = useState("");
  const [selectedAgentIds, setSelectedAgentIds] = useState<string[]>([]);
  const [confirming, setConfirming] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) {
      return;
    }
    setQuery("");
    setSelectedAgentIds([...new Set(initialSelectedAgentIds)]);
    setConfirming(false);
    setError(null);
  }, [open]);

  useEffect(() => {
    if (!open) {
      return;
    }
    function handleKeyDown(event: KeyboardEvent): void {
      if (event.key === "Escape" && !confirming) {
        handleCancel();
      }
    }
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [confirming, onCancel, open]);

  if (!open) {
    return null;
  }

  function handleToggle(agentId: string): void {
    setSelectedAgentIds((current) =>
      current.includes(agentId)
        ? current.filter((selectedId) => selectedId !== agentId)
        : [...current, agentId]
    );
  }

  function handleCancel(): void {
    setQuery("");
    setSelectedAgentIds([]);
    setConfirming(false);
    setError(null);
    onCancel();
  }

  async function handleConfirm(): Promise<void> {
    if (selectedAgentIds.length === 0 || confirming) {
      return;
    }

    setConfirming(true);
    setError(null);
    try {
      await onConfirm(selectedAgentIds);
      handleCancel();
    } catch (confirmError) {
      setError(confirmError instanceof Error ? confirmError.message : "添加 Agent 失败。");
      setConfirming(false);
    }
  }

  return (
    <div
      className="agent-picker-dialog-backdrop"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget && !confirming) {
          handleCancel();
        }
      }}
    >
      <section
        aria-labelledby="agent-picker-dialog-title"
        aria-modal="true"
        className="agent-picker-dialog"
        role="dialog"
      >
        <header className="agent-picker-dialog-header">
          <h2 id="agent-picker-dialog-title">{title}</h2>
          <button
            aria-label="Close Agent picker dialog"
            disabled={confirming}
            type="button"
            onClick={handleCancel}
          >
            x
          </button>
        </header>
        <input
          autoFocus
          className="agent-picker-search"
          disabled={confirming}
          placeholder="搜索 Agent 名称、描述或 Provider"
          type="search"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
        />
        <div className="agent-picker-list">
          <AgentPickerList
            agents={agents}
            disabledAgentIds={disabledAgentIds}
            disabledReasonLabel={disabledReasonLabel}
            query={query}
            selectedAgentIds={selectedAgentIds}
            onToggle={handleToggle}
          />
        </div>
        {error ? <p className="agent-picker-error" role="alert">{error}</p> : null}
        <footer className="agent-picker-dialog-footer">
          <span>已选择 {selectedAgentIds.length} 个 Agent</span>
          <div>
            <button disabled={confirming} type="button" onClick={handleCancel}>
              取消
            </button>
            <button
              disabled={selectedAgentIds.length === 0 || confirming}
              type="button"
              onClick={() => void handleConfirm()}
            >
              {selectedAgentIds.length > 0 ? `添加 ${selectedAgentIds.length} 个` : "添加"}
            </button>
          </div>
        </footer>
      </section>
    </div>
  );
}
