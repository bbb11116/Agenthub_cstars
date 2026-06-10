import type {
  AgentStatus,
  AgentStatusCardContent,
  CodeMessageContent,
  DiffCardContent,
  Message,
  MessageType,
  TextMessageContent
} from "../../../shared/domain";
import { AgentStatusMessage } from "./renderers/AgentStatusMessage";
import { AgentAssignmentMessage } from "./renderers/AgentAssignmentMessage";
import { CodeMessage } from "./renderers/CodeMessage";
import { DiffCardMessage } from "./renderers/DiffCardMessage";
import { DispatchPlanMessage } from "./renderers/DispatchPlanMessage";
import { OrchestratorSummaryMessage } from "./renderers/OrchestratorSummaryMessage";
import { TextMessage } from "./renderers/TextMessage";

type MessageRendererProps = {
  message: Message;
};

const PLACEHOLDER_LABELS: Record<Exclude<MessageType, "text" | "code">, string> = {
  diff_card: "Diff",
  file_card: "文件",
  preview_card: "预览",
  deploy_status: "部署状态",
  agent_status: "Agent 状态",
  dispatch_plan: "分派计划",
  agent_assignment: "Agent 执行结果",
  orchestrator_summary: "主 Agent 总结"
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isTextMessageContent(value: unknown): value is TextMessageContent {
  return isRecord(value) && typeof value.text === "string";
}

function isCodeMessageContent(value: unknown): value is CodeMessageContent {
  return (
    isRecord(value) &&
    typeof value.language === "string" &&
    typeof value.code === "string" &&
    (value.filePath === undefined || typeof value.filePath === "string")
  );
}

function isAgentStatus(value: unknown): value is AgentStatus {
  return (
    value === "draft" ||
    value === "available" ||
    value === "running" ||
    value === "error" ||
    value === "unavailable" ||
    value === "disabled" ||
    value === "deleted"
  );
}

function isDiffCardContent(value: unknown): value is DiffCardContent {
  return (
    isRecord(value) &&
    typeof value.diffProposalId === "string" &&
    typeof value.filePath === "string" &&
    (value.summary === undefined || typeof value.summary === "string")
  );
}

function isAgentStatusCardContent(value: unknown): value is AgentStatusCardContent {
  return (
    isRecord(value) &&
    typeof value.agentId === "string" &&
    isAgentStatus(value.status) &&
    typeof value.title === "string" &&
    (value.detail === undefined || typeof value.detail === "string")
  );
}

function stringifyContent(content: unknown): string {
  if (typeof content === "string") {
    return content;
  }

  try {
    return JSON.stringify(content, null, 2);
  } catch {
    return String(content);
  }
}

function FallbackMessage({ content }: { content: unknown }) {
  return (
    <div className="message-fallback">
      <span>Unable to render this message.</span>
      <pre>{stringifyContent(content)}</pre>
    </div>
  );
}

function LegacyAgentConfigCardMessage() {
  return (
    <div className="message-placeholder-card">
      <span>该旧版 Agent 创建卡片已不再支持。</span>
    </div>
  );
}

function PlaceholderMessage({
  content,
  messageType
}: {
  content: unknown;
  messageType: Exclude<MessageType, "text" | "code">;
}) {
  const preview = stringifyContent(content);

  return (
    <div className="message-placeholder-card">
      <span>{PLACEHOLDER_LABELS[messageType]}</span>
      <small>{messageType}</small>
      {preview && preview !== "null" ? <pre>{preview}</pre> : null}
    </div>
  );
}

export function MessageRenderer({ message }: MessageRendererProps) {
  if (message.messageType === "agent_config_card") {
    return <LegacyAgentConfigCardMessage />;
  }

  switch (message.messageType) {
    case "text":
      return isTextMessageContent(message.content) ? (
        <TextMessage content={message.content} thinking={message.thinking ?? null} />
      ) : (
        <FallbackMessage content={message.content} />
      );
    case "code":
      return isCodeMessageContent(message.content) ? (
        <CodeMessage content={message.content} />
      ) : (
        <FallbackMessage content={message.content} />
      );
    case "diff_card":
      return isDiffCardContent(message.content) ? (
        <DiffCardMessage content={message.content} />
      ) : (
        <PlaceholderMessage content={message.content} messageType={message.messageType} />
      );
    case "agent_status":
      return isAgentStatusCardContent(message.content) ? (
        <AgentStatusMessage content={message.content} />
      ) : (
        <PlaceholderMessage content={message.content} messageType={message.messageType} />
      );
    case "file_card":
    case "preview_card":
    case "deploy_status":
      return <PlaceholderMessage content={message.content} messageType={message.messageType} />;
    case "dispatch_plan":
      return <DispatchPlanMessage message={message} />;
    case "agent_assignment":
      return <AgentAssignmentMessage message={message} />;
    case "orchestrator_summary":
      return <OrchestratorSummaryMessage message={message} />;
    default:
      return <FallbackMessage content={message.content} />;
  }
}
