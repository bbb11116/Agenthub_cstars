import { type ReactNode } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import rehypeSanitize from "rehype-sanitize";
import { CodeBlock } from "./CodeBlock";
import { DiffProposalCard } from "./DiffProposalCard";

type MessageMarkdownProps = {
  text: string;
};

function extractCodeFromPre(children: ReactNode): { lang: string; code: string } {
  if (
    children &&
    typeof children === "object" &&
    "props" in children &&
    children.props
  ) {
    const props = children.props as Record<string, unknown>;
    const className = typeof props.className === "string" ? props.className : "";
    const langMatch = className.match(/language-(\S+)/);
    const lang = langMatch ? langMatch[1] : "";
    const code = typeof props.children === "string" ? props.children : "";
    return { lang, code };
  }
  return { lang: "", code: "" };
}

export function MessageMarkdown({ text }: MessageMarkdownProps) {
  return (
    <ReactMarkdown
      remarkPlugins={[remarkGfm]}
      rehypePlugins={[rehypeSanitize]}
      components={{
        h1: ({ children, ...props }) => (
          <h1 className="markdown-h1" {...props}>{children}</h1>
        ),
        h2: ({ children, ...props }) => (
          <h2 className="markdown-h2" {...props}>{children}</h2>
        ),
        h3: ({ children, ...props }) => (
          <h3 className="markdown-h3" {...props}>{children}</h3>
        ),
        h4: ({ children, ...props }) => (
          <h4 className="markdown-h4" {...props}>{children}</h4>
        ),
        h5: ({ children, ...props }) => (
          <h5 className="markdown-h5" {...props}>{children}</h5>
        ),
        h6: ({ children, ...props }) => (
          <h6 className="markdown-h6" {...props}>{children}</h6>
        ),
        p: ({ children, ...props }) => (
          <p className="markdown-p" {...props}>{children}</p>
        ),
        ul: ({ children, ...props }) => (
          <ul className="markdown-ul" {...props}>{children}</ul>
        ),
        ol: ({ children, ...props }) => (
          <ol className="markdown-ol" {...props}>{children}</ol>
        ),
        li: ({ children, ...props }) => (
          <li className="markdown-li" {...props}>{children}</li>
        ),
        blockquote: ({ children, ...props }) => (
          <blockquote className="markdown-blockquote" {...props}>{children}</blockquote>
        ),
        table: ({ children, ...props }) => (
          <table className="markdown-table" {...props}>{children}</table>
        ),
        thead: ({ children, ...props }) => (
          <thead className="markdown-thead" {...props}>{children}</thead>
        ),
        tbody: ({ children, ...props }) => (
          <tbody className="markdown-tbody" {...props}>{children}</tbody>
        ),
        tr: ({ children, ...props }) => (
          <tr className="markdown-tr" {...props}>{children}</tr>
        ),
        th: ({ children, ...props }) => (
          <th className="markdown-th" {...props}>{children}</th>
        ),
        td: ({ children, ...props }) => (
          <td className="markdown-td" {...props}>{children}</td>
        ),
        a: ({ children, href, ...props }) => (
          <a
            className="markdown-a"
            href={href}
            target="_blank"
            rel="noopener noreferrer"
            {...props}
          >
            {children}
          </a>
        ),
        hr: ({ ...props }) => <hr className="markdown-hr" {...props} />,
        strong: ({ children, ...props }) => (
          <strong className="markdown-strong" {...props}>{children}</strong>
        ),
        em: ({ children, ...props }) => (
          <em className="markdown-em" {...props}>{children}</em>
        ),
        code: ({ children, className, ...props }) => {
          const isBlock = className?.includes("language-");
          if (isBlock) {
            return <code className={className} {...props}>{children}</code>;
          }
          return (
            <code className="markdown-inline-code" {...props}>{children}</code>
          );
        },
        pre: ({ children }) => {
          const { lang, code } = extractCodeFromPre(children);
          if (lang === "diff" && code.startsWith("# DiffProposal")) {
            return <DiffProposalCard code={code} />;
          }
          return <CodeBlock language={lang} code={code} />;
        },
      }}
    >
      {text}
    </ReactMarkdown>
  );
}
