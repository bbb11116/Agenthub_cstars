import { useCallback, useMemo, useRef, useState, type ReactNode } from "react";
import { createLowlight, common } from "lowlight";

type CopyState = "idle" | "copied" | "error";

type CodeBlockProps = {
  language: string;
  code: string;
  filePath?: string;
};

const MAX_HEIGHT = 320;

const lowlight = createLowlight(common);

function renderLowlightNodes(nodes: unknown[]): ReactNode[] {
  return nodes.map((node: any, i: number) => {
    if (node.type === "text") {
      return node.value;
    }
    if (node.type === "element") {
      const className: string | undefined = node.properties?.className?.join(" ");
      const children = node.children ? renderLowlightNodes(node.children) : null;
      return (
        <span key={i} className={className}>
          {children}
        </span>
      );
    }
    if (node.children) {
      return <span key={i}>{renderLowlightNodes(node.children)}</span>;
    }
    return null;
  });
}

export function CodeBlock({ language, code, filePath }: CodeBlockProps) {
  const [copyState, setCopyState] = useState<CopyState>("idle");
  const [isExpanded, setIsExpanded] = useState(false);
  const preRef = useRef<HTMLPreElement>(null);

  const lang = language.trim().toLowerCase();
  const needsCollapse = code.length > 1200;

  const highlighted = useMemo(() => {
    if (!lang || !lowlight.registered(lang)) {
      return null;
    }
    try {
      const result = lowlight.highlight(lang, code);
      return renderLowlightNodes(result.children);
    } catch {
      return null;
    }
  }, [lang, code]);

  const handleCopy = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(code);
      setCopyState("copied");
      window.setTimeout(() => setCopyState("idle"), 1400);
    } catch {
      setCopyState("error");
      window.setTimeout(() => setCopyState("idle"), 1800);
    }
  }, [code]);

  const displayLang = lang || "text";

  return (
    <div className="code-block">
      <div className="code-block-header">
        <div className="code-block-header-left">
          <span className="code-block-lang">{displayLang}</span>
          {filePath ? <span className="code-block-filepath">{filePath}</span> : null}
        </div>
        <button
          type="button"
          className="code-block-copy"
          onClick={() => void handleCopy()}
        >
          {copyState === "copied" ? "已复制" : copyState === "error" ? "复制失败" : "复制"}
        </button>
      </div>
      <pre
        ref={preRef}
        className={`code-block-pre${needsCollapse && !isExpanded ? " collapsed" : ""}`}
        style={needsCollapse && !isExpanded ? { maxHeight: MAX_HEIGHT } : undefined}
      >
        <code className="code-block-code">
          {highlighted ?? code}
        </code>
      </pre>
      {needsCollapse ? (
        <div className="code-block-footer">
          <button
            type="button"
            className="code-block-expand"
            onClick={() => setIsExpanded((v) => !v)}
          >
            {isExpanded ? "Collapse" : "Expand"}
          </button>
        </div>
      ) : null}
    </div>
  );
}
