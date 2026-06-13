import { useCallback, useEffect, useRef, useState } from "react";
import type {
  CreateMessageInput,
  RunAgentOutput,
  RunAgentStreamEvent,
  TextMessageContent
} from "../../../shared/domain";
import type { AgentRunEvent } from "../../../shared/agentRunEvent";
import type { Artifact } from "../../../shared/artifact";
import type { DiffProposal } from "../../../shared/diff";
import type { ContextUsage } from "../../../shared/modelProvider";
import type { AgentHubApi } from "../../../shared/types";
import { useWorkspaceStore, workspaceStore } from "../../state/workspaceStore";
import { MessageComposer } from "./MessageComposer";
import { MessageList, type ChatMessage, type MessageListStatus } from "./MessageList";
import { GroupChatWindow } from "./GroupChatWindow";

const LOCAL_USER_ID = "local-user";

function getApi(): AgentHubApi {
  if (!window.agenthub) {
    throw new Error("AgentHub API is unavailable.");
  }

  return window.agenthub;
}

function toErrorMessage(error: unknown, fallback: string): string {
  return error instanceof Error ? error.message : fallback;
}

function createPendingTextMessage(input: CreateMessageInput): ChatMessage {
  return {
    id: `pending-${Date.now()}`,
    workspaceId: input.workspaceId,
    conversationId: input.conversationId,
    senderType: input.senderType,
    senderId: input.senderId,
    messageType: input.messageType,
    content: input.content,
    createdAt: new Date().toISOString(),
    deliveryState: "sending"
  };
}

function createStreamingAgentTextMessage(input: {
  workspaceId: string;
  conversationId: string;
  agentId: string;
  text: string;
  id: string;
}): ChatMessage {
  return {
    id: input.id,
    workspaceId: input.workspaceId,
    conversationId: input.conversationId,
    senderType: "agent",
    senderId: input.agentId,
    messageType: "text",
    content: {
      text: input.text
    },
    createdAt: new Date().toISOString()
  };
}

function notifyAgentRunArtifacts(
  workspaceId: string,
  diffProposal?: DiffProposal,
  artifacts: Artifact[] = []
): void {
  if (diffProposal) {
    window.dispatchEvent(
      new CustomEvent("agenthub:diff-changed", {
        detail: {
          workspaceId,
          diffProposalId: diffProposal.id,
          status: diffProposal.status
        }
      })
    );
  }

  if (artifacts.length === 0) {
    return;
  }

  window.dispatchEvent(
    new CustomEvent("agenthub:artifacts-changed", {
      detail: {
        workspaceId
      }
    })
  );

  const previewArtifact = artifacts.find((artifact) => artifact.type !== "diff") ?? artifacts[0];

  window.dispatchEvent(
    new CustomEvent("agenthub:open-artifact", {
      detail: {
        workspaceId,
        artifactId: previewArtifact.id
      }
    })
  );
}

function mergePersistedAgentRunEvents(
  currentEvents: AgentRunEvent[],
  persistedEvents: AgentRunEvent[],
  conversationId: string
): AgentRunEvent[] {
  const nextEvents = new Map<string, AgentRunEvent>();

  for (const event of persistedEvents) {
    nextEvents.set(event.id, event);
  }

  for (const event of currentEvents) {
    if (event.conversationId === conversationId && event.id.startsWith("local-")) {
      nextEvents.set(event.id, event);
    }
  }

  return [...nextEvents.values()].sort((left, right) => {
    if (left.runId !== right.runId) {
      return left.createdAt.localeCompare(right.createdAt);
    }
    return left.seq - right.seq;
  });
}

export function ChatWindow() {
  const {
    activeAgent,
    activeConversation,
    activeWorkspace,
    activeWorkspaceAgents,
    agentTreeError,
    agentTreeStatus,
    contacts,
    loadWorkspaceTree,
    messagesByConversationId,
    selectChat,
    isSendingByConversationId,
    setConversationMessages,
    setConversationSending,
    setConversationActiveRunId
  } = useWorkspaceStore();
  const [messageStatus, setMessageStatus] = useState<MessageListStatus>("idle");
  const [loadError, setLoadError] = useState<string | null>(null);
  const [sendError, setSendError] = useState<string | null>(null);
  const [contextUsage, setContextUsage] = useState<ContextUsage | null>(null);
  const [agentRunEvents, setAgentRunEvents] = useState<AgentRunEvent[]>([]);
  const requestIdRef = useRef(0);
  const activeConversationIdRef = useRef<string | null>(null);

  activeConversationIdRef.current = activeConversation?.id ?? null;

  const messages = messagesByConversationId[activeConversation?.id ?? ""] ?? [];
  const isSending = isSendingByConversationId[activeConversation?.id ?? ""] ?? false;

  const loadConversationMessages = useCallback(
    async (conversationId: string, requestId: number, showLoading = true) => {
      if (showLoading) {
        setMessageStatus("loading");
      }

      setLoadError(null);

      try {
        // listWithArtifacts returns messages + their structured artifacts
        // (tool_call / tool_result / diff_proposal / command_result /
        // file_reference / error). This is the path the unified event
        // protocol writes to, so a fresh page load can recover the full
        // assistant reply from the DB alone.
        const [history, events] = await Promise.all([
          getApi().message.listWithArtifacts(conversationId),
          getApi().agentRun.listEvents(conversationId)
        ]);

        if (requestId !== requestIdRef.current) {
          return;
        }

        setConversationMessages(conversationId, history);
        setAgentRunEvents(events);
        setMessageStatus(history.length > 0 ? "ready" : "empty");
      } catch (error) {
        if (requestId !== requestIdRef.current) {
          return;
        }

        setConversationMessages(conversationId, []);
        setAgentRunEvents([]);
        setLoadError(toErrorMessage(error, "加载消息失败。"));
        setMessageStatus("error");
      }
    },
    [setConversationMessages]
  );

  useEffect(() => {
    const conversationId = activeConversation?.id;
    const requestId = ++requestIdRef.current;

    setSendError(null);

    if (agentTreeStatus === "loading") {
      setMessageStatus("loading");
      setLoadError(null);
      return;
    }

    if (agentTreeStatus === "error") {
      setMessageStatus("error");
      setLoadError(agentTreeError ?? "主 Agent 会话不可用。");
      return;
    }

    if (!conversationId) {
      setMessageStatus("empty");
      setLoadError(null);
      setAgentRunEvents([]);
      return;
    }

    const cached = workspaceStore.getState().messagesByConversationId[conversationId];

    if (cached && cached.length > 0) {
      setMessageStatus("ready");
      setLoadError(null);
      void loadConversationMessages(conversationId, requestId, false);
      return;
    }

    void loadConversationMessages(conversationId, requestId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeConversation?.id, agentTreeError, agentTreeStatus, loadConversationMessages]);

  useEffect(() => {
    const workspaceId = activeWorkspace?.id;
    const conversationId = activeConversation?.id;

    if (!workspaceId || !conversationId || activeAgent?.role !== "main") {
      setContextUsage(null);
      return;
    }

    let cancelled = false;
    void getApi()
      .modelProvider.getContextUsage({ workspaceId, conversationId })
      .then((usage) => {
        if (!cancelled) {
          setContextUsage(usage);
        }
      })
      .catch(() => {
        if (!cancelled) {
          setContextUsage(null);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [activeWorkspace?.id, activeConversation?.id, activeAgent?.role, messages.length]);

  useEffect(() => {
    function handleMessagesChanged(event: Event): void {
      const detail = (event as CustomEvent<{ conversationId?: string }>).detail;
      const conversationId = detail?.conversationId;

      if (!conversationId || conversationId !== activeConversationIdRef.current) {
        return;
      }

      void loadConversationMessages(conversationId, ++requestIdRef.current, false);
    }

    window.addEventListener("agenthub:messages-changed", handleMessagesChanged);

    return () => {
      window.removeEventListener("agenthub:messages-changed", handleMessagesChanged);
    };
  }, [loadConversationMessages]);

  const handleSendText = useCallback(
    async (text: string) => {
      const targetAgent =
        activeConversation?.type === "direct"
          ? activeWorkspaceAgents.find((agent) => agent.id === activeConversation.agentId) ??
            contacts.find((agent) => agent.id === activeConversation.agentId) ??
            activeAgent
          : activeAgent;
      const targetWorkspaceId =
        activeConversation?.type === "direct"
          ? activeConversation.workspaceId
          : activeWorkspace?.id;

      if (!targetWorkspaceId || !targetAgent) {
        setSendError("请先选择会话。");
        return;
      }

      // Allow sending without an active conversation (auto-create)
      const conversationId = activeConversation?.id;

      setSendError(null);

      try {
        if (targetAgent.role === "main") {
          // Main Agent messages use the ordinary run path. Agent creation is manual.
          const cid = conversationId ?? "";
          if (cid) {
            const content: TextMessageContent = { text };
            const input: CreateMessageInput = {
              workspaceId: targetWorkspaceId,
              conversationId: cid,
              senderType: "user",
              senderId: LOCAL_USER_ID,
              messageType: "text",
              content
            };
            const pendingMessage = createPendingTextMessage(input);

            setConversationSending(cid, true);
            const currentMessages = workspaceStore.getState().messagesByConversationId[cid] ?? [];
            setConversationMessages(cid, [...currentMessages, pendingMessage]);
            setMessageStatus("ready");
          } else {
            setConversationSending("", true);
          }

          const output = await runAgentWithConversationStreaming({
            workspaceId: targetWorkspaceId,
            agentId: targetAgent.id,
            conversationId,
            message: text,
            resume: Boolean(conversationId)
          });

          if (!conversationId && output.conversationId) {
            await loadWorkspaceTree(targetWorkspaceId);
            selectChat(output.conversationId);
          } else {
            void loadWorkspaceTree(targetWorkspaceId);
          }

          setConversationSending(output.conversationId, false);
        }

        if (targetAgent.role !== "main") {
          // Sub-agent: show pending message optimistically, backend saves via runAgentWithConversation
          const cid = conversationId ?? "";
          if (cid) {
            const content: TextMessageContent = { text };
            const input: CreateMessageInput = {
              workspaceId: targetWorkspaceId,
              conversationId: cid,
              senderType: "user",
              senderId: LOCAL_USER_ID,
              messageType: "text",
              content
            };
            const pendingMessage = createPendingTextMessage(input);

            setConversationSending(cid, true);
            const currentMessages = workspaceStore.getState().messagesByConversationId[cid] ?? [];
            setConversationMessages(cid, [...currentMessages, pendingMessage]);
            setMessageStatus("ready");
          } else {
            setConversationSending("", true);
          }

          const output = await runAgentWithConversationStreaming({
            workspaceId: targetWorkspaceId,
            agentId: targetAgent.id,
            conversationId,
            message: text,
            resume: Boolean(conversationId)
          });

          // If a new conversation was created, update the store
          if (!conversationId && output.conversationId) {
            await loadWorkspaceTree(targetWorkspaceId);
            selectChat(output.conversationId);
          } else {
            void loadWorkspaceTree(targetWorkspaceId);
          }

          notifyAgentRunArtifacts(
            targetWorkspaceId,
            output.diffProposal,
            output.artifacts ?? []
          );

          setConversationSending(output.conversationId, false);
        }
      } catch (error) {
        const errorMessage = toErrorMessage(error, "发送消息失败。");
        const cid = conversationId ?? activeConversation?.id;

        if (cid) {
          const prev = workspaceStore.getState().messagesByConversationId[cid] ?? [];
          setConversationMessages(
            cid,
            prev.map((message) =>
              "deliveryState" in message && message.deliveryState === "sending"
                ? {
                    ...message,
                    deliveryState: "failed" as const,
                    deliveryError: errorMessage
                  }
                : message
            )
          );
        }
        setSendError(errorMessage);
        if (conversationId) {
          setConversationSending(conversationId, false);
        }
      }

      async function runAgentWithConversationStreaming(input: {
        workspaceId: string;
        agentId: string;
        conversationId?: string;
        message: string;
        resume?: boolean;
      }): Promise<RunAgentOutput & { conversationId: string; usedFallback?: boolean }> {
        const currentState = workspaceStore.getState();
        const currentAgent =
          activeAgent?.id === input.agentId
            ? activeAgent
            : Object.values(currentState.agentsByWorkspace)
                .flat()
                .find((agent) => agent.id === input.agentId) ??
              currentState.contacts.find((agent) => agent.id === input.agentId) ??
              null;

        if (!currentAgent) {
          throw new Error("未选择可用 Agent。");
        }

        const agent = currentAgent;
        const workspaceId = input.workspaceId;
        let cid = input.conversationId ?? "";
        let streamMessageId: string | null = null;
        let streamedText = "";
        let streamedThinking = "";
        const shouldStream = agent.runtimeProvider !== "mock";

        function appendAgentRunEvent(event: AgentRunEvent): void {
          setAgentRunEvents((currentEvents) => {
            if (currentEvents.some((item) => item.id === event.id)) {
              return currentEvents;
            }
            return [...currentEvents, event];
          });
        }

        function createLocalRunEvent<T extends AgentRunEvent>(
          runId: string,
          conversationId: string,
          seq: number,
          type: T["type"],
          payload: T["payload"]
        ): T {
          return {
            id: `local-${runId}-${seq}`,
            runId,
            conversationId,
            seq,
            type,
            createdAt: new Date().toISOString(),
            ...(payload === undefined ? {} : { payload })
          } as T;
        }

        function getStreamMessageId(): string {
          if (!streamMessageId) {
            streamMessageId = `stream-${Date.now()}-${Math.random()
              .toString(36)
              .slice(2)}`;
          }
          return streamMessageId;
        }

        function applyMessageDelta(messageId: string | null, text: string): void {
          if (text.length === 0) {
            return;
          }
          const nextMessageId = messageId ?? getStreamMessageId();
          streamedText += text;
          const nextMessage = createStreamingAgentTextMessage({
            workspaceId,
            conversationId: cid,
            agentId: agent.id,
            id: nextMessageId,
            text: streamedText
          });

          const currentStoreState = workspaceStore.getState();
          const convMessages = currentStoreState.messagesByConversationId[cid] ?? [];

          if (!convMessages.some((message) => message.id === nextMessageId)) {
            setConversationMessages(cid, [...convMessages, nextMessage]);
          } else {
            setConversationMessages(
              cid,
              convMessages.map((message) =>
                message.id === nextMessageId
                  ? {
                      ...message,
                      content: {
                        text: streamedText
                      }
                    }
                  : message
              )
            );
          }
        }

        function applyMessageThinking(messageId: string | null, text: string): void {
          if (text.length === 0) {
            return;
          }
          const nextMessageId = messageId ?? getStreamMessageId();
          streamedThinking += text;
          const currentStoreState = workspaceStore.getState();
          const convMessages = currentStoreState.messagesByConversationId[cid] ?? [];

          if (!convMessages.some((message) => message.id === nextMessageId)) {
            const seed = createStreamingAgentTextMessage({
              workspaceId,
              conversationId: cid,
              agentId: agent.id,
              id: nextMessageId,
              text: streamedText
            });
            setConversationMessages(cid, [
              ...convMessages,
              { ...seed, thinking: streamedThinking }
            ]);
          } else {
            setConversationMessages(
              cid,
              convMessages.map((message) =>
                message.id === nextMessageId
                  ? { ...message, thinking: streamedThinking }
                  : message
              )
            );
          }
        }

        function applyArtifactPreview(event: Extract<AgentRunEvent, { type: "artifact.created" }>): void {
          const nextMessageId = event.payload.messageId || getStreamMessageId();
          const currentStoreState = workspaceStore.getState();
          const convMessages = currentStoreState.messagesByConversationId[cid] ?? [];
          const nextArtifact = {
            id: `local-${event.id}`,
            messageId: nextMessageId,
            conversationId: cid,
            type: "artifact_preview" as const,
            payload: {
              ...event.payload,
              messageId: nextMessageId
            },
            createdAt: event.createdAt
          };
          const existingMessage = convMessages.find((message) => message.id === nextMessageId);

          if (!existingMessage) {
            const seed = createStreamingAgentTextMessage({
              workspaceId,
              conversationId: cid,
              agentId: agent.id,
              id: nextMessageId,
              text: streamedText
            });
            setConversationMessages(cid, [
              ...convMessages,
              {
                ...seed,
                thinking: streamedThinking,
                artifacts: [nextArtifact]
              }
            ]);
            return;
          }

          setConversationMessages(
            cid,
            convMessages.map((message) => {
              if (message.id !== nextMessageId) {
                return message;
              }

              const artifacts = message.artifacts ?? [];
              const withoutDuplicate = artifacts.filter((artifact) => {
                if (artifact.type !== "artifact_preview") {
                  return true;
                }
                const payload = artifact.payload as { artifactId?: string };
                return payload.artifactId !== event.payload.artifactId;
              });

              return {
                ...message,
                artifacts: [...withoutDuplicate, nextArtifact]
              };
            })
          );
        }

        function applyArtifactRendered(event: Extract<AgentRunEvent, { type: "artifact.rendered" }>): void {
          const currentStoreState = workspaceStore.getState();
          const convMessages = currentStoreState.messagesByConversationId[cid] ?? [];

          setConversationMessages(
            cid,
            convMessages.map((message) => ({
              ...message,
              artifacts: message.artifacts?.map((artifact) => {
                if (artifact.type !== "artifact_preview") {
                  return artifact;
                }

                const payload = artifact.payload as { artifactId?: string };
                if (payload.artifactId !== event.payload.artifactId) {
                  return artifact;
                }

                return {
                  ...artifact,
                  payload: {
                    ...(artifact.payload && typeof artifact.payload === "object"
                      ? artifact.payload
                      : {}),
                    ...event.payload
                  }
                };
              })
            }))
          );
        }

        let resolvedOutput: RunAgentOutput & { conversationId: string; usedFallback?: boolean };

        if (agent.type === "orchestrator") {
          // Orchestrator agents keep the legacy structured-intent path. This
          // path is not affected by the unified event protocol.
          const legacyRunId = `legacy-${Date.now()}-${Math.random()
            .toString(36)
            .slice(2)}`;
          const legacyMessageId = `legacy-message-${legacyRunId}`;
          let legacySeq = 0;

          function emitLegacyEvent<T extends AgentRunEvent>(
            type: T["type"],
            payload: T["payload"]
          ): void {
            if (!cid) {
              return;
            }
            appendAgentRunEvent(
              createLocalRunEvent<T>(legacyRunId, cid, legacySeq++, type, payload)
            );
          }

          emitLegacyEvent<AgentRunEvent>("run.started", undefined);
          emitLegacyEvent<AgentRunEvent>("message.started", { messageId: legacyMessageId });

          try {
            const output = await getApi().agent.runWithConversation(
              input,
              shouldStream
                ? {
                    onTextDelta: (event) => {
                      const eventCid = event.conversationId;
                      if (!cid && eventCid) {
                        cid = eventCid;
                      }
                      applyMessageDelta(null, event.text);
                    },
                    onThinkingDelta: (event) => {
                      const eventCid = event.conversationId;
                      if (!cid && eventCid) {
                        cid = eventCid;
                      }
                      applyMessageThinking(null, event.text);
                    }
                  }
                : undefined
            );
            emitLegacyEvent<AgentRunEvent>("message.completed", { messageId: legacyMessageId });
            emitLegacyEvent<AgentRunEvent>("run.completed", {
              messageId: legacyMessageId,
              status: "completed"
            });
            resolvedOutput = output;
          } catch (error) {
            emitLegacyEvent<AgentRunEvent>("run.failed", {
              messageId: legacyMessageId,
              message: toErrorMessage(error, "Agent run failed.")
            });
            throw error;
          }
        } else {
          // Specialist (sub-agent) path: drive the unified event stream.
          // The server persists every event, so a page refresh will
          // recover the full reply from the DB.
          const output = await getApi().agent.runWithConversationUnified(input, {
            onEvent: (event) => {
              if (event.conversationId && !cid) {
                cid = event.conversationId;
              }
              appendAgentRunEvent(event);
              if (event.type === "message.delta") {
                applyMessageDelta(event.payload.messageId, event.payload.delta);
              } else if (event.type === "message.thinking_delta") {
                applyMessageThinking(event.payload.messageId, event.payload.delta);
              } else if (event.type === "artifact.created") {
                applyArtifactPreview(event);
              } else if (event.type === "artifact.rendered") {
                applyArtifactRendered(event);
              }
            }
          });
          // Reconstruct a minimal RunAgentOutput from the unified result so
          // the rest of the call site (which expects the legacy shape)
          // keeps working without changes.
          resolvedOutput = {
            agent,
            status: output.status === "failed" ? "error" : "available",
            messages: [],
            conversationId: output.conversationId,
            runResult: {
              status: output.status === "failed" ? "failed" : "completed",
              ...(output.errorMessage ? { error: output.errorMessage } : {})
            }
          };
        }

        // Update cid if it was auto-created
        if (!input.conversationId && resolvedOutput.conversationId) {
          cid = resolvedOutput.conversationId;
        }

        // Reload from the DB so we recover the persisted content_markdown
        // and any message_artifacts that were attached during the run.
        const [history, events] = await Promise.all([
          getApi().message.listWithArtifacts(cid),
          getApi().agentRun.listEvents(cid)
        ]);
        setConversationMessages(cid, history);
        setAgentRunEvents((currentEvents) =>
          mergePersistedAgentRunEvents(currentEvents, events, cid)
        );
        setMessageStatus(history.length > 0 ? "ready" : "empty");
        setConversationActiveRunId(cid, undefined);

        return resolvedOutput;
      }
    },
    [
      activeAgent?.role,
      activeAgent?.id,
      activeAgent?.runtimeProvider,
      activeConversation,
      activeWorkspace,
      activeWorkspaceAgents,
      contacts,
      loadWorkspaceTree,
      selectChat,
      setConversationMessages,
      setConversationSending,
      setConversationActiveRunId
    ]
  );

  const hasActiveConversation = Boolean(activeWorkspace && activeConversation);
  const isGroupConversation = activeConversation?.type === "group";
  const isMainAgentConversation = activeAgent?.role === "main";
  // Sub-agents can auto-create conversations, so only require conversation for main agents
  const isComposerDisabled = isMainAgentConversation
    ? !hasActiveConversation || agentTreeStatus !== "ready"
    : !activeWorkspace || agentTreeStatus !== "ready";
  const emptyTitle = hasActiveConversation ? "还没有消息" : "没有活动会话";
  const emptyMessage = hasActiveConversation
    ? isMainAgentConversation
      ? "我是当前 Workspace 的主 Agent。请点击左上角加号手动创建子 Agent。"
      : "向这个 Agent 发送消息即可开始。"
    : isMainAgentConversation
      ? "选择一个会话开始对话。"
      : "发送消息即可创建并开始新的会话。";
  const composerPlaceholder =
    activeAgent?.status === "unavailable"
      ? "运行时不可用"
      : hasActiveConversation && isMainAgentConversation
      ? "描述你要处理的任务、问题或代码修改需求..."
      : hasActiveConversation
        ? "描述你要处理的任务、问题或代码修改需求..."
        : isMainAgentConversation
          ? "没有活动会话"
          : "描述你要处理的任务、问题或代码修改需求...";
  const showWelcomeLayout =
    (messageStatus === "empty" || (messageStatus === "ready" && messages.length === 0)) &&
    !loadError;

  if (isGroupConversation) {
    return <GroupChatWindow />;
  }

  return (
    <div className={showWelcomeLayout ? "chat-window chat-window-welcome" : "chat-window"}>
      <MessageList
        activeAgentName={activeAgent?.name}
        emptyMessage={emptyMessage}
        emptyTitle={emptyTitle}
        error={loadError}
        agentRunEvents={agentRunEvents}
        isSending={isSending}
        messages={messages}
        status={messageStatus}
      />
      {showWelcomeLayout ? null : (
        <MessageComposer
          contextUsage={isMainAgentConversation ? contextUsage : null}
          disabled={isComposerDisabled}
          error={sendError}
          isSending={isSending}
          placeholder={composerPlaceholder}
          onSend={handleSendText}
        />
      )}
    </div>
  );
}
