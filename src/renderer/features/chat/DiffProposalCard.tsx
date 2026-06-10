import { useMemo, useState } from "react";

type DiffProposalCardProps = {
  code: string;
};

type ParsedDiffProposal = {
  filePath: string | null;
  summary: string | null;
  diffContent: string;
};

function parseDiffProposal(code: string): ParsedDiffProposal {
  const lines = code.split("\n");
  let filePath: string | null = null;
  let summary: string | null = null;
  let separatorIndex = -1;

  for (let i = 1; i < lines.length; i++) {
    const line = lines[i].trim();
    if (line === "---") {
      separatorIndex = i;
      break;
    }
    const colonIndex = line.indexOf(":");
    if (colonIndex > 0) {
      const key = line.slice(0, colonIndex).trim().toLowerCase();
      const value = line.slice(colonIndex + 1).trim();
      if (key === "filepath" || key === "file") {
        filePath = value;
      } else if (key === "summary") {
        summary = value;
      }
    }
  }

  const diffContent =
    separatorIndex >= 0 ? lines.slice(separatorIndex + 1).join("\n").trim() : lines.slice(1).join("\n").trim();

  return { filePath, summary, diffContent };
}

export function DiffProposalCard({ code }: DiffProposalCardProps) {
  const [isExpanded, setIsExpanded] = useState(false);
  const parsed = useMemo(() => parseDiffProposal(code), [code]);
  const isLong = parsed.diffContent.length > 1500;
  const visibleDiff =
    isLong && !isExpanded
      ? `${parsed.diffContent.slice(0, 1500).trimEnd()}\n...`
      : parsed.diffContent;

  return (
    <div className="diff-proposal-card">
      <div className="diff-proposal-card-header">
        <div>
          <span>变更提案</span>
          {parsed.filePath ? <small>文件: {parsed.filePath}</small> : null}
          {parsed.summary ? <small>{parsed.summary}</small> : null}
        </div>
      </div>
      <pre className="diff-proposal-card-diff">
        <code>{visibleDiff}</code>
      </pre>
      {isLong ? (
        <div className="diff-proposal-card-actions">
          <button type="button" onClick={() => setIsExpanded((v) => !v)}>
            {isExpanded ? "收起" : "查看完整 Diff"}
          </button>
        </div>
      ) : null}
    </div>
  );
}
