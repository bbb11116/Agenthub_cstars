import { useWorkspaceStore } from "../../state/workspaceStore";

type WorkspaceCreateConfirmProps = {
  className?: string;
};

export function WorkspaceCreateConfirm({ className }: WorkspaceCreateConfirmProps) {
  const {
    cancelWorkspaceCreate,
    createWorkspaceFromDraft,
    error,
    isCreatingWorkspace,
    openExistingWorkspace,
    updateWorkspaceCreateName,
    workspaceCreateDraft
  } = useWorkspaceStore();

  if (!workspaceCreateDraft) {
    return null;
  }

  const canCreate = !isCreatingWorkspace;
  const shellClassName = className
    ? `workspace-create-confirm ${className}`
    : "workspace-create-confirm";

  if (workspaceCreateDraft.existingWorkspace) {
    return (
      <section className={shellClassName} aria-label="Existing workspace">
        <div className="workspace-create-header">
          <span className="eyebrow">Workspace</span>
          <h2>Workspace already exists</h2>
        </div>
        <dl className="workspace-create-details">
          <div>
            <dt>Name</dt>
            <dd>{workspaceCreateDraft.existingWorkspace.name}</dd>
          </div>
          <div>
            <dt>Local Path</dt>
            <dd>{workspaceCreateDraft.rootPath}</dd>
          </div>
        </dl>
        {error ? (
          <div className="workspace-notice workspace-notice-error" role="alert">
            {error}
          </div>
        ) : null}
        <div className="workspace-create-actions">
          <button
            className="workspace-create-primary"
            type="button"
            disabled={isCreatingWorkspace}
            onClick={() => {
              void openExistingWorkspace(workspaceCreateDraft.existingWorkspace!.id);
            }}
          >
            {isCreatingWorkspace ? "Opening..." : "Open Existing"}
          </button>
          <button type="button" onClick={cancelWorkspaceCreate}>
            Cancel
          </button>
        </div>
      </section>
    );
  }

  return (
    <section className={shellClassName} aria-label="Create workspace">
      <div className="workspace-create-header">
        <span className="eyebrow">Create Workspace</span>
        <h2>Confirm Workspace</h2>
      </div>

      <label className="workspace-create-field">
        <span>Workspace Name</span>
        <input
          type="text"
          value={workspaceCreateDraft.inferredWorkspaceName}
          onChange={(event) => updateWorkspaceCreateName(event.target.value)}
        />
      </label>

      <dl className="workspace-create-details">
        <div>
          <dt>Local Path</dt>
          <dd>{workspaceCreateDraft.rootPath}</dd>
        </div>
        <div>
          <dt>Git Enabled</dt>
          <dd>{workspaceCreateDraft.gitEnabled ? "Yes" : "No"}</dd>
        </div>
      </dl>

      <div className="runtime-choice-list" role="radiogroup" aria-label="Main Agent Runtime">
        <span className="runtime-choice-title">Main Agent (Orchestrator)</span>
        <button
          className="runtime-choice selected"
          type="button"
          role="radio"
          aria-checked={true}
          disabled
        >
          <span>
            <strong>Built-in Orchestrator</strong>
            <small>Powered by your configured Model Provider</small>
          </span>
          <em className="runtime-choice-on">Always Available</em>
        </button>
      </div>

      {error ? (
        <div className="workspace-notice workspace-notice-error" role="alert">
          {error}
        </div>
      ) : null}

      <div className="workspace-create-actions">
        <button
          className="workspace-create-primary"
          type="button"
          disabled={!canCreate}
          onClick={() => {
            void createWorkspaceFromDraft();
          }}
        >
          {isCreatingWorkspace ? "Creating..." : "Create Workspace"}
        </button>
        <button type="button" disabled={isCreatingWorkspace} onClick={cancelWorkspaceCreate}>
          Cancel
        </button>
      </div>
    </section>
  );
}
