import { Fragment, useEffect, useRef } from "react";
import type { Message } from "../../../shared/domain";
import type { MessageArtifact } from "../../../shared/agentRunEvent";
import type { AgentRunEvent } from "../../../shared/agentRunEvent";
import type { GroupRunEvent } from "../../../shared/groupChat";
import { MessageRenderer } from "./MessageRenderer";
import { MessageArtifacts } from "./MessageArtifacts";
import { AgentRunStepProcessPanel } from "./AgentRunStepProcess";
import { GroupRunStepProcessPanel } from "./GroupRunTimeline";
import { ThinkingIndicator } from "./ThinkingIndicator";

export type ChatMessage = Message & {
  deliveryState?: "sending" | "failed";
  deliveryError?: string;
  artifacts?: MessageArtifact[];
};

export type MessageListStatus = "idle" | "loading" | "ready" | "empty" | "error";

type MessageListProps = {
  messages: ChatMessage[];
  status: MessageListStatus;
  error: string | null;
  emptyTitle: string;
  emptyMessage: string;
  activeAgentName?: string;
  agentNameMap?: Record<string, string>;
  agentRunEvents?: AgentRunEvent[];
  groupRunEvents?: GroupRunEvent[];
  groupRunWorkspaceId?: string | null;
  isSending?: boolean;
};

function formatMessageTime(value: string): string {
  const date = new Date(value);

  if (Number.isNaN(date.getTime())) {
    return "";
  }

  return date.toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit"
  });
}

const AGENT_COLORS = [
  "#2563eb",
  "#0f766e",
  "#0284c7",
  "#4338ca",
  "#0369a1",
  "#0891b2",
  "#1d4ed8",
  "#155e75",
  "#334155",
  "#0e7490"
];

function getAgentColor(agentId: string): string {
  let hash = 0;
  for (let i = 0; i < agentId.length; i++) {
    hash = (hash * 31 + agentId.charCodeAt(i)) | 0;
  }
  return AGENT_COLORS[Math.abs(hash) % AGENT_COLORS.length];
}

function getSenderLabel(
  message: Message,
  activeAgentName?: string,
  agentNameMap?: Record<string, string>
): string {
  switch (message.senderType) {
    case "user":
      return "你";
    case "agent":
      return (
        (typeof message.metadata?.senderDisplayName === "string"
          ? message.metadata.senderDisplayName
          : undefined) ??
        (message.senderId && agentNameMap?.[message.senderId]) ??
        activeAgentName ??
        "Agent"
      );
    case "system":
      return "系统";
  }
}

function getDispatchPlanRunId(message: Message): string | null {
  if (message.messageType !== "dispatch_plan") {
    return null;
  }

  const metadataRunId = message.metadata?.dispatchRunId;
  if (typeof metadataRunId === "string" && metadataRunId.trim()) {
    return metadataRunId;
  }

  return typeof message.dispatchRunId === "string" && message.dispatchRunId.trim()
    ? message.dispatchRunId
    : null;
}

function getAgentRunCreatedAt(events: AgentRunEvent[]): string | null {
  const sortedEvents = [...events].sort((left, right) => left.seq - right.seq);
  return sortedEvents.find((event) => event.type === "run.started")?.createdAt ??
    sortedEvents[0]?.createdAt ??
    null;
}

function buildAgentRunAnchors(
  messages: ChatMessage[],
  events: AgentRunEvent[]
): Map<string, string[]> {
  const userMessages = messages.filter((message) => message.senderType === "user");
  const eventsByRun = new Map<string, AgentRunEvent[]>();

  for (const event of events) {
    eventsByRun.set(event.runId, [...(eventsByRun.get(event.runId) ?? []), event]);
  }

  const anchoredRunIds = new Map<string, string[]>();
  const runs = [...eventsByRun.entries()]
    .map(([runId, runEvents]) => ({
      runId,
      createdAt: getAgentRunCreatedAt(runEvents)
    }))
    .filter((run): run is { runId: string; createdAt: string } => Boolean(run.createdAt))
    .sort((left, right) => left.createdAt.localeCompare(right.createdAt));

  for (const run of runs) {
    let anchor: ChatMessage | null = null;

    for (const message of userMessages) {
      if (message.createdAt <= run.createdAt) {
        anchor = message;
      }
    }

    if (!anchor) {
      continue;
    }

    anchoredRunIds.set(anchor.id, [
      ...(anchoredRunIds.get(anchor.id) ?? []),
      run.runId
    ]);
  }

  return anchoredRunIds;
}

export function MessageList({
  activeAgentName,
  agentRunEvents = [],
  agentNameMap,
  emptyMessage,
  emptyTitle,
  error,
  groupRunEvents = [],
  groupRunWorkspaceId = null,
  isSending = false,
  messages,
  status
}: MessageListProps) {
  const bottomRef = useRef<HTMLDivElement | null>(null);
  const hasGroupRunEvents = groupRunEvents.length > 0;
  const agentRunAnchors = buildAgentRunAnchors(messages, agentRunEvents);
  const lastMessage = messages[messages.length - 1];
  const showThinkingIndicator =
    isSending && Boolean(lastMessage) && lastMessage.senderType === "user";
  const thinkingLabel = activeAgentName ? `${activeAgentName} 思考中` : undefined;

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ block: "end" });
  }, [agentRunEvents.length, groupRunEvents.length, messages, status]);

  if (status === "loading") {
    return (
      <div className="message-list-state" role="status">
        <span className="placeholder-title">加载中</span>
        <p>正在加载消息...</p>
      </div>
    );
  }

  if (status === "error") {
    return (
      <div className="message-list-state message-list-error" role="alert">
        <span className="placeholder-title">无法加载消息</span>
        <p>{error ?? "消息历史暂不可用。"}</p>
      </div>
    );
  }

  if (messages.length === 0 && !hasGroupRunEvents) {
    const showAgentHubWelcome =
      emptyTitle === "No Messages Yet" ||
      emptyTitle === "No Active Conversation" ||
      emptyTitle === "还没有消息" ||
      emptyTitle === "没有活动会话";

    if (showAgentHubWelcome) {
      return (
        <div className="message-list-state chat-welcome">
          <span className="chat-welcome-kicker">准备就绪</span>
          <h1>AgentHub</h1>
          <p>你的本地 AI 协作伙伴，可以从一次对话开始，也可以接住一整段工作。</p>
          <small>{emptyMessage}</small>
        </div>
      );
    }

    return (
      <div className="message-list-state">
        <span className="placeholder-title">{emptyTitle}</span>
        <p>{emptyMessage}</p>
      </div>
    );
  }

  return (
    <div className="message-list" role="log" aria-live="polite">
      {messages.map((message) => {
        const timeLabel = formatMessageTime(message.createdAt);
        const dispatchPlanRunId = getDispatchPlanRunId(message);
        const hideDispatchPlanBubble = Boolean(dispatchPlanRunId && hasGroupRunEvents);
        const anchoredAgentRunIds = agentRunAnchors.get(message.id) ?? [];

        return (
          <Fragment key={message.id}>
            {!hideDispatchPlanBubble ? (
              <article
                className={`message-row message-row-${message.senderType} ${
                  message.deliveryState ? `message-row-${message.deliveryState}` : ""
                }`}
              >
                <div className="message-meta">
                  {message.senderType === "agent" && message.senderId ? (
                    <span
                      className="agent-badge"
                      style={{ backgroundColor: getAgentColor(message.senderId) }}
                    />
                  ) : null}
                  <span>{getSenderLabel(message, activeAgentName, agentNameMap)}</span>
                  {timeLabel ? <time dateTime={message.createdAt}>{timeLabel}</time> : null}
                  {message.deliveryState === "sending" ? <small>发送中</small> : null}
                  {message.deliveryState === "failed" ? <small>发送失败</small> : null}
                </div>
                <MessageRenderer message={message} />
                {message.artifacts && message.artifacts.length > 0 ? (
                  <MessageArtifacts artifacts={message.artifacts} />
                ) : null}
                {message.deliveryState === "failed" && message.deliveryError ? (
                  <p className="message-delivery-error">{message.deliveryError}</p>
                ) : null}
              </article>
            ) : null}
            {dispatchPlanRunId && hasGroupRunEvents ? (
              <GroupRunStepProcessPanel
                events={groupRunEvents}
                groupRunId={dispatchPlanRunId}
                workspaceId={groupRunWorkspaceId}
              />
            ) : null}
            {anchoredAgentRunIds.map((runId) => (
              <AgentRunStepProcessPanel
                agentName={activeAgentName}
                events={agentRunEvents}
                key={runId}
                runId={runId}
              />
            ))}
          </Fragment>
        );
      })}
      <div ref={bottomRef} />
      {showThinkingIndicator ? (
        <ThinkingIndicator {...(thinkingLabel ? { label: thinkingLabel } : {})} />
      ) : null}
    </div>
  );
}
