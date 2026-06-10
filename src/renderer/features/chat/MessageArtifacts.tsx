import { useEffect, useState } from "react";
import type { Artifact, ArtifactPreviewPayload } from "../../../shared/artifact";
import type {
  CommandResultPayload,
  DiffProposalFile,
  DiffProposalPayload,
  ErrorPayload,
  FileReferencePayload,
  MessageArtifact
} from "../../../shared/agentRunEvent";
import { ArtifactViewer } from "../preview/ArtifactViewer";

type ArtifactRendererProps = {
  artifact: MessageArtifact;
};

const MAX_DIFF_LINES = 200;

function truncate(text: string, max: number): string {
  if (text.length <= max) {
    return text;
  }
  return `${text.slice(0, max).trimEnd()}\n...`;
}

export function DiffProposalCard({ artifact }: ArtifactRendererProps) {
  const payload = artifact.payload as DiffProposalPayload;
  const [isExpanded, setIsExpanded] = useState(false);
  if (!payload.files || payload.files.length === 0) {
    return null;
  }
  return (
    <div className="diff-proposal-card" data-artifact-type="diff_proposal">
      <header>
        <span className="diff-proposal-card-kind">Diff Proposal</span>
        <code className="diff-proposal-card-id">{payload.proposalId}</code>
        <span className="diff-proposal-card-count">
          {payload.files.length} file{payload.files.length === 1 ? "" : "s"}
        </span>
      </header>
      {payload.files.map((file) => (
        <DiffProposalFileView
          key={`${payload.proposalId}:${file.path}`}
          file={file}
          isExpanded={isExpanded}
        />
      ))}
      <div className="diff-proposal-card-actions">
        <button type="button" onClick={() => setIsExpanded((v) => !v)}>
          {isExpanded ? "Collapse" : "Show full diff"}
        </button>
      </div>
    </div>
  );
}

function DiffProposalFileView({
  file,
  isExpanded
}: {
  file: DiffProposalFile;
  isExpanded: boolean;
}) {
  const text = file.unifiedDiff;
  const visible = isExpanded ? text : truncate(text, MAX_DIFF_LINES);
  return (
    <section className="diff-proposal-card-file">
      <header>
        <span className={`diff-status diff-status-${file.status}`}>{file.status}</span>
        <code className="diff-path">{file.path}</code>
      </header>
      <pre className="diff-proposal-card-diff">
        <code>{visible}</code>
      </pre>
    </section>
  );
}

export function CommandResultCard({ artifact }: ArtifactRendererProps) {
  const payload = artifact.payload as CommandResultPayload;
  return (
    <div className="command-result-card" data-artifact-type="command_result">
      <header>
        <span className="command-result-kind">Command</span>
        <code className="command-result-cmd">{payload.command}</code>
        <span className="command-result-exit">
          exit {payload.exitCode === null ? "?" : payload.exitCode}
        </span>
      </header>
      {payload.stdout ? (
        <section>
          <h5>stdout</h5>
          <pre>
            <code>{payload.stdout}</code>
          </pre>
        </section>
      ) : null}
      {payload.stderr ? (
        <section>
          <h5>stderr</h5>
          <pre>
            <code>{payload.stderr}</code>
          </pre>
        </section>
      ) : null}
    </div>
  );
}

export function FileReferenceCard({ artifact }: ArtifactRendererProps) {
  const payload = artifact.payload as FileReferencePayload;
  return (
    <div className="file-reference-card" data-artifact-type="file_reference">
      <header>
        <span className="file-reference-kind">File</span>
        <code className="file-reference-path">{payload.path}</code>
        {payload.range ? <span className="file-reference-range">{payload.range}</span> : null}
      </header>
      {payload.reason ? <p>{payload.reason}</p> : null}
    </div>
  );
}

export function ErrorCard({ artifact }: ArtifactRendererProps) {
  const payload = artifact.payload as ErrorPayload;
  return (
    <div className="error-card" data-artifact-type="error">
      <header>
        <span className="error-kind">Error</span>
        {payload.code ? <code className="error-code">{payload.code}</code> : null}
      </header>
      <p>{payload.message}</p>
    </div>
  );
}

export function ArtifactPreviewCard({ artifact }: ArtifactRendererProps) {
  const payload = artifact.payload as ArtifactPreviewPayload;
  const [previewArtifact, setPreviewArtifact] = useState<Artifact | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;

    async function loadArtifact(): Promise<void> {
      if (!window.agenthub?.artifact) {
        setLoadError("Artifact API unavailable.");
        return;
      }

      try {
        const loaded = await window.agenthub.artifact.get(payload.artifactId);
        if (!cancelled) {
          setPreviewArtifact(loaded);
          setLoadError(null);
        }
      } catch (error) {
        if (!cancelled) {
          setLoadError(error instanceof Error ? error.message : "Failed to load artifact.");
        }
      }
    }

    void loadArtifact();
    const unsubscribe = window.agenthub?.artifact?.onRenderChanged((event) => {
      if (event.artifactId === payload.artifactId) {
        void loadArtifact();
      }
    });

    return () => {
      cancelled = true;
      unsubscribe?.();
    };
  }, [payload.artifactId]);

  function openOverlay(mode: "preview" | "editor" = "preview"): void {
    window.dispatchEvent(
      new CustomEvent("agenthub:open-artifact-overlay", {
        detail: {
          artifactId: payload.artifactId,
          mode
        }
      })
    );
  }

  const artifactForStatus = previewArtifact;
  const renderStatus = artifactForStatus?.render?.status ?? payload.renderStatus;
  const canEdit =
    artifactForStatus?.type === "code" ||
    artifactForStatus?.type === "html" ||
    artifactForStatus?.type === "markdown";

  return (
    <article
      className="artifact-preview-card"
      data-artifact-type="artifact_preview"
      onClick={() => openOverlay("preview")}
    >
      <header className="artifact-preview-card-header">
        <div>
          <span className="artifact-preview-card-kind">Artifact</span>
          <strong>{artifactForStatus?.title ?? payload.title}</strong>
          <small>
            {artifactForStatus?.type ?? payload.artifactType}
            {artifactForStatus?.filePath ?? payload.filePath
              ? ` - ${artifactForStatus?.filePath ?? payload.filePath}`
              : ""}
          </small>
        </div>
        <span className={`artifact-preview-status artifact-preview-status-${renderStatus}`}>
          {renderStatus}
        </span>
      </header>
      <div className="artifact-preview-card-body">
        {loadError ? (
          <p className="artifact-preview-error">{loadError}</p>
        ) : previewArtifact ? (
          <ArtifactViewer artifact={previewArtifact} compact onArtifactUpdated={setPreviewArtifact} />
        ) : (
          <div className="preview-empty-state">
            <span className="placeholder-title">Loading</span>
            <span className="placeholder-muted">Loading artifact preview...</span>
          </div>
        )}
      </div>
      <div className="artifact-preview-actions">
        <button
          type="button"
          onClick={(event) => {
            event.stopPropagation();
            openOverlay("preview");
          }}
        >
          Open Preview
        </button>
        {canEdit ? (
          <button
            type="button"
            onClick={(event) => {
              event.stopPropagation();
              openOverlay("editor");
            }}
          >
            Edit Artifact
          </button>
        ) : null}
      </div>
    </article>
  );
}

export function MessageArtifacts({ artifacts }: { artifacts: MessageArtifact[] }) {
  const [showMoreArtifacts, setShowMoreArtifacts] = useState(false);

  if (!artifacts || artifacts.length === 0) {
    return null;
  }
  const artifactPreviews = artifacts.filter((artifact) => artifact.type === "artifact_preview");
  const otherArtifacts = artifacts.filter(
    (artifact) =>
      artifact.type !== "artifact_preview" &&
      artifact.type !== "tool_call" &&
      artifact.type !== "tool_result"
  );
  const visibleArtifactPreviews = showMoreArtifacts
    ? artifactPreviews
    : artifactPreviews.slice(0, 1);

  return (
    <div className="message-artifacts">
      {visibleArtifactPreviews.map((artifact) => (
        <ArtifactPreviewCard key={artifact.id} artifact={artifact} />
      ))}
      {artifactPreviews.length > 1 ? (
        <button
          className="artifact-preview-more-button"
          type="button"
          onClick={() => setShowMoreArtifacts((value) => !value)}
        >
          {showMoreArtifacts
            ? "Collapse artifacts"
            : `More artifacts (${artifactPreviews.length - 1})`}
        </button>
      ) : null}
      {otherArtifacts.map((artifact) => {
        switch (artifact.type) {
          case "diff_proposal":
            return <DiffProposalCard key={artifact.id} artifact={artifact} />;
          case "command_result":
            return <CommandResultCard key={artifact.id} artifact={artifact} />;
          case "file_reference":
            return <FileReferenceCard key={artifact.id} artifact={artifact} />;
          case "error":
            return <ErrorCard key={artifact.id} artifact={artifact} />;
          default:
            return null;
        }
      })}
    </div>
  );
}
