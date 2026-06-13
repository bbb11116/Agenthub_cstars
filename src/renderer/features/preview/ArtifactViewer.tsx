import { useState } from "react";
import type { Artifact } from "../../../shared/artifact";
import { HtmlPreview } from "./HtmlPreview";
import { MarkdownPreview } from "./MarkdownPreview";
import { ScaledHtmlFrame } from "./ScaledHtmlFrame";
import { ScaledPdfFrame } from "./ScaledPdfFrame";
import { ZoomablePreview } from "./ZoomablePreview";

type ArtifactViewerProps = {
  artifact: Artifact;
  compact?: boolean;
  contentOverride?: string;
  onArtifactUpdated?: (artifact: Artifact) => void;
  onOpenDiff?: () => void;
};

const MAX_PREVIEW_CHARS = 200_000;

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

function CodePreview({ content }: { content: string }) {
  return (
    <pre className="preview-code-block">
      <code>{content}</code>
    </pre>
  );
}

function getPrimaryAssetUrl(artifact: Artifact): string | null {
  return artifact.render?.assets.find((asset) => asset.role === "primary")?.url ?? null;
}

export function ArtifactViewer({
  artifact,
  compact = false,
  contentOverride,
  onArtifactUpdated,
  onOpenDiff
}: ArtifactViewerProps) {
  const [isExpanded, setIsExpanded] = useState(false);
  const [isRendering, setIsRendering] = useState(false);
  const content = contentOverride ?? artifact.content;
  const isEmpty = content.length === 0 && !artifact.filePath;
  const isLarge = content.length > MAX_PREVIEW_CHARS;
  const visibleContent =
    isLarge && !isExpanded && !compact ? content.slice(0, MAX_PREVIEW_CHARS) : content;
  const renderStatus = artifact.render?.status ?? "none";
  const primaryAssetUrl = getPrimaryAssetUrl(artifact);

  async function handleRender(): Promise<void> {
    if (!window.agenthub?.artifact) {
      return;
    }

    setIsRendering(true);
    try {
      const updated = await window.agenthub.artifact.render(artifact.id);
      onArtifactUpdated?.(updated);
    } finally {
      setIsRendering(false);
    }
  }

  if (artifact.type === "diff") {
    return (
      <section className="artifact-viewer" aria-label="Artifact preview">
        <div className="preview-empty-state">
          <span className="placeholder-title">Diff Artifact</span>
          <span className="placeholder-muted">Open the Diff tab to review and apply changes.</span>
          {onOpenDiff ? (
            <button type="button" onClick={onOpenDiff}>
              Open Diff
            </button>
          ) : null}
        </div>
      </section>
    );
  }

  if (isEmpty) {
    return (
      <section className="artifact-viewer" aria-label="Artifact preview">
        <div className="preview-empty-state">
          <span className="placeholder-title">Empty artifact</span>
          <span className="placeholder-muted">This artifact has no content to preview.</span>
        </div>
      </section>
    );
  }

  if (
    artifact.type === "document" ||
    artifact.type === "presentation" ||
    artifact.type === "pdf"
  ) {
    if (renderStatus === "ready" && primaryAssetUrl) {
      return (
        <section className="artifact-viewer" aria-label="Rendered artifact preview">
          <ScaledPdfFrame
            className={compact ? "artifact-pdf-frame compact" : "artifact-pdf-frame"}
            src={primaryAssetUrl}
            title={artifact.title}
          />
        </section>
      );
    }

    return (
      <section className="artifact-viewer" aria-label="Artifact render status">
        <div className="preview-empty-state">
          <span className="placeholder-title">
            {renderStatus === "error" ? "Render Failed" : "Rendering Artifact"}
          </span>
          <span className="placeholder-muted">
            {artifact.render?.message ??
              (renderStatus === "error"
                ? "The source file is available, but preview rendering failed."
                : "The preview is being prepared.")}
          </span>
          <button type="button" disabled={isRendering} onClick={() => void handleRender()}>
            {isRendering ? "Rendering..." : "Render Preview"}
          </button>
        </div>
      </section>
    );
  }

  return (
    <section className="artifact-viewer" aria-label="Artifact preview">
      {artifact.type === "html" && isLarge && !isExpanded && !compact ? (
        <div className="preview-empty-state">
          <span className="placeholder-title">Large artifact</span>
          <span className="placeholder-muted">This HTML artifact is too large to render automatically.</span>
          <button type="button" onClick={() => setIsExpanded(true)}>
            Show Preview
          </button>
        </div>
      ) : (
        <ZoomablePreview className={compact ? "compact" : ""}>
          <div className={compact ? "preview-body compact" : "preview-body"}>
            {artifact.type === "html" ? (
              artifact.filePath && compact ? (
                <ScaledHtmlFrame content={content} title={artifact.title} />
              ) : (
                <HtmlPreview content={content} title={artifact.title} />
              )
            ) : artifact.type === "markdown" ? (
              <MarkdownPreview content={visibleContent} />
            ) : (
              <CodePreview content={visibleContent} />
            )}
          </div>
        </ZoomablePreview>
      )}

      {isLarge && artifact.type !== "html" && !compact ? (
        <div className="preview-large-notice">
          <span>{isExpanded ? "Showing full artifact." : "Preview truncated because the artifact is large."}</span>
          <button type="button" onClick={() => setIsExpanded((value) => !value)}>
            {isExpanded ? "Collapse" : "Expand"}
          </button>
        </div>
      ) : null}
      <span className="artifact-viewer-meta">
        {formatArtifactType(artifact.type)}
        {artifact.language ? ` - ${artifact.language}` : ""}
        {artifact.filePath ? ` - ${artifact.filePath}` : ""}
        {` - v${artifact.version} - ${formatBytes(content)}`}
      </span>
    </section>
  );
}
