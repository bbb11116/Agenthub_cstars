import { useEffect, useState, type FormEvent } from "react";
import { AgentPickerDialog } from "../agents/AgentPickerDialog";
import type { AgentPickerContact } from "../agents/agentPickerUtils";

type CreateGroupDialogProps = {
  open: boolean;
  agents: AgentPickerContact[];
  onClose: () => void;
  onCreate: (input: {
    title: string;
    description: string;
    memberAgentIds: string[];
  }) => Promise<void>;
};

export function CreateGroupDialog({
  open,
  agents,
  onClose,
  onCreate
}: CreateGroupDialogProps) {
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [selectedAgentIds, setSelectedAgentIds] = useState<string[]>([]);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) {
      return;
    }
    setTitle("");
    setDescription("");
    setSelectedAgentIds([]);
    setPickerOpen(false);
    setCreating(false);
    setError(null);
  }, [open]);

  if (!open) {
    return null;
  }

  const selectedAgents = selectedAgentIds
    .map((agentId) => agents.find((agent) => agent.id === agentId))
    .filter((agent): agent is AgentPickerContact => Boolean(agent));

  async function handleSubmit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    if (!title.trim() || creating) {
      return;
    }

    setCreating(true);
    setError(null);
    try {
      await onCreate({
        title: title.trim(),
        description: description.trim(),
        memberAgentIds: selectedAgentIds
      });
      onClose();
    } catch (creationError) {
      setError(creationError instanceof Error ? creationError.message : "创建群聊失败。");
      setCreating(false);
    }
  }

  return (
    <>
      <div
        className="create-group-dialog-backdrop"
        onMouseDown={(event) => {
          if (event.target === event.currentTarget && !creating) {
            onClose();
          }
        }}
      >
        <section
          aria-labelledby="create-group-dialog-title"
          aria-modal="true"
          className="create-group-dialog"
          role="dialog"
        >
          <header className="create-group-dialog-header">
            <div>
              <span className="eyebrow">Group Chat</span>
              <h2 id="create-group-dialog-title">创建群聊</h2>
            </div>
            <button aria-label="Close Create Group dialog" disabled={creating} type="button" onClick={onClose}>
              x
            </button>
          </header>
          <form className="create-group-form" onSubmit={(event) => void handleSubmit(event)}>
            <label>
              <span>群聊名称</span>
              <input
                autoFocus
                disabled={creating}
                placeholder="输入群聊名称"
                value={title}
                onChange={(event) => setTitle(event.target.value)}
              />
            </label>
            <label>
              <span>群聊描述（可选）</span>
              <textarea
                disabled={creating}
                placeholder="描述这个群聊的协作目标"
                rows={4}
                value={description}
                onChange={(event) => setDescription(event.target.value)}
              />
            </label>
            <section className="create-group-selected-agents">
              <div className="create-group-selected-header">
                <strong>子 Agent</strong>
                <button disabled={creating} type="button" onClick={() => setPickerOpen(true)}>
                  添加 Agent
                </button>
              </div>
              {selectedAgents.length === 0 ? (
                <p>暂未选择子 Agent，创建后也可以在群聊设置中添加。</p>
              ) : (
                <>
                  <p>已选择 {selectedAgents.length} 个 Agent</p>
                  <div className="create-group-agent-chips">
                    {selectedAgents.map((agent) => (
                      <span className="create-group-agent-chip" key={agent.id}>
                        {agent.name}
                        <button
                          aria-label={`移除 ${agent.name}`}
                          disabled={creating}
                          type="button"
                          onClick={() =>
                            setSelectedAgentIds((current) =>
                              current.filter((agentId) => agentId !== agent.id)
                            )
                          }
                        >
                          x
                        </button>
                      </span>
                    ))}
                  </div>
                </>
              )}
            </section>
            {error ? <p className="create-group-dialog-error" role="alert">{error}</p> : null}
            <div className="create-group-dialog-actions">
              <button disabled={creating} type="button" onClick={onClose}>
                取消
              </button>
              <button disabled={!title.trim() || creating} type="submit">
                {creating ? "创建中..." : "创建群聊"}
              </button>
            </div>
          </form>
        </section>
      </div>
      <AgentPickerDialog
        agents={agents}
        disabledAgentIds={selectedAgentIds}
        disabledReasonLabel="已选择"
        open={pickerOpen}
        onCancel={() => setPickerOpen(false)}
        onConfirm={(agentIds) => {
          setSelectedAgentIds((current) => [...new Set([...current, ...agentIds])]);
        }}
      />
    </>
  );
}
