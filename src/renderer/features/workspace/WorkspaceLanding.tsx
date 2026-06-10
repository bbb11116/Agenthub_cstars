import { AddWorkspaceButton } from "./AddWorkspaceButton";
import { WorkspaceCreateConfirm } from "./WorkspaceCreateConfirm";
import { useWorkspaceStore } from "../../state/workspaceStore";

export function WorkspaceLanding() {
  const { error, loadWorkspaces, status } = useWorkspaceStore();

  return (
    <main className="workspace-landing-shell">
      <section className="workspace-landing" aria-label="Workspace welcome">
        <div className="workspace-landing-copy">
          <span className="eyebrow">Workspace</span>
          <h1>Welcome to AgentHub</h1>
          <p>No workspace open.</p>
        </div>

        <AddWorkspaceButton className="landing-open-button" />
        <WorkspaceCreateConfirm className="workspace-create-confirm-landing" />

        {status === "loading" ? (
          <div className="workspace-notice" role="status">
            Loading workspaces...
          </div>
        ) : null}

        {error ? (
          <div className="workspace-notice workspace-notice-error" role="alert">
            <span>{error}</span>
            <button type="button" onClick={() => void loadWorkspaces()}>
              Retry
            </button>
          </div>
        ) : null}
      </section>
    </main>
  );
}
