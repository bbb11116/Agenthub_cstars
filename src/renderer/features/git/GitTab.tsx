import { useEffect, useState } from "react";
import type { GitDiff, GitStatus, GitTabState } from "../../../shared/git";
import { useWorkspaceStore } from "../../state/workspaceStore";
import { GitDiffViewer } from "./GitDiffViewer";
import { GitStatusList } from "./GitStatusList";

type ExtendedGitTabState = GitTabState & {
  error?: string;
  diffLoading: boolean;
  diffError?: string;
  diffTruncated: boolean;
};

const initialGitTabState: ExtendedGitTabState = {
  status: null,
  selectedFilePath: null,
  diff: null,
  loading: false,
  diffLoading: false,
  diffTruncated: false
};

function getErrorMessage(error: unknown, fallbackMessage: string): string {
  return error instanceof Error ? error.message : fallbackMessage;
}

export function GitTab() {
  const { activeConversation, activeWorkspace } = useWorkspaceStore();
  const [gitState, setGitState] = useState<ExtendedGitTabState>(initialGitTabState);

  useEffect(() => {
    let cancelled = false;

    async function loadGitStatus(workspaceId: string): Promise<void> {
      if (!window.agenthub?.git) {
        setGitState({
          ...initialGitTabState,
          error: "Git API unavailable"
        });
        return;
      }

      setGitState({
        ...initialGitTabState,
        loading: true
      });

      try {
        const status: GitStatus = await window.agenthub.git.status({
          workspaceId,
          conversationId: activeConversation?.id
        });

        if (cancelled) {
          return;
        }

        setGitState({
          ...initialGitTabState,
          status
        });
      } catch (error) {
        if (cancelled) {
          return;
        }

        setGitState({
          ...initialGitTabState,
          error: getErrorMessage(error, "Failed to read Git status.")
        });
      }
    }

    if (!activeWorkspace) {
      setGitState(initialGitTabState);
      return;
    }

    void loadGitStatus(activeWorkspace.id);

    return () => {
      cancelled = true;
    };
  }, [activeConversation?.id, activeWorkspace?.id]);

  async function refreshStatus(): Promise<void> {
    if (!activeWorkspace || !window.agenthub?.git) {
      return;
    }

    setGitState((currentState) => ({
      ...currentState,
      loading: true,
      error: undefined
    }));

    try {
      const status = await window.agenthub.git.status({
        workspaceId: activeWorkspace.id,
        conversationId: activeConversation?.id
      });

      setGitState((currentState) => ({
        ...currentState,
        status,
        selectedFilePath: null,
        diff: null,
        loading: false,
        diffError: undefined,
        diffLoading: false,
        diffTruncated: false
      }));
    } catch (error) {
      setGitState((currentState) => ({
        ...currentState,
        loading: false,
        error: getErrorMessage(error, "Failed to read Git status.")
      }));
    }
  }

  async function readDiff(filePath?: string): Promise<void> {
    if (!activeWorkspace || !window.agenthub?.git) {
      return;
    }

    const selectedFilePath = filePath ?? null;

    setGitState((currentState) => ({
      ...currentState,
      selectedFilePath,
      diff: null,
      diffLoading: true,
      diffError: undefined,
      diffTruncated: false
    }));

    try {
      const diff: GitDiff = await window.agenthub.git.diff({
        workspaceId: activeWorkspace.id,
        conversationId: activeConversation?.id,
        filePath
      });

      setGitState((currentState) => {
        if (currentState.selectedFilePath !== selectedFilePath) {
          return currentState;
        }

        return {
          ...currentState,
          diff: diff.diff,
          diffLoading: false,
          diffTruncated: diff.truncated ?? false
        };
      });
    } catch (error) {
      setGitState((currentState) => {
        if (currentState.selectedFilePath !== selectedFilePath) {
          return currentState;
        }

        return {
          ...currentState,
          diff: null,
          diffLoading: false,
          diffError: getErrorMessage(error, "Failed to read Git diff.")
        };
      });
    }
  }

  useEffect(() => {
    if (!activeWorkspace || !window.agenthub?.git) {
      return;
    }

    const workspaceId = activeWorkspace.id;

    function handleGitChanged(event: Event): void {
      const detail = (event as CustomEvent<{ workspaceId?: string; gitStatus?: GitStatus }>)
        .detail;

      if (detail?.workspaceId !== workspaceId) {
        return;
      }

      if (detail.gitStatus) {
        setGitState((currentState) => ({
          ...currentState,
          status: detail.gitStatus ?? currentState.status,
          selectedFilePath: null,
          diff: null,
          loading: false,
          diffError: undefined,
          diffLoading: false,
          diffTruncated: false
        }));
        return;
      }

      if (!window.agenthub?.git) {
        return;
      }

      setGitState((currentState) => ({
        ...currentState,
        loading: true,
        error: undefined
      }));

      void window.agenthub.git
        .status({ workspaceId, conversationId: activeConversation?.id })
        .then((status: GitStatus) => {
          setGitState((currentState) => ({
            ...currentState,
            status,
            selectedFilePath: null,
            diff: null,
            loading: false,
            diffError: undefined,
            diffLoading: false,
            diffTruncated: false
          }));
        })
        .catch((error: unknown) => {
          setGitState((currentState) => ({
            ...currentState,
            loading: false,
            error: getErrorMessage(error, "Failed to read Git status.")
          }));
        });
    }

    window.addEventListener("agenthub:git-changed", handleGitChanged);

    return () => {
      window.removeEventListener("agenthub:git-changed", handleGitChanged);
    };
  }, [activeConversation?.id, activeWorkspace?.id]);

  if (!activeWorkspace) {
    return (
      <div className="placeholder-block inspector-content">
        <span className="placeholder-title">No Workspace</span>
        <span className="placeholder-muted">Open a workspace to inspect Git status.</span>
      </div>
    );
  }

  if (gitState.loading && !gitState.status) {
    return (
      <div className="placeholder-block inspector-content" role="status">
        <span className="placeholder-title">Loading</span>
        <span className="placeholder-muted">Reading Git status...</span>
      </div>
    );
  }

  if (gitState.error) {
    return (
      <div className="workspace-error inspector-content" role="alert">
        <span>{gitState.error}</span>
        <button type="button" onClick={() => void refreshStatus()}>
          Retry
        </button>
      </div>
    );
  }

  if (!gitState.status?.isGitRepo) {
    return (
      <div className="placeholder-block inspector-content">
        <span className="placeholder-title">Git Not Initialized</span>
        <span className="placeholder-muted">This workspace is not a Git repository.</span>
      </div>
    );
  }

  return (
    <div className="git-tab inspector-content">
      <div className="git-tab-toolbar">
        <div className="git-branch">
          <span>Branch</span>
          <code>{gitState.status.branch ?? "Detached HEAD"}</code>
        </div>
        <div className="git-actions">
          <button
            disabled={gitState.loading}
            type="button"
            onClick={() => void refreshStatus()}
          >
            {gitState.loading ? "Refreshing" : "Refresh"}
          </button>
          <button
            disabled={gitState.diffLoading}
            type="button"
            onClick={() => void readDiff()}
          >
            View Full Diff
          </button>
        </div>
      </div>

      <div className="git-tab-body">
        <GitStatusList
          files={gitState.status.files}
          selectedFilePath={gitState.selectedFilePath}
          onSelectFile={(filePath) => void readDiff(filePath)}
        />
        <GitDiffViewer
          diff={gitState.diff}
          error={gitState.diffError}
          filePath={gitState.selectedFilePath}
          loading={gitState.diffLoading}
          truncated={gitState.diffTruncated}
        />
      </div>
    </div>
  );
}
