import type { CodeMessageContent } from "../../../../shared/domain";
import { CodeBlock } from "../CodeBlock";

type CodeMessageProps = {
  content: CodeMessageContent;
};

export function CodeMessage({ content }: CodeMessageProps) {
  return (
    <div className="code-message">
      <CodeBlock
        language={content.language}
        code={content.code}
        filePath={content.filePath}
      />
    </div>
  );
}
