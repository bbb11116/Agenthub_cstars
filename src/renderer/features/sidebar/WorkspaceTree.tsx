import { useEffect, useState } from "react";
import { useWorkspaceStore } from "../../state/workspaceStore";
import { AgentNode } from "./AgentNode";

type WorkspaceContextMenuState = {
  workspaceId: string;
  x: number;
  y: number;
};

export function WorkspaceTree() {
  const {
    activeAgentId,
    activeWorkspaceAgents,
    activeWorkspaceId,
    agentTreeError,
    agentTreeStatus,
    conversationsByAgent,
    deleteWorkspace,
    loadWorkspaceTree,
    selectConversation,
    selectWorkspace,
    workspaces
  } = useWorkspaceStore();
  const [contextMenu, setContextMenu] = useState<WorkspaceContextMenuState | null>(null);
  const hasMainAgent = activeWorkspaceAgents.some((agent) => agent.role === "main");
  const contextMenuWorkspace =
    workspaces.find((workspace) => workspace.id === contextMenu?.workspaceId) ?? null;

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

  async function handleDeleteWorkspace(): Promise<void> {
    if (!contextMenuWorkspace) {
      return;
    }

    setContextMenu(null);

    const confirmed = window.confirm(
      `Delete workspace "${contextMenuWorkspace.name}" from AgentHub?\n\nThis only removes AgentHub configuration, Agents, and chat history. It will not delete the local folder.`
    );

    if (!confirmed) {
      return;
    }

    await deleteWorkspace(contextMenuWorkspace.id);
  }

  if (workspaces.length === 0) {
    return (
      <div className="tree-status" role="status">
        No workspace open.
      </div>
    );
  }

  return (
    <div className="workspace-list" role="tree" aria-label="Workspaces">
      {workspaces.map((workspace) => {
        const isActiveWorkspace = workspace.id === activeWorkspaceId;

        return (
          <div
            className="workspace-tree-node"
            key={workspace.id}
            role="treeitem"
            aria-expanded={isActiveWorkspace}
          >
            <button
              className={
                isActiveWorkspace ? "workspace-item active" : "workspace-item"
              }
              type="button"
              onContextMenu={(event) => {
                event.preventDefault();
                setContextMenu({
                  workspaceId: workspace.id,
                  x: event.clientX,
                  y: event.clientY
                });
              }}
              onClick={() => selectWorkspace(workspace.id)}
            >
              <span className="workspace-item-name">{workspace.name}</span>
              <span className="workspace-item-path">{workspace.rootPath}</span>
              <span
                className={workspace.gitEnabled ? "workspace-git git-on" : "workspace-git git-off"}
              >
                {workspace.gitEnabled ? "Git" : "No Git"}
              </span>
            </button>

            {isActiveWorkspace ? (
              <div className="agent-tree" role="group">
                {agentTreeStatus === "loading" ? (
                  <div className="tree-status" role="status">
                    Loading agents...
                  </div>
                ) : null}

                {agentTreeStatus === "error" ? (
                  <div className="tree-status tree-status-error" role="alert">
                    <span>{agentTreeError ?? "Failed to load agents."}</span>
                    <button type="button" onClick={() => void loadWorkspaceTree(workspace.id)}>
                      Retry
                    </button>
                  </div>
                ) : null}

                {agentTreeStatus === "empty" ? (
                  <div className="tree-status">No agents</div>
                ) : null}

                {agentTreeStatus === "ready" && !hasMainAgent ? (
                  <div className="tree-status tree-status-error" role="alert">
                    <span>Main Agent unavailable.</span>
                    <button type="button" onClick={() => void loadWorkspaceTree(workspace.id)}>
                      Repair
                    </button>
                  </div>
                ) : null}

                {agentTreeStatus === "ready" && hasMainAgent
                  ? activeWorkspaceAgents.map((agent) => (
                      <AgentNode
                        activeAgentId={activeAgentId}
                        agent={agent}
                        conversations={conversationsByAgent[agent.id] ?? []}
                        key={agent.id}
                        onSelectAgent={selectConversation}
                      />
                    ))
                  : null}
              </div>
            ) : null}

          </div>
        );
      })}

      {contextMenu && contextMenuWorkspace ? (
        <div
          className="workspace-context-menu"
          role="menu"
          style={{
            left: contextMenu.x,
            top: contextMenu.y
          }}
          onClick={(event) => event.stopPropagation()}
        >
          <button
            className="workspace-context-menu-danger"
            type="button"
            role="menuitem"
            onClick={() => void handleDeleteWorkspace()}
          >
            Delete Workspace
          </button>
        </div>
      ) : null}
    </div>
  );
}
