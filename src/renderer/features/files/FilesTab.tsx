import { useEffect, useState } from "react";
import type { FileContent, FileTreeNode, FileTreeState } from "../../../shared/file";
import { useWorkspaceStore } from "../../state/workspaceStore";
import { FileTree } from "./FileTree";
import { FileViewer } from "./FileViewer";

type FilesTabState = FileTreeState & {
  contentLoading: boolean;
  contentError?: string;
};

const initialFilesTabState: FilesTabState = {
  nodes: [],
  selectedFilePath: null,
  selectedFileContent: null,
  loading: false,
  contentLoading: false
};

function getErrorMessage(error: unknown, fallbackMessage: string): string {
  return error instanceof Error ? error.message : fallbackMessage;
}

export function FilesTab() {
  const { activeConversation, activeWorkspace } = useWorkspaceStore();
  const [filesState, setFilesState] = useState<FilesTabState>(initialFilesTabState);

  useEffect(() => {
    let cancelled = false;

    async function loadFileTree(workspaceId: string): Promise<void> {
      if (!window.agenthub?.file) {
        setFilesState({
          ...initialFilesTabState,
          error: "File API unavailable"
        });
        return;
      }

      setFilesState({
        ...initialFilesTabState,
        loading: true
      });

      try {
        const nodes = await window.agenthub.file.tree({
          workspaceId,
          conversationId: activeConversation?.id
        });

        if (cancelled) {
          return;
        }

        setFilesState({
          ...initialFilesTabState,
          nodes,
          loading: false
        });
      } catch (error) {
        if (cancelled) {
          return;
        }

        setFilesState({
          ...initialFilesTabState,
          loading: false,
          error: getErrorMessage(error, "Failed to load files.")
        });
      }
    }

    if (!activeWorkspace) {
      setFilesState(initialFilesTabState);
      return;
    }

    void loadFileTree(activeWorkspace.id);

    return () => {
      cancelled = true;
    };
  }, [activeConversation?.id, activeWorkspace?.id]);

  async function readFile(relativePath: string): Promise<void> {
    if (!activeWorkspace) {
      return;
    }

    if (!window.agenthub?.file) {
      setFilesState((currentState) => ({
        ...currentState,
        selectedFilePath: relativePath,
        selectedFileContent: null,
        contentLoading: false,
        contentError: "File API unavailable"
      }));
      return;
    }

    setFilesState((currentState) => ({
      ...currentState,
      selectedFilePath: relativePath,
      selectedFileContent: null,
      contentLoading: true,
      contentError: undefined
    }));

    try {
      const content: FileContent = await window.agenthub.file.read({
        workspaceId: activeWorkspace.id,
        conversationId: activeConversation?.id,
        relativePath
      });

      setFilesState((currentState) => {
        if (currentState.selectedFilePath !== relativePath) {
          return currentState;
        }

        return {
          ...currentState,
          selectedFileContent: content,
          contentLoading: false
        };
      });
    } catch (error) {
      setFilesState((currentState) => {
        if (currentState.selectedFilePath !== relativePath) {
          return currentState;
        }

        return {
          ...currentState,
          selectedFileContent: null,
          contentLoading: false,
          contentError: getErrorMessage(error, "Failed to read file.")
        };
      });
    }
  }

  function retryLoad(): void {
    if (!activeWorkspace || !window.agenthub?.file) {
      return;
    }

    setFilesState((currentState) => ({
      ...currentState,
      loading: true,
      error: undefined
    }));

    void window.agenthub.file
      .tree({ workspaceId: activeWorkspace.id, conversationId: activeConversation?.id })
      .then((nodes: FileTreeNode[]) => {
        setFilesState({
          ...initialFilesTabState,
          nodes
        });
      })
      .catch((error: unknown) => {
        setFilesState({
          ...initialFilesTabState,
          error: getErrorMessage(error, "Failed to load files.")
        });
      });
  }

  useEffect(() => {
    if (!activeWorkspace || !window.agenthub?.file) {
      return;
    }

    const workspaceId = activeWorkspace.id;

    function handleFilesChanged(event: Event): void {
      const detail = (event as CustomEvent<{ workspaceId?: string; filePath?: string }>)
        .detail;

      if (detail?.workspaceId !== workspaceId || !window.agenthub?.file) {
        return;
      }

      setFilesState((currentState) => ({
        ...currentState,
        loading: true,
        error: undefined
      }));

      void window.agenthub.file
        .tree({ workspaceId, conversationId: activeConversation?.id })
        .then((nodes: FileTreeNode[]) => {
          setFilesState((currentState) => ({
            ...currentState,
            nodes,
            loading: false
          }));
        })
        .catch((error: unknown) => {
          setFilesState((currentState) => ({
            ...currentState,
            loading: false,
            error: getErrorMessage(error, "Failed to load files.")
          }));
        });

      if (detail.filePath && detail.filePath === filesState.selectedFilePath) {
        void readFile(detail.filePath);
      }
    }

    window.addEventListener("agenthub:files-changed", handleFilesChanged);

    return () => {
      window.removeEventListener("agenthub:files-changed", handleFilesChanged);
    };
  }, [activeConversation?.id, activeWorkspace?.id, filesState.selectedFilePath]);

  if (!activeWorkspace) {
    return (
      <div className="placeholder-block inspector-content">
        <span className="placeholder-title">No Workspace</span>
        <span className="placeholder-muted">Open a workspace to browse files.</span>
      </div>
    );
  }

  if (filesState.loading) {
    return (
      <div className="placeholder-block inspector-content">
        <span className="placeholder-title">Loading</span>
        <span className="placeholder-muted">Reading workspace files...</span>
      </div>
    );
  }

  if (filesState.error) {
    return (
      <div className="workspace-error inspector-content" role="alert">
        <span>{filesState.error}</span>
        <button type="button" onClick={retryLoad}>
          Retry
        </button>
      </div>
    );
  }

  if (filesState.nodes.length === 0) {
    return (
      <div className="placeholder-block inspector-content">
        <span className="placeholder-title">No Files</span>
        <span className="placeholder-muted">This workspace has no previewable file entries.</span>
      </div>
    );
  }

  return (
    <div className="files-tab inspector-content">
      <div className="files-tree-pane">
        <FileTree
          nodes={filesState.nodes}
          selectedFilePath={filesState.selectedFilePath}
          onSelectFile={(relativePath) => void readFile(relativePath)}
        />
      </div>
      <FileViewer
        content={filesState.selectedFileContent}
        error={filesState.contentError}
        loading={filesState.contentLoading}
        selectedFilePath={filesState.selectedFilePath}
      />
    </div>
  );
}
