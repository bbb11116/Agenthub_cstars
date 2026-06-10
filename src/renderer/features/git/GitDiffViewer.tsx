type GitDiffViewerProps = {
  diff: string | null;
  error?: string;
  filePath: string | null;
  loading: boolean;
  truncated: boolean;
};

export function GitDiffViewer({
  diff,
  error,
  filePath,
  loading,
  truncated
}: GitDiffViewerProps) {
  if (loading) {
    return (
      <div className="git-diff-viewer git-diff-state" role="status">
        <span className="placeholder-title">Loading</span>
        <span className="placeholder-muted">Reading Git diff...</span>
      </div>
    );
  }

  if (error) {
    return (
      <div className="git-diff-viewer git-diff-state workspace-error" role="alert">
        <span>{error}</span>
      </div>
    );
  }

  if (diff === null) {
    return (
      <div className="git-diff-viewer git-diff-state">
        <span className="placeholder-title">No Diff Selected</span>
        <span className="placeholder-muted">Select a file or view the full diff.</span>
      </div>
    );
  }

  if (diff.trim().length === 0) {
    return (
      <div className="git-diff-viewer git-diff-state">
        <span className="placeholder-title">No Diff</span>
        <span className="placeholder-muted">No unstaged diff is available.</span>
      </div>
    );
  }

  return (
    <section className="git-diff-viewer" aria-label="Git diff">
      <header className="git-diff-header">
        <div>
          <span>{filePath ?? "Full diff"}</span>
          {truncated ? <small>Truncated</small> : <small>Current working tree diff</small>}
        </div>
      </header>
      <pre className="git-diff-code">
        <code>{diff}</code>
      </pre>
    </section>
  );
}
