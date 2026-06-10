import type { Message } from "../../../../shared/domain";
import { MessageMarkdown } from "../MessageMarkdown";
import { TextMessage } from "./TextMessage";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function getTextContent(content: unknown): string {
  return isRecord(content) && typeof content.text === "string" ? content.text : "";
}

export function OrchestratorSummaryMessage({ message }: { message: Message }) {
  const text = getTextContent(message.content);
  if (!text) {
    return <TextMessage content={{ text: "" }} />;
  }

  const metadata = message.metadata;
  const status = typeof metadata?.status === "string" ? metadata.status : null;

  return (
    <article className="structured-message-card orchestrator-summary-message">
      <header className="structured-message-header">
        <div>
          <span>主 Agent 总结</span>
          {status ? <small>{status}</small> : null}
        </div>
      </header>
      <div className="structured-message-body">
        <MessageMarkdown text={text} />
      </div>
    </article>
  );
}
