import { useState } from "react";
import { useWorkspaceStore } from "../../state/workspaceStore";
import { CreateGroupDialog } from "../groups/CreateGroupDialog";

export function CreateGroupChatEntry() {
  const { contacts, createGroupConversation, loadHubCollections } = useWorkspaceStore();
  const [dialogOpen, setDialogOpen] = useState(false);

  async function handleOpen(): Promise<void> {
    await loadHubCollections();
    setDialogOpen(true);
  }

  return (
    <>
      <button
        className="create-group-chat-btn"
        type="button"
        onClick={() => void handleOpen()}
      >
        + 创建群聊
      </button>
      <CreateGroupDialog
        agents={contacts}
        open={dialogOpen}
        onClose={() => setDialogOpen(false)}
        onCreate={async ({ title, description, memberAgentIds }) => {
          await createGroupConversation(title, description, memberAgentIds);
        }}
      />
    </>
  );
}
