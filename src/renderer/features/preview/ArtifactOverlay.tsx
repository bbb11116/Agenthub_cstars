import { useEffect, useState } from "react";
import type { Artifact } from "../../../shared/artifact";
import { ArtifactViewer } from "./ArtifactViewer";

export type ArtifactOverlayMode = "preview" | "editor";

type ArtifactOverlayProps = {
  artifactId: string;
  initialMode: ArtifactOverlayMode;
  onClose: () => void;
};

type OverlayState =
  | { status: "loading"; artifact: null; error: null }
  | { status: "ready"; artifact: Artifact; error: null }
  | { status: "error"; artifact: null; error: string };

function canEditArtifact(artifact: Artifact): boolean {
  return artifact.type === "code" || artifact.type === "html" || artifact.type === "markdown";
}

function getErrorMessage(error: unknown, fallback: string): string {
  return error instanceof Error ? error.message : fallback;
}

export function ArtifactOverlay({
  artifactId,
  initialMode,
  onClose
}: ArtifactOverlayProps) {
  const [mode, setMode] = useState<ArtifactOverlayMode>(initialMode);
  const [state, setState] = useState<OverlayState>({
    status: "loading",
    artifact: null,
    error: null
  });
  const [draft, setDraft] = useState("");
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState<"save" | "diff" | null>(null);

  useEffect(() => {
    setMode(initialMode);
  }, [initialMode, artifactId]);

  useEffect(() => {
    let cancelled = false;

    async function loadArtifact(): Promise<void> {
      if (!window.agenthub?.artifact) {
        setState({ status: "error", artifact: null, error: "Artifact API unavailable." });
        return;
      }

      setState({ status: "loading", artifact: null, error: null });
      try {
        const artifact = await window.agenthub.artifact.get(artifactId);
        if (!cancelled) {
          setState({ status: "ready", artifact, error: null });
          setDraft(artifact.content);
          setNotice(null);
        }
      } catch (error) {
        if (!cancelled) {
          setState({
            status: "error",
            artifact: null,
            error: getErrorMessage(error, "Failed to load artifact.")
          });
        }
      }
    }

    void loadArtifact();
    const unsubscribe = window.agenthub?.artifact?.onRenderChanged((event) => {
      if (event.artifactId === artifactId) {
        void loadArtifact();
      }
    });

    return () => {
      cancelled = true;
      unsubscribe?.();
    };
  }, [artifactId]);

  async function handleSave(): Promise<void> {
    if (!window.agenthub?.artifact || state.status !== "ready") {
      return;
    }

    setBusy("save");
    setNotice(null);
    try {
      const updated = await window.agenthub.artifact.updateContent({
        artifactId: state.artifact.id,
        content: draft
      });
      setState({ status: "ready", artifact: updated, error: null });
      setDraft(updated.content);
      setNotice("Artifact saved.");
    } catch (error) {
      setNotice(getErrorMessage(error, "Failed to save artifact."));
    } finally {
      setBusy(null);
    }
  }

  async function handleCreateDiff(): Promise<void> {
    if (!window.agenthub?.artifact || state.status !== "ready") {
      return;
    }

    setBusy("diff");
    setNotice(null);
    try {
      const proposal = await window.agenthub.artifact.createDiff({
        artifactId: state.artifact.id
      });
      window.dispatchEvent(
        new CustomEvent("agenthub:diff-changed", {
          detail: {
            workspaceId: proposal.workspaceId,
            diffProposalId: proposal.id,
            status: proposal.status
          }
        })
      );
      window.dispatchEvent(
        new CustomEvent("agenthub:open-diff", {
          detail: {
            workspaceId: proposal.workspaceId,
            diffProposalId: proposal.id
          }
        })
      );
      setNotice("Diff proposal created.");
    } catch (error) {
      setNotice(getErrorMessage(error, "Failed to create diff proposal."));
    } finally {
      setBusy(null);
    }
  }

  const artifact = state.status === "ready" ? state.artifact : null;
  const editable = artifact ? canEditArtifact(artifact) : false;

  return (
    <div className="artifact-overlay" role="dialog" aria-modal="true" aria-label="Artifact preview">
      <div className="artifact-overlay-header">
        <div>
          <span className="eyebrow">Artifact</span>
          <h2>{artifact?.title ?? "Artifact Preview"}</h2>
          {artifact ? (
            <small>
              {artifact.type}
              {artifact.filePath ? ` - ${artifact.filePath}` : ""}
            </small>
          ) : null}
        </div>
        <div className="artifact-overlay-actions">
          <button
            type="button"
            className={mode === "preview" ? "active" : ""}
            disabled={!artifact}
            onClick={() => setMode("preview")}
          >
            Preview
          </button>
          <button
            type="button"
            className={mode === "editor" ? "active" : ""}
            disabled={!editable}
            onClick={() => setMode("editor")}
          >
            Editor
          </button>
          <button type="button" aria-label="Close artifact preview" onClick={onClose}>
            Close
          </button>
        </div>
      </div>

      {state.status === "loading" ? (
        <div className="artifact-overlay-state" role="status">
          <span className="placeholder-title">Loading</span>
          <span className="placeholder-muted">Loading artifact...</span>
        </div>
      ) : state.status === "error" ? (
        <div className="artifact-overlay-state workspace-error" role="alert">
          <span>{state.error}</span>
        </div>
      ) : mode === "editor" && editable ? (
        <div className="artifact-editor">
          <textarea
            value={draft}
            spellCheck={false}
            aria-label="Artifact editor"
            onChange={(event) => setDraft(event.target.value)}
          />
          <div className="artifact-editor-actions">
            {notice ? <span>{notice}</span> : <span />}
            <button type="button" disabled={busy === "save"} onClick={() => void handleSave()}>
              {busy === "save" ? "Saving..." : "Save Artifact"}
            </button>
            <button
              type="button"
              disabled={!state.artifact.filePath || busy === "diff"}
              onClick={() => void handleCreateDiff()}
            >
              {busy === "diff" ? "Creating..." : "Generate Diff"}
            </button>
          </div>
        </div>
      ) : (
        <div className="artifact-overlay-preview">
          <ArtifactViewer
            artifact={state.artifact}
            onArtifactUpdated={(updated) =>
              setState({ status: "ready", artifact: updated, error: null })
            }
          />
          {notice ? <p className="artifact-overlay-notice">{notice}</p> : null}
        </div>
      )}
    </div>
  );
}
