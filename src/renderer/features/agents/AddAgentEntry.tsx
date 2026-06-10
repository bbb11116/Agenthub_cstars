import { useState } from "react";
import { useWorkspaceStore } from "../../state/workspaceStore";
import {
  AddSubAgentDialog,
  type CreateSubAgentForm
} from "./AddSubAgentDialog";

export function AddAgentEntry() {
  const {
    agentTreeStatus,
    createSubAgentManually
  } = useWorkspaceStore();
  const [isDialogOpen, setIsDialogOpen] = useState(false);
  const isDisabled = agentTreeStatus === "loading";

  async function handleCreate(form: CreateSubAgentForm): Promise<void> {
    await createSubAgentManually({
      ...form
    });
  }

  return (
    <div className="add-agent-entry">
      <button
        className="add-agent-button"
        type="button"
        disabled={isDisabled}
        title="添加 Agent"
        onClick={() => setIsDialogOpen(true)}
      >
        <span aria-hidden="true">+</span>
        添加 Agent
      </button>
      <AddSubAgentDialog
        open={isDialogOpen}
        onClose={() => setIsDialogOpen(false)}
        onCreate={handleCreate}
      />
    </div>
  );
}
