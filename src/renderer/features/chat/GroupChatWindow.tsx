import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type {
  DispatchRunStreamEvent,
  DispatchStepStatus,
  GroupRunEvent,
  GroupRunPlanAssignment,
  SendGroupMessageOutput
} from "../../../shared/groupChat";
import type { AgentHubApi } from "../../../shared/types";
import { useWorkspaceStore, workspaceStore } from "../../state/workspaceStore";
import { MessageList, type ChatMessage } from "./MessageList";
import { MentionInput } from "./MentionInput";
import { GroupMemberPanel } from "./GroupMemberPanel";
import { GroupMemberStrip } from "./GroupMemberStrip";
import { GroupRunPlanPanel } from "./GroupRunTimeline";

function getApi(): AgentHubApi {
  if (!window.agenthub) {
    throw new Error("AgentHub API is unavailable.");
  }

  return window.agenthub;
}

function toErrorMessage(error: unknown, fallback: string): string {
  return error instanceof Error ? error.message : fallback;
}

const FALLBACK_STEP_STATUSES: DispatchStepStatus[] = [
  "pending",
  "queued",
  "running",
  "streaming",
  "completed",
  "partial",
  "failed",
  "iteration_limit_reached",
  "waiting_for_permission",
  "cancelled",
  "skipped"
];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value : null;
}

function readNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function readStringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];
}

function readAssignmentScore(value: unknown): GroupRunPlanAssignment["score"] | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const agentId = readString(value.agentId);
  const taskId = readString(value.taskId);
  const finalScore = readNumber(value.finalScore);
  const capabilityMatch = readNumber(value.capabilityMatch);
  const toolMatch = readNumber(value.toolMatch);
  const contextRelevance = readNumber(value.contextRelevance);
  const historicalReliability = readNumber(value.historicalReliability);
  const confidence = readNumber(value.confidence);
  if (
    !agentId ||
    !taskId ||
    finalScore === null ||
    capabilityMatch === null ||
    toolMatch === null ||
    contextRelevance === null ||
    historicalReliability === null ||
    confidence === null
  ) {
    return undefined;
  }
  const matchedSkills = Array.isArray(value.matchedSkills)
    ? value.matchedSkills
        .filter(isRecord)
        .map((skill) => ({
          skillName: readString(skill.skillName) ?? "unknown",
          relevance: readNumber(skill.relevance) ?? 0,
          reason: readString(skill.reason) ?? ""
        }))
    : [];
  return {
    agentId,
    taskId,
    finalScore,
    capabilityMatch,
    toolMatch,
    contextRelevance,
    historicalReliability,
    confidence,
    matchedSkills,
    missingSkills: readStringArray(value.missingSkills),
    reason: readString(value.reason) ?? ""
  };
}

function readTextContent(content: unknown): string {
  return isRecord(content) && typeof content.text === "string" ? content.text : "";
}

function normalizeStepStatus(value: unknown): DispatchStepStatus {
  return FALLBACK_STEP_STATUSES.includes(value as DispatchStepStatus)
    ? (value as DispatchStepStatus)
    : "completed";
}

function getFallbackRunId(message: ChatMessage): string | null {
  return (
    readString(message.metadata?.dispatchRunId) ??
    readString(message.dispatchRunId) ??
    null
  );
}

function getFallbackAgentName(
  agentId: string,
  metadata: Record<string, unknown> | null | undefined,
  assignment: Record<string, unknown>
): string {
  const directName = readString(assignment.agentName);
  if (directName) {
    return directName;
  }

  const agentNames = isRecord(metadata?.agentNames) ? metadata.agentNames : null;
  const named = readString(agentNames?.[agentId]);
  return named ?? agentId;
}

function readFallbackPlanAssignments(message: ChatMessage): GroupRunPlanAssignment[] {
  const metadata = message.metadata;
  if (!metadata) {
    return [];
  }

  const rawAssignments = Array.isArray(metadata.assignments) ? metadata.assignments : [];
  const assignments = rawAssignments
    .filter(isRecord)
    .map((assignment, index): GroupRunPlanAssignment | null => {
      const agentId = readString(assignment.agentId);
      const instruction = readString(assignment.instruction);
      if (!agentId || !instruction) {
        return null;
      }

      return {
        stepId:
          readString(assignment.stepId) ??
          `${getFallbackRunId(message) ?? message.id}-step-${index}`,
        stepIndex: readNumber(assignment.stepIndex) ?? index,
        roundIndex: readNumber(metadata.roundIndex) ?? readNumber(assignment.roundIndex) ?? 0,
        assignmentId: readString(assignment.id),
        agentId,
        agentName: getFallbackAgentName(agentId, metadata, assignment),
        instruction,
        targetCriteria: readStringArray(assignment.targetCriteria),
        reason: readString(assignment.reason) ?? undefined,
        dependsOn: readStringArray(assignment.dependsOn),
        targetFiles: isRecord(assignment.subTask)
          ? readStringArray(assignment.subTask.targetFiles)
          : readStringArray(assignment.targetFiles),
        taskTitle: isRecord(assignment.subTask)
          ? readString(assignment.subTask.title) ?? undefined
          : readString(assignment.taskTitle) ?? undefined,
        taskType: isRecord(assignment.subTask)
          ? readString(assignment.subTask.taskType) ?? undefined
          : readString(assignment.taskType) ?? undefined,
        expectedOutputType: isRecord(assignment.subTask)
          ? (readString(assignment.subTask.expectedOutputType) as GroupRunPlanAssignment["expectedOutputType"])
          : (readString(assignment.expectedOutputType) as GroupRunPlanAssignment["expectedOutputType"]),
        riskLevel: isRecord(assignment.subTask)
          ? (readString(assignment.subTask.riskLevel) as GroupRunPlanAssignment["riskLevel"])
          : (readString(assignment.riskLevel) as GroupRunPlanAssignment["riskLevel"]),
        score: readAssignmentScore(assignment.score)
      };
    })
    .filter((assignment): assignment is GroupRunPlanAssignment => assignment !== null);

  if (assignments.length > 0) {
    return assignments;
  }

  const plan = isRecord(metadata.plan) ? metadata.plan : null;
  const steps = Array.isArray(plan?.steps) ? plan.steps : [];
  return steps
    .filter(isRecord)
    .map((step, index): GroupRunPlanAssignment | null => {
      const agentId = readString(step.agent_id);
      const instruction = readString(step.instruction);
      if (!agentId || !instruction) {
        return null;
      }

      return {
        stepId: `${getFallbackRunId(message) ?? message.id}-step-${index}`,
        stepIndex: index,
        roundIndex: readNumber(metadata.roundIndex) ?? 0,
        assignmentId: null,
        agentId,
        agentName: getFallbackAgentName(agentId, metadata, step),
        instruction,
        targetCriteria: readStringArray(step.targetCriteria),
        reason: readString(step.reason) ?? undefined,
        dependsOn: readStringArray(step.dependsOn),
        targetFiles: readStringArray(step.targetFiles),
        taskTitle: readString(step.taskTitle) ?? undefined,
        taskType: readString(step.taskType) ?? undefined,
        expectedOutputType: readString(step.expectedOutputType) as GroupRunPlanAssignment["expectedOutputType"],
        riskLevel: readString(step.riskLevel) as GroupRunPlanAssignment["riskLevel"],
        score: readAssignmentScore(step.score)
      };
    })
    .filter((assignment): assignment is GroupRunPlanAssignment => assignment !== null);
}

function createFallbackPlanEvents(message: ChatMessage): GroupRunEvent[] {
  if (message.messageType !== "dispatch_plan") {
    return [];
  }

  const groupRunId = getFallbackRunId(message);
  const assignments = readFallbackPlanAssignments(message);
  if (!groupRunId || assignments.length === 0) {
    return [];
  }

  return [
    {
      id: `fallback-plan-${message.id}`,
      groupRunId,
      conversationId: message.conversationId,
      seq: 0,
      type: "plan_created",
      createdAt: message.createdAt,
      payload: {
        mode: "auto_dispatch",
        roundIndex: readNumber(message.metadata?.roundIndex) ?? 0,
        assignments
      }
    }
  ];
}

function createFallbackStepUpdateEvent(
  event: Extract<DispatchRunStreamEvent, { type: "dispatch_step_update" }>,
  conversationId: string
): GroupRunEvent {
  const status = normalizeStepStatus(event.status);
  const completed =
    status !== "pending" &&
    status !== "queued" &&
    status !== "running" &&
    status !== "streaming" &&
    status !== "waiting_for_permission";
  const type =
    status === "failed"
      ? "agent_failed"
      : completed
        ? "agent_completed"
        : "agent_started";
  const summary =
    status === "failed"
      ? "执行失败，错误详情已保存到后台。"
      : completed
        ? "已完成，摘要正在写入。"
        : "";

  return {
    id: `fallback-step-${event.stepId}-${status}`,
    groupRunId: event.dispatchRunId,
    conversationId,
    seq: 100 + event.stepIndex,
    type,
    createdAt: new Date().toISOString(),
    payload: {
      stepId: event.stepId,
      stepIndex: event.stepIndex,
      roundIndex: 0,
      agentId: event.agentId,
      status,
      ...(summary ? { summary } : {}),
      detailAvailable: completed
    }
  } as GroupRunEvent;
}

function buildFallbackEventsFromMessages(messages: ChatMessage[]): GroupRunEvent[] {
  const events: GroupRunEvent[] = [];
  const plannedStepIndexes = new Map<string, number[]>();

  for (const message of messages) {
    const planEvents = createFallbackPlanEvents(message);
    events.push(...planEvents);

    for (const event of planEvents) {
      if (event.type !== "plan_created") {
        continue;
      }
      for (const assignment of event.payload.assignments) {
        const key = `${event.groupRunId}:${assignment.agentId}`;
        plannedStepIndexes.set(key, [
          ...(plannedStepIndexes.get(key) ?? []),
          assignment.stepIndex
        ]);
      }
    }
  }

  for (const message of messages) {
    if (message.messageType !== "agent_assignment") {
      continue;
    }

    const groupRunId = getFallbackRunId(message);
    const metadata = message.metadata;
    const agentId = readString(metadata?.agentId) ?? readString(message.senderId);
    if (!groupRunId || !agentId) {
      continue;
    }

    const status = normalizeStepStatus(metadata?.status);
    const stepIndexes = plannedStepIndexes.get(`${groupRunId}:${agentId}`);
    const stepIndex = readNumber(metadata?.stepIndex) ?? stepIndexes?.shift() ?? 0;
    const summary = readString(metadata?.summary) ?? readTextContent(message.content);
    const type = status === "failed" ? "agent_failed" : "agent_completed";

    events.push({
      id: `fallback-assignment-${message.id}`,
      groupRunId,
      conversationId: message.conversationId,
      seq: 200 + stepIndex,
      type,
      createdAt: message.createdAt,
      payload: {
        stepId:
          readString(metadata?.stepId) ??
          readString(message.dispatchStepId) ??
          `${groupRunId}-step-${stepIndex}`,
        stepIndex,
        roundIndex: readNumber(metadata?.roundIndex) ?? 0,
        agentId,
        agentName: readString(metadata?.agentName) ?? agentId,
        status,
        summary: summary || "已完成，结果已保存到后台详情。",
        diffProposalId: readString(metadata?.diffProposalId) ?? undefined,
        detailAvailable: metadata?.detailAvailable !== false,
        errorMessage: status === "failed" ? summary : undefined
      }
    } as GroupRunEvent);
  }

  return events;
}

function mergeGroupRunEvents(
  fallbackEvents: GroupRunEvent[],
  realEvents: GroupRunEvent[]
): GroupRunEvent[] {
  const realStepKeys = new Set<string>();
  for (const event of realEvents) {
    if (
      event.type !== "agent_started" &&
      event.type !== "agent_progress" &&
      event.type !== "agent_completed" &&
      event.type !== "agent_failed"
    ) {
      continue;
    }
    const stepId = readString(event.payload.stepId);
    if (stepId) {
      realStepKeys.add(`${event.groupRunId}:${stepId}`);
    }
  }

  const byId = new Map<string, GroupRunEvent>();
  for (const event of fallbackEvents) {
    if (
      event.type === "agent_started" ||
      event.type === "agent_progress" ||
      event.type === "agent_completed" ||
      event.type === "agent_failed"
    ) {
      const stepId = readString(event.payload.stepId);
      if (stepId && realStepKeys.has(`${event.groupRunId}:${stepId}`)) {
        continue;
      }
    }
    byId.set(event.id, event);
  }
  for (const event of realEvents) {
    byId.set(event.id, event);
  }
  return [...byId.values()];
}

export function GroupChatWindow() {
  const {
    activeConversation,
    activeWorkspace,
    contacts,
    messagesByConversationId,
    isSendingByConversationId,
    membersByGroupConversation,
    setConversationMessages,
    setConversationSending,
    setActiveDispatchRunId,
    addGroupMember,
    removeGroupMember,
    loadGroupMembers,
    loadWorkspaceTree
  } = useWorkspaceStore();

  const [messageStatus, setMessageStatus] = useState<"idle" | "loading" | "ready" | "empty" | "error">("idle");
  const [loadError, setLoadError] = useState<string | null>(null);
  const [sendError, setSendError] = useState<string | null>(null);
  const [showMemberPanel] = useState(false);
  const [groupRunEvents, setGroupRunEvents] = useState<GroupRunEvent[]>([]);
  const [fallbackGroupRunEvents, setFallbackGroupRunEvents] = useState<GroupRunEvent[]>([]);
  const requestIdRef = useRef(0);

  const conversation = activeConversation;
  const conversationId = conversation?.id ?? "";
  const messages = messagesByConversationId[conversationId] ?? [];
  const visibleMessages = messages.filter((message) => message.messageType !== "agent_assignment");
  const isSending = isSendingByConversationId[conversationId] ?? false;
  const members = membersByGroupConversation[conversationId] ?? [];
  const timelineEvents = useMemo(
    () => mergeGroupRunEvents(fallbackGroupRunEvents, groupRunEvents),
    [fallbackGroupRunEvents, groupRunEvents]
  );
  const agentNameMap: Record<string, string> = {};
  for (const member of members) {
    if (member.memberType === "agent" && member.agent) {
      agentNameMap[member.memberId] = member.agent.name;
    }
  }

  const availableAgents = contacts.filter(
    (agent) =>
      agent.role !== "main" &&
      (agent.status === "available" || agent.status === "error") &&
      !members.some((m) => m.memberType === "agent" && m.memberId === agent.id)
  );

  const loadMessages = useCallback(
    async (cid: string, requestId: number) => {
      setMessageStatus("loading");
      setLoadError(null);

      try {
        const [history, events] = await Promise.all([
          getApi().message.list(cid),
          getApi().dispatch.listEvents(cid)
        ]);

        if (requestId !== requestIdRef.current) return;

        const chatHistory = history as ChatMessage[];
        setConversationMessages(cid, chatHistory);
        setGroupRunEvents(events);
        setFallbackGroupRunEvents(buildFallbackEventsFromMessages(chatHistory));
        setMessageStatus(history.length > 0 ? "ready" : "empty");
      } catch (error) {
        if (requestId !== requestIdRef.current) return;

        setConversationMessages(cid, []);
        setGroupRunEvents([]);
        setFallbackGroupRunEvents([]);
        setLoadError(toErrorMessage(error, "加载消息失败。"));
        setMessageStatus("error");
      }
    },
    [setConversationMessages]
  );

  useEffect(() => {
    const cid = conversationId;
    const requestId = ++requestIdRef.current;

    setSendError(null);

    if (!cid) {
      setMessageStatus("empty");
      return;
    }

    void loadMessages(cid, requestId);
    void loadGroupMembers(cid);
  }, [conversationId, loadMessages, loadGroupMembers]);

  const handleSendText = useCallback(
    async (text: string, mentionAgentIds: string[]) => {
      if (!activeWorkspace || !conversation) {
        setSendError("请先选择会话。");
        return;
      }

      // Invalidate any pending loadMessages from useEffect to prevent stale overwrite
      ++requestIdRef.current;

      const cid = conversation.id;
      setSendError(null);
      setConversationSending(cid, true);

      const pendingMessage: ChatMessage = {
        id: `pending-${Date.now()}`,
        workspaceId: activeWorkspace.id,
        conversationId: cid,
        senderType: "user",
        senderId: "local-user",
        messageType: "text",
        content: { text },
        createdAt: new Date().toISOString(),
        deliveryState: "sending"
      };

      const currentMessages = workspaceStore.getState().messagesByConversationId[cid] ?? [];
      setConversationMessages(cid, [...currentMessages, pendingMessage]);
      setMessageStatus("ready");

      try {
        const result: SendGroupMessageOutput = await getApi().groupMessage.send(
          { conversationId: cid, content: text, mentionAgentIds },
          {
            onStepUpdate: (event: DispatchRunStreamEvent) => {
              if (event.type === "group_run_event") {
                setGroupRunEvents((currentEvents) => {
                  if (currentEvents.some((item) => item.id === event.event.id)) {
                    return currentEvents;
                  }
                  return [...currentEvents, event.event];
                });
                return;
              }

              if (event.type === "dispatch_plan_message") {
                const planMessage = event.message as ChatMessage;
                const currentMessages =
                  workspaceStore.getState().messagesByConversationId[cid] ?? [];
                if (!currentMessages.some((message) => message.id === planMessage.id)) {
                  setConversationMessages(cid, [...currentMessages, planMessage]);
                }

                const fallbackEvents = buildFallbackEventsFromMessages([
                  planMessage
                ]);
                if (fallbackEvents.length > 0) {
                  setFallbackGroupRunEvents((currentEvents) =>
                    mergeGroupRunEvents(currentEvents, fallbackEvents)
                  );
                }
                return;
              }

              setFallbackGroupRunEvents((currentEvents) =>
                mergeGroupRunEvents(currentEvents, [
                  createFallbackStepUpdateEvent(event, cid)
                ])
              );

              const storeState = workspaceStore.getState();
              const steps = storeState.dispatchStepsByRun[event.dispatchRunId] ?? [];
              const updatedSteps = steps.map((s) =>
                s.id === event.stepId ? { ...s, status: event.status } : s
              );

              workspaceStore.setState({
                dispatchStepsByRun: {
                  ...storeState.dispatchStepsByRun,
                  [event.dispatchRunId]: updatedSteps
                }
              });
            }
          }
        );

        setActiveDispatchRunId(result.dispatchRun.id);
        const storeState = workspaceStore.getState();
        const existingRuns = storeState.dispatchRunsByConversation[cid] ?? [];
        workspaceStore.setState({
          dispatchRunsByConversation: {
            ...storeState.dispatchRunsByConversation,
            [cid]: [
              result.dispatchRun,
              ...existingRuns.filter((run) => run.id !== result.dispatchRun.id)
            ]
          },
          dispatchStepsByRun: {
            ...storeState.dispatchStepsByRun,
            [result.dispatchRun.id]: result.dispatchSteps
          }
        });

        const [finalMessages, finalEvents] = await Promise.all([
          getApi().message.list(cid),
          getApi().dispatch.listEvents(cid)
        ]);

        if (finalMessages.length > 0) {
          setConversationMessages(cid, finalMessages as ChatMessage[]);
        }
        setGroupRunEvents(finalEvents);
        setFallbackGroupRunEvents(buildFallbackEventsFromMessages(finalMessages as ChatMessage[]));
      } catch (error) {
        const errorMessage = toErrorMessage(error, "发送消息失败。");
        const prev = workspaceStore.getState().messagesByConversationId[cid] ?? [];
        setConversationMessages(
          cid,
          prev.map((m) =>
            m.id === pendingMessage.id
              ? { ...m, deliveryState: "failed" as const, deliveryError: errorMessage }
              : m
          )
        );
        setSendError(errorMessage);
      } finally {
        setConversationSending(cid, false);
      }
    },
    [
      activeWorkspace,
      conversation,
      setConversationMessages,
      setConversationSending,
      setActiveDispatchRunId
    ]
  );

  const handleAddAgent = useCallback(
    async (agentId: string) => {
      if (!conversation) return;
      await addGroupMember(conversation.id, agentId);
    },
    [conversation, addGroupMember]
  );

  const handleRemoveMember = useCallback(
    async (memberId: string) => {
      if (!conversation) return;
      await removeGroupMember(conversation.id, memberId);
    },
    [conversation, removeGroupMember]
  );

  const hasActiveConversation = Boolean(activeWorkspace && conversation);
  const composerPlaceholder = hasActiveConversation
    ? "输入消息，使用 @ 提及 Agent..."
    : "没有活动会话";

  return (
    <div className="group-chat-window">
      <div className="group-chat-main">
        <GroupMemberStrip members={members} />

        <GroupRunPlanPanel events={timelineEvents} />

        <MessageList
          activeAgentName={undefined}
          agentNameMap={agentNameMap}
          emptyMessage="发送消息开始群聊协作"
          emptyTitle="群聊"
          error={loadError}
          groupRunEvents={timelineEvents}
          groupRunWorkspaceId={activeWorkspace?.id ?? null}
          isSending={isSending}
          messages={visibleMessages}
          status={messageStatus}
        />

        {sendError ? (
          <div className="group-chat-error" role="alert">
            {sendError}
          </div>
        ) : null}

        <MentionInput
          members={members}
          disabled={!hasActiveConversation || isSending}
          placeholder={composerPlaceholder}
          onSend={(text, mentionAgentIds) => void handleSendText(text, mentionAgentIds)}
        />
      </div>

      {showMemberPanel && conversation ? (
        <GroupMemberPanel
          conversation={conversation}
          members={members}
          availableAgents={availableAgents}
          onAddAgent={(agentId) => void handleAddAgent(agentId)}
          onRemoveMember={(memberId) => void handleRemoveMember(memberId)}
        />
      ) : null}
    </div>
  );
}
