import type { FileContent } from "../../../shared/file";

type FileViewerProps = {
  selectedFilePath: string | null;
  content: FileContent | null;
  loading: boolean;
  error?: string;
};

function formatBytes(size: number): string {
  if (size < 1024) {
    return `${size} B`;
  }

  if (size < 1024 * 1024) {
    return `${(size / 1024).toFixed(1)} KB`;
  }

  return `${(size / (1024 * 1024)).toFixed(1)} MB`;
}

export function FileViewer({ content, error, loading, selectedFilePath }: FileViewerProps) {
  if (loading) {
    return (
      <div className="file-viewer file-viewer-state" role="status">
        <span className="placeholder-title">Loading</span>
        <span className="placeholder-muted">Loading file preview...</span>
      </div>
    );
  }

  if (error) {
    return (
      <div className="file-viewer file-viewer-state workspace-error" role="alert">
        <span>{error}</span>
      </div>
    );
  }

  if (!selectedFilePath || !content) {
    return (
      <div className="file-viewer file-viewer-state">
        <span className="placeholder-title">No File Selected</span>
        <span className="placeholder-muted">Select a file to preview its contents.</span>
      </div>
    );
  }

  return (
    <section className="file-viewer" aria-label="File preview">
      <header className="file-viewer-header">
        <div>
          <span>{content.relativePath}</span>
          <small>
            {formatBytes(content.size)}
            {content.language ? ` - ${content.language}` : ""}
          </small>
        </div>
      </header>
      <pre className="file-viewer-code">
        <code>{content.content}</code>
      </pre>
    </section>
  );
}
