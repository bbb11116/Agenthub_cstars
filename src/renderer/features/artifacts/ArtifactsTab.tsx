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

function isRuntimeContractWrapperContent(content: string): boolean {
  const compact = content.replace(/\s+/g, " ").trim();
  return (
    /(?:The user asked|this round I am only asked|tool has returned|No further tool calls|required|runtime contract|completion result)/i.test(compact) &&
    /(?:create_artifact|artifactIds|artifactId|outputs|evidence|policy_check|create_artifact_response)/i.test(compact)
  );
}

function isProcessOnlyContent(content: string): boolean {
  const compact = content.replace(/\s+/g, " ").trim();
  if (!compact || compact.length > 220) {
    return false;
  }

  return /^(?:let me|i(?:'ll| will| am going to)|getting|checking|fetching|searching|now I|okay|sure|好的|我来|我将|正在|继续|先查|先获取|让我)/i.test(compact);
}

function isPlaceholderContent(content: string): boolean {
  const compact = content.replace(/\s+/g, " ").trim();
  if (!compact) {
    return true;
  }

  if (compact.length > 320) {
    return false;
  }

  return /(?:已创建|创建完成|成功创建|已生成|生成完成|继续生成|正在生成|artifact 已成功创建|previewArtifact|PPT 已创建|HTML 已创建|报告已创建|created|continue generating|placeholder)/i.test(compact);
}

function isDebugArtifact(artifact: Artifact): boolean {
  if (artifact.metadata?.official === false) {
    return true;
  }

  if (
    artifact.metadata?.origin === "synthetic_wrapper" ||
    artifact.metadata?.origin === "intermediate"
  ) {
    return true;
  }

  if (artifact.metadata?.origin === "fallback_parse_dump" && artifact.metadata.official !== true) {
    return true;
  }

  if (artifact.type !== "markdown") {
    return false;
  }

  const stepDeliverableTitle = /\bStep\s+\d+\s+Deliverable\b/i.test(artifact.title);
  if (isRuntimeContractWrapperContent(artifact.content)) {
    return true;
  }

  return stepDeliverableTitle && (isProcessOnlyContent(artifact.content) || isPlaceholderContent(artifact.content));
}

export function ArtifactsTab({ activeArtifactId, onOpenArtifact }: ArtifactsTabProps) {
  const { activeWorkspace } = useWorkspaceStore();
  const [showDebugArtifacts, setShowDebugArtifacts] = useState(false);
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

  const visibleArtifacts = showDebugArtifacts
    ? artifactState.artifacts
    : artifactState.artifacts.filter((artifact) => !isDebugArtifact(artifact));

  if (visibleArtifacts.length === 0) {
    return (
      <div className="artifacts-tab inspector-content" aria-label="Artifacts">
        <label className="artifact-debug-toggle">
          <input
            type="checkbox"
            checked={showDebugArtifacts}
            onChange={(event) => setShowDebugArtifacts(event.currentTarget.checked)}
          />
          <span>Show debug artifacts</span>
        </label>
        <div className="placeholder-block">
          <span className="placeholder-title">No Deliverables</span>
          <span className="placeholder-muted">Only intermediate artifacts are available.</span>
        </div>
      </div>
    );
  }

  return (
    <div className="artifacts-tab inspector-content" aria-label="Artifacts">
      <label className="artifact-debug-toggle">
        <input
          type="checkbox"
          checked={showDebugArtifacts}
          onChange={(event) => setShowDebugArtifacts(event.currentTarget.checked)}
        />
        <span>Show debug artifacts</span>
      </label>
      <div className="artifact-list">
        {visibleArtifacts.map((artifact) => {
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
