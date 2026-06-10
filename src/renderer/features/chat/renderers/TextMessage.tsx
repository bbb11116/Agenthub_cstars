import type { TextMessageContent } from "../../../../shared/domain";
import { MessageMarkdown } from "../MessageMarkdown";
import { ThinkingBlock } from "./ThinkingBlock";

type TextMessageProps = {
  content: TextMessageContent;
  thinking?: string | null;
};

export function TextMessage({ content, thinking }: TextMessageProps) {
  return (
    <div className="text-message">
      {thinking ? <ThinkingBlock thinking={thinking} /> : null}
      <div className="text-message-body">
        <MessageMarkdown text={content.text} />
      </div>
    </div>
  );
}
