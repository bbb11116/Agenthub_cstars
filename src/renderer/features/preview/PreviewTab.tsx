import { useEffect, useState } from "react";
import type { Artifact } from "../../../shared/artifact";
import { ArtifactViewer } from "./ArtifactViewer";

type PreviewTabProps = {
  artifactId: string | null;
  onOpenDiff: () => void;
};

type PreviewTabState =
  | { status: "empty"; artifact: null; error: null }
  | { status: "loading"; artifact: null; error: null }
  | { status: "ready"; artifact: Artifact; error: null }
  | { status: "error"; artifact: null; error: string };

function getErrorMessage(error: unknown): string {
  if (error instanceof Error && error.message.trim() === "Not found") {
    return "Not found";
  }

  return error instanceof Error ? error.message : "Failed to load artifact.";
}

function formatBytes(content: string): string {
  const size = new Blob([content]).size;

  if (size < 1024) {
    return `${size} B`;
  }

  if (size < 1024 * 1024) {
    return `${(size / 1024).toFixed(1)} KB`;
  }

  return `${(size / (1024 * 1024)).toFixed(1)} MB`;
}

export function PreviewTab({ artifactId, onOpenDiff }: PreviewTabProps) {
  const [previewState, setPreviewState] = useState<PreviewTabState>({
    status: "empty",
    artifact: null,
    error: null
  });

  useEffect(() => {
    let cancelled = false;

    async function loadArtifact(id: string): Promise<void> {
      if (!window.agenthub?.artifact) {
        setPreviewState({
          status: "error",
          artifact: null,
          error: "Artifact API unavailable."
        });
        return;
      }

      setPreviewState({
        status: "loading",
        artifact: null,
        error: null
      });

      try {
        const artifact = await window.agenthub.artifact.get(id);

        if (cancelled) {
          return;
        }

        setPreviewState({
          status: "ready",
          artifact,
          error: null
        });
      } catch (error) {
        if (cancelled) {
          return;
        }

        setPreviewState({
          status: "error",
          artifact: null,
          error: getErrorMessage(error)
        });
      }
    }

    if (!artifactId) {
      setPreviewState({
        status: "empty",
        artifact: null,
        error: null
      });
      return;
    }

    void loadArtifact(artifactId);

    return () => {
      cancelled = true;
    };
  }, [artifactId]);

  if (previewState.status === "empty") {
    return (
      <div className="placeholder-block inspector-content">
        <span className="placeholder-title">No Preview Artifact</span>
        <span className="placeholder-muted">无预览产物。</span>
      </div>
    );
  }

  if (previewState.status === "loading") {
    return (
      <div className="placeholder-block inspector-content" role="status">
        <span className="placeholder-title">Loading</span>
        <span className="placeholder-muted">Loading artifact preview...</span>
      </div>
    );
  }

  if (previewState.status === "error") {
    return (
      <div className="workspace-error inspector-content" role="alert">
        <span>{previewState.error}</span>
      </div>
    );
  }

  const artifact = previewState.artifact;

  if (artifact.type === "diff") {
    return (
      <section className="preview-tab inspector-content" aria-label="Artifact preview">
        <header className="preview-header">
          <div>
            <span>{artifact.title}</span>
            <small>Diff artifact</small>
          </div>
          <button type="button" onClick={onOpenDiff}>
            Open Diff
          </button>
        </header>
        <div className="preview-empty-state">
          <span className="placeholder-title">Diff Artifact</span>
          <span className="placeholder-muted">Open the Diff tab to review and apply changes.</span>
        </div>
      </section>
    );
  }

  return (
    <section className="preview-tab inspector-content" aria-label="Artifact preview">
      <header className="preview-header">
        <div>
          <span>{artifact.title}</span>
          <small>
            {artifact.type}
            {artifact.language ? ` - ${artifact.language}` : ""}
            {artifact.filePath ? ` - ${artifact.filePath}` : ""}
            {` - v${artifact.version} - ${formatBytes(artifact.content)}`}
          </small>
        </div>
      </header>

      <ArtifactViewer
        artifact={artifact}
        scaled
        onArtifactUpdated={(updated) =>
          setPreviewState({ status: "ready", artifact: updated, error: null })
        }
        onOpenDiff={onOpenDiff}
      />
    </section>
  );
}
