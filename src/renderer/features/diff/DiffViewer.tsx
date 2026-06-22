import { useMemo, useState } from "react";

export const LARGE_DIFF_CHAR_LIMIT = 12_000;

type DiffViewerProps = {
  diffContent: string;
  filePath: string;
  label?: string;
  defaultExpanded?: boolean;
  onExpandedChange?: (expanded: boolean) => void;
};

function getDiffLineClassName(line: string): string {
  if (line.startsWith("@@")) {
    return "diff-line diff-line-hunk";
  }

  if (line.startsWith("+++") || line.startsWith("---")) {
    return "diff-line diff-line-file";
  }

  if (line.startsWith("+")) {
    return "diff-line diff-line-add";
  }

  if (line.startsWith("-")) {
    return "diff-line diff-line-delete";
  }

  return "diff-line";
}

export function DiffViewer({
  diffContent,
  filePath,
  label,
  defaultExpanded,
  onExpandedChange
}: DiffViewerProps) {
  const isLargeDiff = diffContent.length > LARGE_DIFF_CHAR_LIMIT;
  const [expanded, setExpanded] = useState(defaultExpanded ?? !isLargeDiff);
  const lines = useMemo(() => diffContent.split("\n"), [diffContent]);

  const handleToggle = (): void => {
    const next = !expanded;
    setExpanded(next);
    onExpandedChange?.(next);
  };

  if (diffContent.trim().length === 0) {
    return (
      <div className="diff-viewer diff-viewer-state">
        <span className="placeholder-title">No Diff</span>
        <span className="placeholder-muted">No textual changes are available.</span>
      </div>
    );
  }

  return (
    <section className="diff-viewer" aria-label={label ?? `Diff for ${filePath}`}>
      <header className="diff-viewer-header">
        <div>
          <span>{filePath}</span>
          <small>{isLargeDiff ? "Large diff" : "Unified diff"}</small>
        </div>
        {isLargeDiff ? (
          <button type="button" onClick={handleToggle}>
            {expanded ? "Collapse" : "Expand"}
          </button>
        ) : null}
      </header>

      {expanded ? (
        <pre className="diff-viewer-code">
          <code>
            {lines.map((line, index) => (
              <span key={`${index}-${line}`} className={getDiffLineClassName(line)}>
                {line || " "}
              </span>
            ))}
          </code>
        </pre>
      ) : (
        <div className="diff-viewer-state">
          <span className="placeholder-title">Diff Folded</span>
          <span className="placeholder-muted">Expand to review the full proposed change.</span>
        </div>
      )}
    </section>
  );
}
