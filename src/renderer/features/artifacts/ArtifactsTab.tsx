import { useEffect, useState } from "react";
import type { Artifact, ArtifactTabState } from "../../../shared/artifact";
import { useWorkspaceStore } from "../../state/workspaceStore";

type ArtifactsTabProps = {
  activeArtifactId: string | null;
  onOpenArtifact: (artifact: Artifact) => void;
};

type ArtifactsTabViewState = ArtifactTabState & {
  loading: boolean;
  error: string | null;
};

const initialArtifactsTabState: ArtifactsTabViewState = {
  artifacts: [],
  activeArtifactId: null,
  loading: false,
  error: null
};

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "Failed to load artifacts.";
}

function formatArtifactType(type: Artifact["type"]): string {
  switch (type) {
    case "html":
      return "HTML";
    case "markdown":
      return "Markdown";
    case "diff":
      return "Diff";
    case "document":
      return "Document";
    case "presentation":
      return "Presentation";
    case "pdf":
      return "PDF";
    case "code":
      return "Code";
  }
}

export function ArtifactsTab({ activeArtifactId, onOpenArtifact }: ArtifactsTabProps) {
  const { activeWorkspace } = useWorkspaceStore();
  const [artifactState, setArtifactState] = useState<ArtifactsTabViewState>({
    ...initialArtifactsTabState,
    activeArtifactId
  });

  useEffect(() => {
    setArtifactState((currentState) => ({
      ...currentState,
      activeArtifactId
    }));
  }, [activeArtifactId]);

  useEffect(() => {
    let cancelled = false;

    async function loadArtifacts(workspaceId: string): Promise<void> {
      if (!window.agenthub?.artifact) {
        setArtifactState({
          ...initialArtifactsTabState,
          activeArtifactId,
          error: "Artifact API unavailable."
        });
        return;
      }

      setArtifactState({
        ...initialArtifactsTabState,
        activeArtifactId,
        loading: true
      });

      try {
        const artifacts = await window.agenthub.artifact.listByWorkspace(workspaceId);

        if (cancelled) {
          return;
        }

        setArtifactState({
          artifacts,
          activeArtifactId,
          loading: false,
          error: null
        });
      } catch (error) {
        if (cancelled) {
          return;
        }

        setArtifactState({
          ...initialArtifactsTabState,
          activeArtifactId,
          error: getErrorMessage(error)
        });
      }
    }

    if (!activeWorkspace) {
      setArtifactState({
        ...initialArtifactsTabState,
        activeArtifactId: null
      });
      return;
    }

    void loadArtifacts(activeWorkspace.id);

    return () => {
      cancelled = true;
    };
  }, [activeArtifactId, activeWorkspace?.id]);

  useEffect(() => {
    if (!activeWorkspace || !window.agenthub?.artifact) {
      return;
    }

    const workspaceId = activeWorkspace.id;

    function handleArtifactsChanged(event: Event): void {
      const detail = (event as CustomEvent<{ workspaceId?: string }>).detail;

      if (detail?.workspaceId !== workspaceId || !window.agenthub?.artifact) {
        return;
      }

      setArtifactState((currentState) => ({
        ...currentState,
        loading: true,
        error: null
      }));

      void window.agenthub.artifact
        .listByWorkspace(workspaceId)
        .then((artifacts: Artifact[]) => {
          setArtifactState((currentState) => ({
            ...currentState,
            artifacts,
            loading: false
          }));
        })
        .catch((error: unknown) => {
          setArtifactState((currentState) => ({
            ...currentState,
            loading: false,
            error: getErrorMessage(error)
          }));
        });
    }

    window.addEventListener("agenthub:artifacts-changed", handleArtifactsChanged);

    return () => {
      window.removeEventListener("agenthub:artifacts-changed", handleArtifactsChanged);
    };
  }, [activeWorkspace?.id]);

  if (!activeWorkspace) {
    return (
      <div className="placeholder-block inspector-content">
        <span className="placeholder-title">No Workspace</span>
        <span className="placeholder-muted">Open a workspace to view Agent artifacts.</span>
      </div>
    );
  }

  if (artifactState.loading) {
    return (
      <div className="placeholder-block inspector-content" role="status">
        <span className="placeholder-title">Loading</span>
        <span className="placeholder-muted">Loading artifacts...</span>
      </div>
    );
  }

  if (artifactState.error) {
    return (
      <div className="workspace-error inspector-content" role="alert">
        <span>{artifactState.error}</span>
      </div>
    );
  }

  if (artifactState.artifacts.length === 0) {
    return (
      <div className="placeholder-block inspector-content">
        <span className="placeholder-title">No Artifacts</span>
        <span className="placeholder-muted">Agent outputs will appear here.</span>
      </div>
    );
  }

  return (
    <div className="artifacts-tab inspector-content" aria-label="Artifacts">
      <div className="artifact-list">
        {artifactState.artifacts.map((artifact) => {
          const subtitle = `${formatArtifactType(artifact.type)}${artifact.filePath ? ` - ${artifact.filePath}` : ""}`;
          return (
            <button
              key={artifact.id}
              className={artifact.id === artifactState.activeArtifactId ? "active" : ""}
              type="button"
              title={subtitle}
              onClick={() => {
                setArtifactState((currentState) => ({
                  ...currentState,
                  activeArtifactId: artifact.id
                }));
                onOpenArtifact(artifact);
              }}
            >
              <span>{artifact.title}</span>
            </button>
          );
        })}
      </div>
    </div>
  );
}
