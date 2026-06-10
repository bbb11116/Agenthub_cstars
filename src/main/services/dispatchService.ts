import { randomUUID } from "node:crypto";
import type {
  Agent,
  Conversation,
  Message,
  RunAgentOutput,
  RunAgentStreamEvent,
  Workspace
} from "../../shared/domain";
import type { Artifact } from "../../shared/artifact";
import {
  MAX_DISPATCH_STEPS,
  type DispatchMode,
  DispatchPlan,
  DispatchRun,
  DispatchRunStatus,
  DispatchRunStreamEvent,
  DispatchStep,
  DispatchStepStatus,
  DispatchGroupTasksInput,
  DispatchGroupTasksOutput,
  GroupRunEvent,
  GroupRunAgentProgressPayload,
  GroupRunPlanAssignment,
  MainAgentDiffReviewOutput,
  PreviousTaskSummary,
  SendGroupMessageOutput,
  AcceptanceCriterion,
  AgentAssignment,
  AgentDispatchScore,
  CapabilityMatchResult,
  OrchestratorReview,
  SubTask,
  SubAgentResult,
  SubAgentResultMetadata,
  SubAgentTaskInput,
  SubAgentTaskPreviousOutput,
  SubAgentTaskSelectedMessage
} from "../../shared/groupChat";
import { AGENT_EXECUTION_LIMITS } from "../../shared/agentExecution";
import { isBuiltinProvider } from "../../shared/runtime";
import type { DispatchPlanStepInput } from "./mainAgentDecision";
import {
  runGroupCapabilityMatchJudge,
  runGroupOrchestratorDecision,
  runGroupOrchestratorSynthesis
} from "./orchestratorRuntimeService";
import { getDatabase, type AgentHubDatabase } from "../db";
import { getAgentById } from "../db/repositories/agentRepo";
import {
  getConversationById,
  getFirstConversationByAgent,
  createConversation
} from "../db/repositories/conversationRepo";
import { getWorkspaceById } from "../db/repositories/workspaceRepo";
import {
  getRecentMessagesByConversation,
  getMessageById,
  deleteMessage
} from "../db/repositories/messageRepo";
import {
  createDispatchRun,
  getDispatchRunById,
  getDispatchRunsByConversation,
  updateDispatchRunExecution,
  updateDispatchRunStatus
} from "../db/repositories/dispatchRunRepo";
import {
  createDispatchStep,
  getDispatchStepById,
  getStepsByDispatchRun,
  updateStepStatus,
  updateStepSubAgentResult,
  updateStepInputContextSnapshot
} from "../db/repositories/dispatchStepRepo";
import { getAgentRunByDispatchStep } from "../db/repositories/agentRunRepo";
import { createGroupRunEvent } from "../db/repositories/groupRunEventRepo";
import { getActiveMembers } from "../db/repositories/conversationMemberRepo";
import {
  getDiffProposalsByDispatchRun,
  updateDiffProposal
} from "../db/repositories/diffRepo";
import { runAgent, type AgentRunStreamSink } from "./agentRunService";
import { runAgentWithConversation } from "./agentRunWithConversationService";
import { buildMainAgentPrompt } from "./localRuntimeRunner";
import { getDiffProposal } from "./diffService";
import { getEffectiveAgentCapabilities } from "./agentSkillCatalogService";
import {
  buildDefaultAcceptanceCriteria,
  createFallbackUserFacingSummary,
  parseSubAgentResult,
  reviewAcceptanceCriteria
} from "./groupExecutionService";
import { parseMentionNames } from "./dispatch/mentionParser";
import { resolveExecutionWorkspaceForGroup } from "./workspaceContextResolver";
import { buildGroupSubAgentMemoryContext } from "./memoryContextService";
import { updateExperiencesAfterGroupDispatch } from "./agentProjectExperienceService";
import { createMessage as insertMessage } from "./messageService";
import { createArtifact } from "./artifactService";
import { listByGroup as listExperiencesByGroup } from "../db/repositories/agentProjectExperienceRepo";
import {
  buildExecutionBatches,
  calculateDispatchScore,
  calculateToolMatch,
  fallbackCapabilityMatch,
  filterDispatchCandidates,
  resolveRequiredToolNames
} from "./dispatch/agentScoring";

class DispatchError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DispatchError";
  }
}

export type DispatchStreamHandler = (event: DispatchRunStreamEvent) => void;

const MAX_SUB_AGENT_OUTPUT_CONTINUATIONS = 3;
const LONG_DELIVERABLE_ARTIFACT_THRESHOLD = 1_500;
const OUTPUT_TRUNCATION_PATTERN =
  /truncated|timed out|max_completion_tokens|max_tokens|length|stream idle/i;

const ACTIVE_DISPATCH_RUN_STATUSES: ReadonlySet<DispatchRunStatus> = new Set([
  "planning",
  "plan_created",
  "running",
  "running_subagents",
  "reviewing",
  "redispatching"
]);

const RECOGNIZED_TOOL_HINT =
  "已知工具名: readFile / writeDiff / applyDiff / previewArtifact / gitStatus / webSearch / webFetch（也接受 snake_case 别名如 read_file）。未识别的工具名会被静默忽略；推荐将 requiredTools 留空 []，由系统按 expectedOutputType 自动推导。";

function buildDispatchFailureHint(input: {
  error: string;
  attemptedSubTasks?: SubTask[];
  droppedToolNames?: string[];
}): string {
  const parts: string[] = [
    `上一次分派未执行: ${input.error}`
  ];

  if (input.attemptedSubTasks && input.attemptedSubTasks.length > 0) {
    parts.push(
      "",
      "你刚才尝试的分派计划:",
      ...input.attemptedSubTasks.map((subTask) => {
        const tools = subTask.requiredTools.length > 0
          ? subTask.requiredTools.join(", ")
          : "(空)";
        return `- [${subTask.id}] ${subTask.title} | expectedOutputType=${subTask.expectedOutputType} | requiredTools=[${tools}]`;
      })
    );
  }

  if (input.droppedToolNames && input.droppedToolNames.length > 0) {
    parts.push(
      "",
      `系统已忽略这些未识别的工具名: ${input.droppedToolNames.join(", ")}`,
      RECOGNIZED_TOOL_HINT
    );
  } else {
    parts.push("", RECOGNIZED_TOOL_HINT);
  }

  parts.push(
    "",
    "请基于以上信息修正后重新输出 DispatchPlan；不要简单重复上一次的 JSON。"
  );
  return parts.join("\n");
}

function emitGroupRunEvent(
  input: {
    groupRunId: string;
    conversationId: string;
    type: GroupRunEvent["type"];
    payload: GroupRunEvent["payload"];
  },
  db: AgentHubDatabase,
  stream?: DispatchStreamHandler
): GroupRunEvent {
  const event = createGroupRunEvent(input, db);
  stream?.({ type: "group_run_event", event });
  return event;
}

function compactProgressBody(value: string | undefined): string | undefined {
  const text = value?.replace(/\s+/g, " ").trim();
  if (!text) {
    return undefined;
  }
  return text.length > 300 ? `${text.slice(0, 297).trimEnd()}...` : text;
}

function emitStepProgress(
  input: {
    conversationId: string;
    step: DispatchStep;
    agentName?: string;
    title: string;
    body?: string;
    level?: GroupRunAgentProgressPayload["level"];
    phase: GroupRunAgentProgressPayload["phase"];
    status?: DispatchStepStatus;
  },
  db: AgentHubDatabase,
  stream?: DispatchStreamHandler
): GroupRunEvent {
  return emitGroupRunEvent(
    {
      groupRunId: input.step.dispatchRunId,
      conversationId: input.conversationId,
      type: "agent_progress",
      payload: {
        stepId: input.step.id,
        stepIndex: input.step.stepIndex,
        roundIndex: input.step.roundIndex,
        agentId: input.step.agentId,
        agentName: input.agentName,
        instruction: input.step.instruction,
        status: input.status,
        title: input.title,
        body: compactProgressBody(input.body),
        level: input.level ?? "info",
        phase: input.phase
      }
    },
    db,
    stream
  );
}

function getMessageText(content: unknown): string {
  return typeof content === "object" &&
    content !== null &&
    "text" in content &&
    typeof (content as { text?: unknown }).text === "string"
    ? (content as { text: string }).text
    : JSON.stringify(content);
}

const SUB_AGENT_REQUIRED_RESULT_FIELDS = [
  "agentId",
  "status",
  "summary",
  "completedCriteria",
  "unresolvedCriteria",
  "filesRead",
  "assumptions",
  "risks"
];

const GROUP_SUB_AGENT_TASK_CONSTRAINTS = [
  "只处理 assignedInstruction 和 targetCriteria 覆盖的任务。",
  "只使用 relevantContext 中提供的上下文；不要假设自己看过完整群聊历史。",
  "不要直接修改 Workspace 文件。",
  "需要代码或文件变更时，只能生成绑定当前 dispatch step 的 DiffProposal，等待用户确认后应用。",
  "不要要求系统继续调用其他 Agent。",
  "最终必须返回一个合法 SubAgentResult JSON 对象。"
];

function getSubAgentMessageRole(
  message: Message,
  conversation: Conversation
): SubAgentTaskSelectedMessage["role"] {
  if (message.senderType === "user") return "user";
  if (message.senderType === "system") return "system";
  return message.senderId === conversation.mainAgentId ? "main_agent" : "sub_agent";
}

function toSelectedMessage(
  message: Message,
  conversation: Conversation,
  reason: string
): SubAgentTaskSelectedMessage {
  return {
    id: message.id,
    role: getSubAgentMessageRole(message, conversation),
    senderId: message.senderId,
    text: getMessageText(message.content),
    reason,
    createdAt: message.createdAt
  };
}

function toPreviousAgentOutputs(
  previousOutputs: PreviousTaskSummary[]
): SubAgentTaskPreviousOutput[] | undefined {
  if (previousOutputs.length === 0) {
    return undefined;
  }

  return previousOutputs.map((previous, index) => ({
    summary: previous.summary,
    keyConstraints: previous.keyConstraints,
    diffSummary: previous.diffSummary,
    failedItems: previous.failedItems,
    nextRequiredActions: previous.nextRequiredActions,
    reason: `sequential_dependency_${index + 1}`
  }));
}

function formatPreviousTaskSummaryForMemory(previous: PreviousTaskSummary): string {
  return [
    previous.summary,
    previous.keyConstraints.length
      ? `Key constraints: ${previous.keyConstraints.join("; ")}`
      : "",
    previous.diffSummary ? `Diff summary: ${previous.diffSummary}` : "",
    previous.failedItems?.length ? `Failed items: ${previous.failedItems.join("; ")}` : "",
    previous.nextRequiredActions?.length
      ? `Next actions: ${previous.nextRequiredActions.join("; ")}`
      : ""
  ]
    .filter(Boolean)
    .join("\n");
}

function listAllowedTools(agent: Agent): string[] {
  return Object.entries({ ...agent.tools, applyDiff: false })
    .filter(([, enabled]) => enabled)
    .map(([tool]) => tool);
}

function buildSubAgentTaskInput(input: {
  agent: Agent;
  workspace: Workspace;
  conversation: Conversation;
  step: DispatchStep;
  triggerMessage: Message;
  previousOutputs: PreviousTaskSummary[];
  criteria: AcceptanceCriterion[];
  memorySummary: string;
}): SubAgentTaskInput {
  return {
    schemaVersion: 1,
    taskId: input.step.assignmentId ?? input.step.id,
    dispatchRunId: input.step.dispatchRunId,
    dispatchStepId: input.step.id,
    parentMessageId: input.triggerMessage.id,
    userGoal: getMessageText(input.triggerMessage.content),
    assignedInstruction: input.step.instruction,
    assignedAgent: {
      id: input.agent.id,
      name: input.agent.name,
      role: input.agent.role,
      systemPrompt: input.agent.systemPrompt
    },
    targetCriteria: input.criteria,
    constraints: GROUP_SUB_AGENT_TASK_CONSTRAINTS,
    allowedTools: listAllowedTools(input.agent),
    workspace: {
      rootPath: input.workspace.rootPath,
      gitEnabled: input.workspace.gitEnabled
    },
    relevantContext: {
      selectedMessages: [
        toSelectedMessage(input.triggerMessage, input.conversation, "本轮用户原始需求")
      ],
      previousAgentOutputs: toPreviousAgentOutputs(input.previousOutputs),
      workspaceSummary: `name: ${input.workspace.name}`,
      memorySummary: input.memorySummary.trim() || undefined
    },
    expectedOutput: {
      format: "sub_agent_result_json",
      requiredFields: SUB_AGENT_REQUIRED_RESULT_FIELDS
    }
  };
}

function getAgentDisplayName(agentId: string, db: AgentHubDatabase): string {
  return getAgentById(agentId, db)?.name ?? agentId;
}

function getAgentReplyMessage(result: RunAgentOutput): Message | undefined {
  return result.messages.find(
    (message) => message.senderType === "agent" && message.messageType === "text"
  );
}

function getAgentReplyText(message: Message | undefined): string {
  if (!message) {
    return "";
  }
  return typeof message.content === "object" &&
    message.content !== null &&
    "text" in message.content &&
    typeof (message.content as { text?: unknown }).text === "string"
    ? (message.content as { text: string }).text
    : JSON.stringify(message.content);
}

function getSubAgentRunMetadata(
  result: RunAgentOutput,
  replyText: string,
  continuationAttempts: number
): SubAgentResultMetadata {
  const error = result.runResult?.error ?? "";
  const outputTruncated =
    (
      result.runResult?.status === "failed" &&
      OUTPUT_TRUNCATION_PATTERN.test(error)
    ) ||
    /\[(?:output|stdout|stderr) truncated\]/i.test(replyText);
  const timeoutTriggered = /timed out|stream idle/i.test(error);

  return {
    outputTruncated: outputTruncated ? true : undefined,
    timeoutTriggered: timeoutTriggered ? true : undefined,
    continuationAttempts: continuationAttempts > 0 ? continuationAttempts : undefined,
    recoveredFromTruncation:
      continuationAttempts > 0 && !outputTruncated && !timeoutTriggered
        ? true
        : undefined
  };
}

function isLikelyIncompleteStructuredOutput(
  rawText: string,
  parseError: string | undefined
): boolean {
  if (!parseError) {
    return false;
  }

  const trimmed = rawText.trim();
  if (!trimmed.startsWith("{") && !/^```json/i.test(trimmed)) {
    return false;
  }

  return /unexpected end|unterminated|not found|end of json|bad control character/i.test(
    parseError
  );
}

function parseBestSubAgentResult(input: {
  agentId: string;
  targetCriteria: string[];
  aggregateText: string;
  latestText: string;
  runResult: RunAgentOutput["runResult"];
  runMetadata: SubAgentResultMetadata;
}): SubAgentResult {
  const candidates =
    input.latestText.trim() && input.latestText !== input.aggregateText
      ? [input.aggregateText, input.latestText]
      : [input.aggregateText];
  const parsed = candidates.map((rawText) =>
    parseSubAgentResult({
      agentId: input.agentId,
      targetCriteria: input.targetCriteria,
      rawText,
      runResult: input.runResult,
      runMetadata: input.runMetadata
    })
  );

  return parsed.find((result) => !result.parseError) ?? parsed[0];
}

function buildSubAgentContinuationPrompt(input: {
  attempt: number;
  maxAttempts: number;
  targetCriteria: string[];
  previousText: string;
  reason: string;
}): string {
  const tail = input.previousText.slice(-6_000);

  return [
    "继续补齐上一轮被截断或不完整的 SubAgentResult。",
    "这是同一个 AgentHub dispatch step，不要重新执行任务，不要改动已完成事实。",
    "优先从上一轮断点处继续输出，避免重复已经输出的内容。",
    "如果无法可靠从断点继续，直接输出一个完整、合法的 SubAgentResult JSON 对象。",
    "最终必须能被系统解析为一个 SubAgentResult JSON 对象。",
    `续写轮次: ${input.attempt}/${input.maxAttempts}`,
    `继续原因: ${input.reason}`,
    `目标验收项: ${input.targetCriteria.join(", ") || "无"}`,
    "",
    "上一轮已输出内容末尾:",
    tail || "无"
  ].join("\n");
}

function createSubAgentMarkdownArtifact(
  input: {
    workspaceId: string;
    conversationId: string;
    agentId: string;
    agentName: string;
    step: DispatchStep;
    content: string;
    titleSuffix: string;
  },
  db: AgentHubDatabase
): Artifact {
  return createArtifact(
    {
      workspaceId: input.workspaceId,
      conversationId: input.conversationId,
      agentId: input.agentId,
      type: "markdown",
      title: `${input.agentName} - Step ${input.step.stepIndex + 1} ${input.titleSuffix}`,
      content: input.content,
      language: "markdown"
    },
    db
  );
}

function getArtifactPreview(content: string): string {
  const compact = content.replace(/\s+/g, " ").trim();
  return compact.length > 240 ? `${compact.slice(0, 237).trimEnd()}...` : compact;
}

function attachArtifactsToSubAgentResult(
  result: SubAgentResult,
  artifacts: Artifact[]
): SubAgentResult {
  if (artifacts.length === 0) {
    return result;
  }

  const existingArtifactIds = new Set(result.artifactIds ?? []);
  const existingOutputs = result.outputs ?? [];
  const artifactOutputs = artifacts
    .filter((artifact) => !existingArtifactIds.has(artifact.id))
    .map((artifact) => ({
      type: "markdown" as const,
      artifactId: artifact.id,
      preview: getArtifactPreview(artifact.content),
      isComplete: true
    }));

  return {
    ...result,
    artifactIds: [
      ...Array.from(existingArtifactIds),
      ...artifacts
        .map((artifact) => artifact.id)
        .filter((id) => !existingArtifactIds.has(id))
    ],
    outputs: [...existingOutputs, ...artifactOutputs]
  };
}

function maybeMoveLongDeliverableToArtifact(
  input: {
    result: SubAgentResult;
    workspaceId: string;
    conversationId: string;
    agentId: string;
    agentName: string;
    step: DispatchStep;
  },
  db: AgentHubDatabase
): { result: SubAgentResult; artifacts: Artifact[] } {
  const deliverable = input.result.deliverable?.trim();
  if (!deliverable || deliverable.length <= LONG_DELIVERABLE_ARTIFACT_THRESHOLD) {
    return { result: input.result, artifacts: [] };
  }

  const artifact = createSubAgentMarkdownArtifact(
    {
      workspaceId: input.workspaceId,
      conversationId: input.conversationId,
      agentId: input.agentId,
      agentName: input.agentName,
      step: input.step,
      content: deliverable,
      titleSuffix: "Deliverable"
    },
    db
  );

  return {
    result: attachArtifactsToSubAgentResult(
      {
        ...input.result,
        deliverable: input.result.summary
      },
      [artifact]
    ),
    artifacts: [artifact]
  };
}

function buildSubAgentManifestRepairPrompt(input: {
  artifact: Artifact;
  targetCriteria: string[];
  previousSummary: string;
}): string {
  return [
    "上一轮输出已作为 Markdown 产物保存。现在不要重复正文，只返回一个短小、合法的 SubAgentResult JSON 对象。",
    "JSON 必须作为本轮最终消息返回，不要包含 markdown fence 之外的解释。",
    "根据已保存产物判断你完成了哪些验收项；只有确实由产物支持的验收项才能放入 completedCriteria。",
    "",
    `artifactId: ${input.artifact.id}`,
    `artifactTitle: ${input.artifact.title}`,
    `artifactPreview: ${getArtifactPreview(input.artifact.content)}`,
    `targetCriteria: ${input.targetCriteria.join(", ") || "无"}`,
    input.previousSummary ? `previousParseSummary: ${input.previousSummary}` : "",
    "",
    "返回 JSON schema:",
    "{",
    '  "status": "completed | partial | failed | no_changes_needed | iteration_limit_reached",',
    '  "summary": "短摘要，不超过 200 字",',
    '  "completedCriteria": ["criterion-id"],',
    '  "unresolvedCriteria": ["criterion-id"],',
    '  "artifactIds": ["上面的 artifactId"],',
    '  "outputs": [{ "type": "markdown", "artifactId": "上面的 artifactId", "preview": "短预览", "isComplete": true }],',
    '  "evidence": [{ "criterionId": "criterion-id", "artifactId": "上面的 artifactId", "summary": "该产物如何满足此验收项" }],',
    '  "filesRead": [],',
    '  "assumptions": [],',
    '  "risks": []',
    "}"
  ]
    .filter((line) => line.trim().length > 0)
    .join("\n");
}

function formatSubAgentResultForContext(result: SubAgentResult): PreviousTaskSummary {
  const lines = [
    `status: ${result.status}`,
    `summary: ${result.summary}`,
    result.completedCriteria.length > 0
      ? `completedCriteria: ${result.completedCriteria.join(", ")}`
      : "",
    result.unresolvedCriteria.length > 0
      ? `unresolvedCriteria: ${result.unresolvedCriteria.join(", ")}`
      : "",
    result.artifactIds && result.artifactIds.length > 0
      ? `artifactIds: ${result.artifactIds.join(", ")}`
      : "",
    result.outputs && result.outputs.length > 0
      ? `outputs: ${result.outputs
          .map((output) =>
            [
              output.type,
              output.artifactId ? `artifact=${output.artifactId}` : "",
              output.diffProposalId ? `diff=${output.diffProposalId}` : "",
              output.preview ? `preview=${output.preview}` : ""
            ]
              .filter(Boolean)
              .join(" ")
          )
          .join("; ")}`
      : "",
    result.evidence && result.evidence.length > 0
      ? `evidence: ${result.evidence
          .map((item) => `${item.criterionId}: ${item.summary}`)
          .join("; ")}`
      : "",
    result.assumptions.length > 0 ? `assumptions: ${result.assumptions.join("; ")}` : "",
    result.risks.length > 0 ? `risks: ${result.risks.join("; ")}` : ""
  ].filter(Boolean);

  return {
    summary: lines.join("\n"),
    keyConstraints: result.assumptions,
    diffSummary: result.diffProposalId ? `DiffProposal: ${result.diffProposalId}` : undefined,
    failedItems:
      result.unresolvedCriteria.length > 0 || result.risks.length > 0
        ? [...result.unresolvedCriteria, ...result.risks]
        : undefined,
    nextRequiredActions: result.nextSuggestedTask ? [result.nextSuggestedTask] : undefined
  };
}

function toPlanAssignments(
  steps: DispatchStep[],
  assignments: AgentAssignment[],
  db: AgentHubDatabase
): GroupRunPlanAssignment[] {
  const assignmentsById = new Map(
    assignments
      .filter((assignment) => assignment.id)
      .map((assignment) => [assignment.id, assignment])
  );

  return steps.map((step) => {
    const assignment = step.assignmentId
      ? assignmentsById.get(step.assignmentId) ?? null
      : assignments.find((item) => item.agentId === step.agentId) ?? null;

    return {
      stepId: step.id,
      stepIndex: step.stepIndex,
      roundIndex: step.roundIndex,
      assignmentId: step.assignmentId,
      agentId: step.agentId,
      agentName: getAgentDisplayName(step.agentId, db),
      instruction: step.instruction,
      targetCriteria: step.targetCriteria,
      reason: assignment?.reason,
      dependsOn: assignment?.dependsOn,
      targetFiles: assignment?.subTask?.targetFiles,
      taskTitle: assignment?.subTask?.title,
      taskType: assignment?.subTask?.taskType,
      expectedOutputType: assignment?.subTask?.expectedOutputType,
      riskLevel: assignment?.subTask?.riskLevel,
      score: assignment?.score
    };
  });
}

function toFinalGroupRunStatus(
  review: OrchestratorReview,
  results: SubAgentResult[]
): DispatchRunStatus {
  const successfulCount = results.filter(
    (result) => result.status === "completed" || result.status === "no_changes_needed"
  ).length;
  const failedOrPartialCount = results.length - successfulCount;

  if (failedOrPartialCount === 0) {
    return "completed";
  }

  if (review.decision === "complete") {
    return "partial_failed";
  }

  if (successfulCount > 0) {
    return "partial_failed";
  }

  return "failed";
}

function toStepStatus(status: SubAgentResult["status"]): DispatchStepStatus {
  if (status === "completed" || status === "no_changes_needed") {
    return "completed";
  }
  return status;
}

function isDispatchableGroupAgent(agent: Agent | null): agent is Agent {
  return (
    agent?.role === "sub" &&
    agent.type === "specialist" &&
    (agent.status === "available" || agent.status === "error")
  );
}

function clampScore(value: number): number {
  if (!Number.isFinite(value)) {
    return 0;
  }
  return Math.max(0, Math.min(1, value));
}

function extractTargetFiles(text: string): string[] {
  const matches = text.match(/(?:[\w.-]+\/)+[\w.-]+\.[A-Za-z0-9]+/g) ?? [];
  return [...new Set(matches)].slice(0, 8);
}

function inferExpectedOutputType(text: string): SubTask["expectedOutputType"] {
  if (/diff|代码|实现|修复|修改|新增|重构|bug|fix|feature/i.test(text)) {
    return "diff_proposal";
  }
  if (/测试|test|vitest|jest|验证/i.test(text)) {
    return "test_plan";
  }
  if (/设计|方案|architecture|design/i.test(text)) {
    return "design";
  }
  if (/总结|summary|汇总/i.test(text)) {
    return "summary";
  }
  return "analysis";
}

function buildDefaultSubTask(
  triggerContent: string,
  criteria: AcceptanceCriterion[]
): SubTask {
  const expectedOutputType = inferExpectedOutputType(triggerContent);
  const targetFiles = extractTargetFiles(triggerContent);
  return {
    id: "task-1",
    title: triggerContent.slice(0, 60) || "完成用户请求",
    objective: triggerContent.trim() || "完成用户请求",
    acceptanceCriteria: criteria.map((criterion) => criterion.id),
    requiredSkillQueries: [triggerContent.trim()].filter(Boolean),
    requiredTools:
      expectedOutputType === "diff_proposal" ? ["read_file", "write_diff"] : ["read_file"],
    taskType:
      expectedOutputType === "diff_proposal"
        ? "code_change"
        : expectedOutputType === "test_plan"
          ? "test"
          : expectedOutputType,
    targetFiles: targetFiles.length > 0 ? targetFiles : undefined,
    dependsOn: [],
    riskLevel: expectedOutputType === "diff_proposal" ? "medium" : "low",
    expectedOutputType
  };
}

function buildSubTaskInstruction(subTask: SubTask): string {
  return [
    subTask.title,
    subTask.objective,
    subTask.targetFiles && subTask.targetFiles.length > 0
      ? `目标文件: ${subTask.targetFiles.join(", ")}`
      : "",
    subTask.acceptanceCriteria.length > 0
      ? `验收项: ${subTask.acceptanceCriteria.join(", ")}`
      : ""
  ]
    .filter(Boolean)
    .join("\n");
}

function getGroupMemberAgentIds(conversationId: string, db: AgentHubDatabase): Set<string> {
  return new Set(
    getActiveMembers(conversationId, db)
      .filter((member) => member.memberType === "agent")
      .map((member) => member.memberId)
  );
}

function getGroupMemberAgents(conversationId: string, db: AgentHubDatabase): Agent[] {
  return [...getGroupMemberAgentIds(conversationId, db)]
    .map((agentId) => getAgentById(agentId, db))
    .filter((agent): agent is Agent => agent !== null);
}

function getContextRelevance(
  agentId: string,
  conversationId: string,
  subTask: SubTask,
  db: AgentHubDatabase
): number {
  const experience = listExperiencesByGroup(conversationId, db).find(
    (item) => item.agentId === agentId
  );
  let score = 0.2;
  if (!experience) {
    return score;
  }

  const text = [
    experience.summary,
    ...experience.responsibilities,
    ...experience.keyDecisions
  ]
    .join(" ")
    .toLowerCase();
  if (subTask.taskType && text.includes(subTask.taskType.toLowerCase())) {
    score += 0.3;
  }
  const filesTouched = new Set(experience.filesTouched.map((file) => file.toLowerCase()));
  if (
    subTask.targetFiles?.some((file) => filesTouched.has(file.toLowerCase()))
  ) {
    score += 0.3;
  }
  if (experience.summary.trim() || experience.responsibilities.length > 0) {
    score += 0.2;
  }
  return clampScore(score);
}

function getHistoricalReliability(agentId: string, db: AgentHubDatabase): number {
  const stepRows = db
    .prepare<[string], { status: string }>(
      "SELECT status FROM dispatch_steps WHERE agent_id = ?"
    )
    .all(agentId);
  if (stepRows.length === 0) {
    return 0.6;
  }

  const terminalRows = stepRows.filter((row) =>
    ["completed", "partial", "failed", "iteration_limit_reached", "cancelled"].includes(row.status)
  );
  if (terminalRows.length === 0) {
    return 0.6;
  }

  const successRate =
    terminalRows.filter((row) => row.status === "completed").length / terminalRows.length;
  const failureRate =
    terminalRows.filter((row) => row.status === "failed" || row.status === "cancelled").length /
    terminalRows.length;
  const avgScoreFromMainAgent = clampScore(
    terminalRows.reduce((sum, row) => {
      if (row.status === "completed") return sum + 1;
      if (row.status === "partial") return sum + 0.55;
      return sum + 0.2;
    }, 0) / terminalRows.length
  );
  const diffRows = db
    .prepare<[string], { status: string }>(
      "SELECT status FROM diff_proposals WHERE agent_id = ?"
    )
    .all(agentId);
  const decidedDiffRows = diffRows.filter((row) =>
    ["applied", "rejected", "conflicted", "failed"].includes(row.status)
  );
  const diffAcceptedRate =
    decidedDiffRows.length === 0
      ? 0.6
      : decidedDiffRows.filter((row) => row.status === "applied").length /
        decidedDiffRows.length;

  const observed =
    successRate * 0.4 +
    avgScoreFromMainAgent * 0.3 +
    diffAcceptedRate * 0.2 +
    (1 - failureRate) * 0.1;
  const confidenceBySampleSize = clampScore(terminalRows.length / 10);
  return clampScore(observed * confidenceBySampleSize + 0.6 * (1 - confidenceBySampleSize));
}

async function getCapabilityMatches(input: {
  conversation: Conversation;
  userMessage: string;
  subTask: SubTask;
  candidates: Agent[];
  db: AgentHubDatabase;
}): Promise<CapabilityMatchResult[]> {
  const fallbackMatches = new Map(
    input.candidates.map((agent) => [agent.id, fallbackCapabilityMatch(agent, input.subTask)])
  );
  const shortlist = [...input.candidates]
    .sort(
      (a, b) =>
        (fallbackMatches.get(b.id)?.capabilityMatch ?? 0) -
        (fallbackMatches.get(a.id)?.capabilityMatch ?? 0)
    )
    .slice(0, 8);

  try {
    const llmMatches = await runGroupCapabilityMatchJudge(
      {
        workspaceId: input.conversation.workspaceId,
        conversationId: input.conversation.id,
        userMessage: input.userMessage,
        subTask: input.subTask,
        candidates: shortlist.map((agent) => ({
          agentId: agent.id,
          name: agent.name,
          capabilities: getEffectiveAgentCapabilities(agent)
        }))
      },
      input.db
    );
    for (const match of llmMatches) {
      fallbackMatches.set(match.agentId, match);
    }
  } catch {
    // Keep dispatch deterministic if the optional capability judge is unavailable.
  }

  return input.candidates.map((agent) => fallbackMatches.get(agent.id)!);
}

function isGeneralFallbackAgent(agent: Agent): boolean {
  const text = [
    agent.name,
    agent.description ?? "",
    ...getEffectiveAgentCapabilities(agent)
  ]
    .join(" ")
    .toLowerCase();
  return /general|通用|全栈|full.?stack|codex|coding|implementation/.test(text);
}

function selectBestScore(
  scores: AgentDispatchScore[],
  candidates: Agent[],
  explicitAgentIds?: Set<string>
): AgentDispatchScore | null {
  if (scores.length === 0) {
    return null;
  }
  const sorted = [...scores].sort((a, b) => b.finalScore - a.finalScore);
  const best = sorted[0];
  if (best.finalScore >= 0.55) {
    return best;
  }
  if (!explicitAgentIds) {
    const genericAgent = candidates.find(isGeneralFallbackAgent);
    const fallback = genericAgent
      ? sorted.find((score) => score.agentId === genericAgent.id) ?? best
      : best;
    return {
      ...fallback,
      reason: `${fallback.reason} 最高分低于 0.55，自动模式 fallback 到${
        genericAgent ? "通用 Agent" : "最高可用 Agent"
      }。`
    };
  }
  return {
    ...best,
    reason: `${best.reason} 显式 @ 候选池中最高分低于 0.55，系统不会 fallback 到其他 Agent。`
  };
}

async function createScoredAssignmentsFromSubTasks(input: {
  conversation: Conversation;
  userMessage: string;
  subTasks: SubTask[];
  criteria: AcceptanceCriterion[];
  explicitAgentIds?: Set<string>;
  db: AgentHubDatabase;
}): Promise<AgentAssignment[]> {
  const memberAgentIds = getGroupMemberAgentIds(input.conversation.id, input.db);
  const agents = getGroupMemberAgents(input.conversation.id, input.db);
  const criterionIds = input.criteria.map((criterion) => criterion.id);
  const assignments: AgentAssignment[] = [];

  for (const subTask of input.subTasks) {
    const filterResult = filterDispatchCandidates({
      agents,
      groupMemberAgentIds: memberAgentIds,
      explicitAgentIds: input.explicitAgentIds,
      subTask
    });

    if (filterResult.candidates.length === 0) {
      const rejectedDetail = filterResult.rejected
        .filter((item) => !input.explicitAgentIds || input.explicitAgentIds.has(item.agentId))
        .map((item) => `${item.agentId}: ${item.detail}`)
        .join("; ");
      throw new DispatchError(
        `没有可执行子任务 '${subTask.title}' 的候选 Agent。${rejectedDetail || "候选池为空或全部被硬过滤。"}${
          input.explicitAgentIds ? " 用户显式 @ 模式不会 fallback 到其他 Agent。" : ""
        }`
      );
    }

    const capabilityMatches = await getCapabilityMatches({
      conversation: input.conversation,
      userMessage: input.userMessage,
      subTask,
      candidates: filterResult.candidates,
      db: input.db
    });
    const scores = capabilityMatches.map((capability) => {
      const agent = filterResult.candidates.find((item) => item.id === capability.agentId)!;
      return calculateDispatchScore({
        capability,
        toolMatch: calculateToolMatch(agent, subTask),
        contextRelevance: getContextRelevance(agent.id, input.conversation.id, subTask, input.db),
        historicalReliability: getHistoricalReliability(agent.id, input.db)
      });
    });
    const selected = selectBestScore(scores, filterResult.candidates, input.explicitAgentIds);
    if (!selected) {
      throw new DispatchError(`无法为子任务 '${subTask.title}' 计算 Agent 分数。`);
    }

    const targetCriteria =
      subTask.acceptanceCriteria.filter((criterionId) => criterionIds.includes(criterionId));
    assignments.push({
      id: subTask.id || randomUUID(),
      agentId: selected.agentId,
      instruction: buildSubTaskInstruction(subTask),
      targetCriteria: targetCriteria.length > 0 ? targetCriteria : criterionIds,
      dependsOn: subTask.dependsOn,
      reason: `系统综合评分选择该 Agent。${selected.reason}`,
      subTask,
      score: selected,
      reviewerAgentId: subTask.riskLevel === "high" ? scores[1]?.agentId : undefined
    });
  }

  return assignments;
}

function resolveMentionedAgents(
  mentionNames: string[],
  conversationId: string,
  db: AgentHubDatabase
): Agent[] {
  const members = getActiveMembers(conversationId, db);
  const agentMembers = members.filter((m) => m.memberType === "agent");
  const resolved: Agent[] = [];

  for (const name of mentionNames) {
    const member = agentMembers.find((m) => {
      const agent = getAgentById(m.memberId, db);
      return agent && agent.name.toLowerCase() === name.toLowerCase();
    });

    if (member) {
      const agent = getAgentById(member.memberId, db);

      if (isDispatchableGroupAgent(agent)) {
        resolved.push(agent);
      }
    }
  }

  return resolved;
}

function buildSubAgentPrompt(taskInput: SubAgentTaskInput): string {
  return [
    `你是 AgentHub 群聊中的一个子 Agent。`,
    `只使用下面 SubAgentTaskInput 中提供的上下文；不要假设自己拥有完整群聊历史或私聊历史。`,
    `如果任务需要的上下文不在 SubAgentTaskInput 中，必须在 assumptions 或 risks 中说明。`,
    `长报告、Markdown 正文或大段分析不要放进 JSON 的 deliverable 字段；如果已经生成长正文，系统会保存为 artifact，你只需要在 JSON 中引用 artifactId。`,
    ``,
    `SubAgentTaskInput JSON:`,
    JSON.stringify(taskInput, null, 2),
    ``,
    `SubAgentResult JSON schema:`,
    `{`,
    `  "agentId": "${taskInput.assignedAgent.id}",`,
    `  "status": "completed | partial | failed | no_changes_needed | iteration_limit_reached",`,
    `  "summary": "执行摘要",`,
    `  "deliverable": "可选短预览。不要放长正文",`,
    `  "artifactIds": ["长正文 artifact id，如有"],`,
    `  "outputs": [{ "type": "markdown | text | diff | file | json | command_result", "artifactId": "artifact-id", "diffProposalId": "diff-id", "filePath": "path", "preview": "短预览", "isComplete": true }],`,
    `  "evidence": [{ "criterionId": "criterion-id", "artifactId": "artifact-id", "summary": "该产物如何满足验收项" }],`,
    `  "completedCriteria": ["criterion-id"],`,
    `  "unresolvedCriteria": ["criterion-id"],`,
    `  "filesRead": ["relative/path"],`,
    `  "filesChanged": ["relative/path"],`,
    `  "diffProposalId": "有代码变更时必填",`,
    `  "verification": { "commandsRun": ["command"], "passed": true, "outputSummary": "摘要" },`,
    `  "assumptions": [],`,
    `  "risks": [],`,
    `  "nextSuggestedTask": "未完成时建议的修复任务"`,
    `}`,
    ``,
    `返回前必须自我压缩，过滤掉所有噪音，只带回精炼的结论和关键事实。`
  ]
    .filter((line) => line.trim().length > 0)
    .join("\n");
}

function parseDispatchPlan(text: string): DispatchPlan | null {
  const jsonMatch = text.match(/```json\s*([\s\S]*?)```/);
  const jsonStr = jsonMatch ? jsonMatch[1].trim() : text.trim();

  try {
    const parsed = JSON.parse(jsonStr) as DispatchPlan;

    if (
      typeof parsed === "object" &&
      parsed !== null &&
      typeof parsed.need_dispatch === "boolean" &&
      Array.isArray(parsed.steps)
    ) {
      return parsed;
    }
  } catch {
    // Not valid JSON
  }

  return null;
}

function validateDispatchPlan(
  plan: DispatchPlan,
  conversation: Conversation,
  mainAgentId: string,
  db: AgentHubDatabase
): boolean {
  if (!plan.need_dispatch || plan.steps.length === 0) {
    return false;
  }

  if (plan.steps.length > MAX_DISPATCH_STEPS) {
    return false;
  }

  const members = getActiveMembers(conversation.id, db);
  const memberAgentIds = new Set(
    members.filter((m) => m.memberType === "agent").map((m) => m.memberId)
  );

  const seenAgentIds = new Set<string>();

  for (const step of plan.steps) {
    if (!step.agent_id || !step.instruction || step.instruction.trim().length === 0) {
      return false;
    }

    if (step.agent_id === mainAgentId) {
      return false;
    }

    if (!memberAgentIds.has(step.agent_id)) {
      return false;
    }

    if (!isDispatchableGroupAgent(getAgentById(step.agent_id, db))) {
      return false;
    }

    if (seenAgentIds.has(step.agent_id)) {
      return false;
    }

    seenAgentIds.add(step.agent_id);
  }

  return true;
}

function getOrCreateAgentConversation(
  agent: Agent,
  instruction: string,
  db: AgentHubDatabase
): Conversation {
  const existing = getFirstConversationByAgent(agent.id, db);
  if (existing) {
    return existing;
  }

  return createConversation(
    {
      workspaceId: agent.workspaceId,
      workspaceContextId: agent.defaultWorkspaceContextId ?? null,
      agentId: agent.id,
      title: instruction.slice(0, 50) || `Chat with ${agent.name}`,
      mode: "single",
      provider: agent.runtimeProvider
    },
    db
  );
}

async function executeSubAgentStep(
  step: DispatchStep,
  conversation: Conversation,
  triggerMessage: Message,
  previousOutputs: PreviousTaskSummary[],
  db: AgentHubDatabase,
  stream?: DispatchStreamHandler,
  criteria: AcceptanceCriterion[] = []
): Promise<{
  success: boolean;
  outputMessage: Message | null;
  subAgentResult: SubAgentResult;
  error?: string;
}> {
  const agent = getAgentById(step.agentId, db);

  if (!agent) {
    const error = `Agent ${step.agentId} not found.`;
    updateStepStatus(step.id, "failed", null, error, db);
    stream?.({
      type: "dispatch_step_update",
      dispatchRunId: step.dispatchRunId,
      stepId: step.id,
      stepIndex: step.stepIndex,
      agentId: step.agentId,
      status: "failed"
    });
    emitStepProgress(
      {
        conversationId: conversation.id,
        step,
        agentName: getAgentDisplayName(step.agentId, db),
        title: "执行失败",
        body: error,
        level: "error",
        phase: "complete",
        status: "failed"
      },
      db,
      stream
    );
    emitGroupRunEvent(
      {
        groupRunId: step.dispatchRunId,
        conversationId: conversation.id,
        type: "agent_failed",
        payload: {
          stepId: step.id,
          stepIndex: step.stepIndex,
          roundIndex: step.roundIndex,
          agentId: step.agentId,
          status: "failed",
          summary: error,
          detailAvailable: true,
          errorMessage: error
        }
      },
      db,
      stream
    );
    const subAgentResult: SubAgentResult = {
      agentId: step.agentId,
      status: "failed",
      summary: error,
      completedCriteria: [],
      unresolvedCriteria: step.targetCriteria,
      filesRead: [],
      assumptions: [],
      risks: [error]
    };
    updateStepSubAgentResult(step.id, subAgentResult, db);
    return { success: false, outputMessage: null, subAgentResult, error };
  }

  const workspace = getWorkspaceById(conversation.workspaceId, db);

  if (!workspace) {
    const error = "Workspace not found.";
    updateStepStatus(step.id, "failed", null, error, db);
    stream?.({
      type: "dispatch_step_update",
      dispatchRunId: step.dispatchRunId,
      stepId: step.id,
      stepIndex: step.stepIndex,
      agentId: step.agentId,
      status: "failed"
    });
    emitGroupRunEvent(
      {
        groupRunId: step.dispatchRunId,
        conversationId: conversation.id,
        type: "agent_failed",
        payload: {
          stepId: step.id,
          stepIndex: step.stepIndex,
          roundIndex: step.roundIndex,
          agentId: step.agentId,
          agentName: getAgentDisplayName(step.agentId, db),
          status: "failed",
          summary: error,
          detailAvailable: true,
          errorMessage: error
        }
      },
      db,
      stream
    );
    const subAgentResult: SubAgentResult = {
      agentId: step.agentId,
      status: "failed",
      summary: error,
      completedCriteria: [],
      unresolvedCriteria: step.targetCriteria,
      filesRead: [],
      assumptions: [],
      risks: [error]
    };
    updateStepSubAgentResult(step.id, subAgentResult, db);
    return { success: false, outputMessage: null, subAgentResult, error };
  }
  const resolvedGroupWorkspace = resolveExecutionWorkspaceForGroup(conversation.id, db);
  const executionWorkspace: Workspace = {
    ...workspace,
    rootPath: resolvedGroupWorkspace.rootPath,
    gitEnabled: resolvedGroupWorkspace.gitEnabled
  };

  updateStepStatus(step.id, "running", null, null, db);
  stream?.({
    type: "dispatch_step_update",
    dispatchRunId: step.dispatchRunId,
    stepId: step.id,
    stepIndex: step.stepIndex,
    agentId: step.agentId,
    status: "running"
  });
  emitGroupRunEvent(
    {
      groupRunId: step.dispatchRunId,
      conversationId: conversation.id,
      type: "agent_started",
      payload: {
        stepId: step.id,
        stepIndex: step.stepIndex,
        roundIndex: step.roundIndex,
        agentId: step.agentId,
        agentName: agent.name,
        instruction: step.instruction,
        status: "running"
      }
    },
    db,
    stream
  );
  emitStepProgress(
    {
      conversationId: conversation.id,
      step,
      agentName: agent.name,
      title: "正在准备任务上下文",
      body: step.instruction,
      phase: "context",
      status: "running"
    },
    db,
    stream
  );

  const layeredMemoryContext = buildGroupSubAgentMemoryContext(
    agent.id,
    conversation.id,
    {
      assignment: step.instruction,
      previousAgentOutputs: previousOutputs.map(formatPreviousTaskSummaryForMemory),
      selectedGroupMessages: [triggerMessage]
    },
    undefined,
    db
  );
  const scopedCriteria = criteria.filter((criterion) =>
    step.targetCriteria.includes(criterion.id)
  );
  const taskInput = buildSubAgentTaskInput({
    agent,
    workspace: executionWorkspace,
    conversation,
    step,
    triggerMessage,
    previousOutputs,
    criteria: scopedCriteria,
    memorySummary: layeredMemoryContext
  });
  updateStepInputContextSnapshot(step.id, taskInput, db);
  const subAgentPrompt = buildSubAgentPrompt(taskInput);

  try {
    emitStepProgress(
      {
        conversationId: conversation.id,
        step,
        agentName: agent.name,
        title: agent.role === "main" ? "正在运行主 Agent" : "正在运行子 Agent",
        phase: "runtime",
        status: "running"
      },
      db,
      stream
    );
    let emittedStreamProgress = false;
    const streamSink = (_event: RunAgentStreamEvent) => {
      if (!emittedStreamProgress) {
        emittedStreamProgress = true;
        emitStepProgress(
          {
            conversationId: conversation.id,
            step,
            agentName: agent.name,
            title: "正在生成结果",
            phase: "stream",
            status: "streaming"
          },
          db,
          stream
        );
      }
      stream?.({
        type: "dispatch_step_update",
        dispatchRunId: step.dispatchRunId,
        stepId: step.id,
        stepIndex: step.stepIndex,
        agentId: step.agentId,
        status: "streaming"
      });
    };

    let outputMessage: Message | null = null;

    if (agent.role === "main") {
      // Main agent: run in group conversation only, don't save to single-chat
      const result = await runAgent(
        {
          workspaceId: conversation.workspaceId,
          conversationId: conversation.id,
          agentId: agent.id,
          userMessage: subAgentPrompt
        },
        db,
        undefined,
        undefined,
        streamSink
      );

      outputMessage = result.messages.find(
        (m) => m.senderType === "agent" && m.messageType === "text"
      ) ?? result.messages[0] ?? null;
      const summary =
        outputMessage &&
        typeof outputMessage.content === "object" &&
        outputMessage.content !== null &&
        "text" in outputMessage.content
          ? String(outputMessage.content.text)
          : "主 Agent 已直接回复用户。";
      const subAgentResult: SubAgentResult = {
        agentId: agent.id,
        status: "completed",
        summary,
        completedCriteria: step.targetCriteria,
        unresolvedCriteria: [],
        filesRead: [],
        assumptions: [],
        risks: []
      };
      updateStepSubAgentResult(step.id, subAgentResult, db);
      updateStepStatus(step.id, "completed", outputMessage?.id ?? null, null, db);
      stream?.({
        type: "dispatch_step_update",
        dispatchRunId: step.dispatchRunId,
        stepId: step.id,
        stepIndex: step.stepIndex,
        agentId: step.agentId,
        status: "completed"
      });
      emitStepProgress(
        {
          conversationId: conversation.id,
          step,
          agentName: agent.name,
          title: "已完成",
          body: subAgentResult.summary,
          phase: "complete",
          status: "completed"
        },
        db,
        stream
      );
      emitGroupRunEvent(
        {
          groupRunId: step.dispatchRunId,
          conversationId: conversation.id,
          type: "agent_completed",
          payload: {
            stepId: step.id,
            stepIndex: step.stepIndex,
            roundIndex: step.roundIndex,
            agentId: step.agentId,
            agentName: agent.name,
            instruction: step.instruction,
            status: "completed",
            summary: subAgentResult.summary,
            detailAvailable: Boolean(outputMessage)
          }
        },
        db,
        stream
      );
      return { success: true, outputMessage, subAgentResult };
    } else {
      // Sub-agent: use single-chat conversation for context and provider session sharing
      const agentConversation = getOrCreateAgentConversation(agent, step.instruction, db);

      console.info("[AgentHub] dispatchService.runDispatchStep start", {
        agentId: agent.id,
        dispatchStepId: step.id,
        targetCriteria: step.targetCriteria,
        promptLength: subAgentPrompt.length
      });

      let result: RunAgentOutput | null = null;
      let agentReply: Message | undefined;
      let replyText = "";
      let aggregateReplyText = "";
      let runMetadata: SubAgentResultMetadata = {};
      let subAgentResult: SubAgentResult | null = null;
      let continuationAttempts = 0;
      let manifestRepairRequested = false;
      const generatedArtifacts: Artifact[] = [];
      let nextPrompt = subAgentPrompt;

      while (true) {
        const shouldResumeProviderSession = nextPrompt !== subAgentPrompt;
        result = await runAgentWithConversation(
          {
            workspaceId: agent.workspaceId,
            agentId: agent.id,
            conversationId: agentConversation.id,
            message: nextPrompt,
            resume: shouldResumeProviderSession,
            silent: true,
            mode: "group_subagent",
            structuredOutput: true,
            workspaceContextId: resolvedGroupWorkspace.workspaceContextId,
            workspaceRootPath: resolvedGroupWorkspace.rootPath,
            executionScope: "group_subagent",
            dispatchStepId: step.id
          },
          db,
          streamSink
        );

        agentReply = getAgentReplyMessage(result);
        replyText = getAgentReplyText(agentReply);
        aggregateReplyText += replyText;
        runMetadata = getSubAgentRunMetadata(
          result,
          replyText,
          continuationAttempts
        );

        emitStepProgress(
          {
            conversationId: conversation.id,
            step,
            agentName: agent.name,
            title: "正在解析 SubAgentResult",
            body: `累计输出长度 ${aggregateReplyText.length} 字符`,
            phase: "parse",
            status: "streaming"
          },
          db,
          stream
        );
        if (runMetadata.outputTruncated) {
          emitStepProgress(
            {
              conversationId: conversation.id,
              step,
              agentName: agent.name,
              title: "模型输出被截断",
              body: result.runResult?.error,
              level: "warning",
              phase: "model",
              status: "streaming"
            },
            db,
            stream
          );
        }

        console.info("[AgentHub] dispatchService.runDispatchStep rawTextLengthBeforeParse", {
          agentId: agent.id,
          dispatchStepId: step.id,
          rawTextLengthBeforeParse: aggregateReplyText.length,
          latestTextLength: replyText.length,
          runResultStatus: result.runResult?.status,
          runResultError: result.runResult?.error,
          runMetadata
        });

        subAgentResult = parseBestSubAgentResult({
          agentId: agent.id,
          targetCriteria: step.targetCriteria,
          aggregateText: aggregateReplyText,
          latestText: replyText,
          runResult: result.runResult,
          runMetadata
        });

        const incompleteStructuredOutput = isLikelyIncompleteStructuredOutput(
          aggregateReplyText,
          subAgentResult.parseError
        );
        const continuationReason = runMetadata.outputTruncated
          ? "模型输出达到最大 token 或被平台截断"
          : runMetadata.timeoutTriggered
            ? "模型输出超时"
            : incompleteStructuredOutput
              ? "结构化 JSON 尚未完整"
              : "";

        if (
          continuationReason &&
          continuationAttempts < MAX_SUB_AGENT_OUTPUT_CONTINUATIONS
        ) {
          continuationAttempts += 1;
          emitStepProgress(
            {
              conversationId: conversation.id,
              step,
              agentName: agent.name,
              title: "正在继续补齐输出",
              body: continuationReason,
              level: "warning",
              phase: "model",
              status: "streaming"
            },
            db,
            stream
          );
          nextPrompt = buildSubAgentContinuationPrompt({
            attempt: continuationAttempts,
            maxAttempts: MAX_SUB_AGENT_OUTPUT_CONTINUATIONS,
            targetCriteria: step.targetCriteria,
            previousText: aggregateReplyText,
            reason: continuationReason
          });
          continue;
        }

        if (
          subAgentResult.parseError &&
          aggregateReplyText.trim().length > 0 &&
          !manifestRepairRequested
        ) {
          const artifact = createSubAgentMarkdownArtifact(
            {
              workspaceId: conversation.workspaceId,
              conversationId: conversation.id,
              agentId: agent.id,
              agentName: agent.name,
              step,
              content: aggregateReplyText.trim(),
              titleSuffix: "Deliverable"
            },
            db
          );
          generatedArtifacts.push(artifact);
          manifestRepairRequested = true;
          emitStepProgress(
            {
              conversationId: conversation.id,
              step,
              agentName: agent.name,
              title: "已保存长输出产物，正在修复结果清单",
              body: artifact.title,
              level: "warning",
              phase: "parse",
              status: "streaming"
            },
            db,
            stream
          );
          nextPrompt = buildSubAgentManifestRepairPrompt({
            artifact,
            targetCriteria: step.targetCriteria,
            previousSummary: subAgentResult.summary
          });
          continue;
        }

        break;
      }

      if (!result || !subAgentResult) {
        throw new Error("Sub-agent run did not produce a result.");
      }

      if (subAgentResult.parseError) {
        emitStepProgress(
          {
            conversationId: conversation.id,
            step,
            agentName: agent.name,
            title: "返回 SubAgentResult 解析失败",
            body: subAgentResult.parseError,
            level: "error",
            phase: "parse",
            status: "failed"
          },
          db,
          stream
        );
      }

      console.info("[AgentHub] dispatchService.runDispatchStep parsed", {
        agentId: agent.id,
        dispatchStepId: step.id,
        status: subAgentResult.status,
        parseSucceeded: subAgentResult.metadata?.parseSucceeded,
        parseError: subAgentResult.parseError,
        rawTextLength: subAgentResult.metadata?.rawTextLength,
        outputTruncated: subAgentResult.metadata?.outputTruncated,
        finishReason: subAgentResult.metadata?.finishReason
      });

      if (!subAgentResult.parseError) {
        const moved = maybeMoveLongDeliverableToArtifact(
          {
            result: subAgentResult,
            workspaceId: conversation.workspaceId,
            conversationId: conversation.id,
            agentId: agent.id,
            agentName: agent.name,
            step
          },
          db
        );
        subAgentResult = attachArtifactsToSubAgentResult(
          moved.result,
          [...generatedArtifacts, ...moved.artifacts]
        );
      } else if (generatedArtifacts.length > 0) {
        subAgentResult = attachArtifactsToSubAgentResult(subAgentResult, generatedArtifacts);
      }

      if (subAgentResult.diffProposalId) {
        try {
          const proposal = getDiffProposal(subAgentResult.diffProposalId, db);
          if (
            proposal.agentId !== agent.id ||
            proposal.conversationId !== conversation.id ||
            proposal.dispatchRunId !== step.dispatchRunId ||
            proposal.dispatchStepId !== step.id
          ) {
            throw new Error("DiffProposal is not bound to this sub-agent dispatch step.");
          }
        } catch (error) {
          const validationError =
            error instanceof Error ? error.message : "DiffProposal validation failed.";
          emitStepProgress(
            {
              conversationId: conversation.id,
              step,
              agentName: agent.name,
              title: "DiffProposal 校验失败",
              body: validationError,
              level: "error",
              phase: "validation",
              status: "failed"
            },
            db,
            stream
          );
          subAgentResult = {
            ...subAgentResult,
            status: "failed",
            completedCriteria: [],
            unresolvedCriteria: step.targetCriteria,
            risks: [...subAgentResult.risks, validationError]
          };
        }
      } else if (
        subAgentResult.status !== "no_changes_needed" &&
        (subAgentResult.filesChanged?.length ?? 0) > 0
      ) {
        const validationError = "子 Agent 声明修改了文件，但没有返回合法 DiffProposal。";
        emitStepProgress(
          {
            conversationId: conversation.id,
            step,
            agentName: agent.name,
            title: "缺少 DiffProposal",
            body: validationError,
            level: "error",
            phase: "validation",
            status: "failed"
          },
          db,
          stream
        );
        subAgentResult = {
          ...subAgentResult,
          status: "failed",
          completedCriteria: [],
          unresolvedCriteria: step.targetCriteria,
          risks: [
            ...subAgentResult.risks,
            validationError
          ]
        };
      }

      updateStepSubAgentResult(step.id, subAgentResult, db);

      if (agentReply) {
        outputMessage = insertMessage(
          {
            workspaceId: conversation.workspaceId,
            conversationId: conversation.id,
            senderType: "agent",
            senderId: agent.id,
            messageType: "agent_assignment",
            content: { text: subAgentResult.summary },
            metadata: {
              type: "agent_assignment",
              agentName: agent.name,
              agentId: agent.id,
              dispatchRunId: step.dispatchRunId,
              stepId: step.id,
              status: subAgentResult.status,
              summary: subAgentResult.summary,
              diffProposalId: subAgentResult.diffProposalId ?? null,
              artifactIds: subAgentResult.artifactIds ?? [],
              outputs: subAgentResult.outputs ?? [],
              evidence: subAgentResult.evidence ?? [],
              detailAvailable: true
            }
          },
          db
        );
      }

      const stepStatus = toStepStatus(subAgentResult.status);
      updateStepStatus(
        step.id,
        stepStatus,
        outputMessage?.id ?? null,
        subAgentResult.status === "failed" ? subAgentResult.summary : null,
        db
      );
      stream?.({
        type: "dispatch_step_update",
        dispatchRunId: step.dispatchRunId,
        stepId: step.id,
        stepIndex: step.stepIndex,
        agentId: step.agentId,
        status: stepStatus
      });
      emitStepProgress(
        {
          conversationId: conversation.id,
          step,
          agentName: agent.name,
          title: stepStatus === "failed" ? "执行失败" : "已完成",
          body: subAgentResult.summary,
          level: stepStatus === "failed" ? "error" : "info",
          phase: "complete",
          status: stepStatus
        },
        db,
        stream
      );
      const agentRunId = result.runLog?.id ?? getAgentRunByDispatchStep(step.id, db)?.id;
      emitGroupRunEvent(
        {
          groupRunId: step.dispatchRunId,
          conversationId: conversation.id,
          type: stepStatus === "failed" ? "agent_failed" : "agent_completed",
          payload: {
            stepId: step.id,
            stepIndex: step.stepIndex,
            roundIndex: step.roundIndex,
            agentId: step.agentId,
            agentName: agent.name,
            agentRunId: agentRunId ?? undefined,
            instruction: step.instruction,
            status: stepStatus === "failed" ? "failed" : stepStatus,
            summary: subAgentResult.summary,
            diffProposalId: subAgentResult.diffProposalId,
            detailAvailable: true,
            errorMessage: stepStatus === "failed" ? subAgentResult.summary : undefined
          }
        },
        db,
        stream
      );

      return {
        success:
          subAgentResult.status === "completed" ||
          subAgentResult.status === "no_changes_needed",
        outputMessage,
        subAgentResult
      };
    }

  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : "Unknown error";
    updateStepStatus(step.id, "failed", null, errorMsg, db);
    stream?.({
      type: "dispatch_step_update",
      dispatchRunId: step.dispatchRunId,
      stepId: step.id,
      stepIndex: step.stepIndex,
      agentId: step.agentId,
      status: "failed"
    });
    emitGroupRunEvent(
      {
        groupRunId: step.dispatchRunId,
        conversationId: conversation.id,
        type: "agent_failed",
        payload: {
          stepId: step.id,
          stepIndex: step.stepIndex,
          roundIndex: step.roundIndex,
          agentId: step.agentId,
          agentName: getAgentDisplayName(step.agentId, db),
          status: "failed",
          summary: errorMsg,
          detailAvailable: true,
          errorMessage: errorMsg
        }
      },
      db,
      stream
    );
    const subAgentResult: SubAgentResult = {
      agentId: step.agentId,
      status: "failed",
      summary: errorMsg,
      completedCriteria: [],
      unresolvedCriteria: step.targetCriteria,
      filesRead: [],
      assumptions: [],
      risks: [errorMsg]
    };
    updateStepSubAgentResult(step.id, subAgentResult, db);
    return { success: false, outputMessage: null, subAgentResult, error: errorMsg };
  }
}

function createAssignments(
  agents: Agent[],
  instruction: string,
  criteria: AcceptanceCriterion[]
): AgentAssignment[] {
  const targetCriteria = criteria.map((criterion) => criterion.id);

  return agents.map((agent) => ({
    id: randomUUID(),
    agentId: agent.id,
    instruction,
    targetCriteria,
    reason: "用户在群聊中明确指定该 Agent。"
  }));
}

function buildAgentNameMap(agentIds: string[], db: AgentHubDatabase): Record<string, string> {
  const names: Record<string, string> = {};

  for (const agentId of agentIds) {
    const agent = getAgentById(agentId, db);
    if (agent) {
      names[agentId] = agent.name;
    }
  }

  return names;
}

function createPlanMessage(
  conversation: Conversation,
  dispatchRunId: string,
  mainAgentId: string,
  roundIndex: number,
  assignments: AgentAssignment[],
  db: AgentHubDatabase
): Message {
  const description = assignments
    .map((assignment, index) => {
      const agent = getAgentById(assignment.agentId, db);
      const scoreText = assignment.score
        ? ` [score=${assignment.score.finalScore.toFixed(2)}, capability=${assignment.score.capabilityMatch.toFixed(2)}]`
        : "";
      return `${index + 1}. Agent(${agent?.name ?? assignment.agentId})${scoreText}: ${assignment.instruction}`;
    })
    .join("\n");

  return insertMessage(
    {
      workspaceId: conversation.workspaceId,
      conversationId: conversation.id,
      senderType: "agent",
      senderId: mainAgentId,
      messageType: "dispatch_plan",
      content: {
        text: `第 ${roundIndex + 1} 轮分派计划:\n${description}`
      },
      metadata: {
        type: "dispatch_plan",
        dispatchRunId,
        roundIndex,
        assignments,
        agentNames: buildAgentNameMap(assignments.map((assignment) => assignment.agentId), db)
      }
    },
    db
  );
}

async function createFinalSummary(
  conversation: Conversation,
  triggerContent: string,
  criteria: AcceptanceCriterion[],
  review: OrchestratorReview,
  results: SubAgentResult[],
  db: AgentHubDatabase
): Promise<string> {
  try {
    const summary = await runGroupOrchestratorSynthesis(
      {
        workspaceId: conversation.workspaceId,
        conversationId: conversation.id,
        userMessage: triggerContent,
        criteria,
        review,
        results
      },
      db
    );

    if (summary.trim()) {
      return summary.trim();
    }
  } catch {
    // Preserve a useful answer when the final synthesis call is unavailable.
  }

  return createFallbackUserFacingSummary(review, results);
}

async function executeStructuredGroupDispatch(
  conversation: Conversation,
  triggerMessage: Message,
  dispatchRun: DispatchRun,
  initialAssignments: AgentAssignment[],
  initialCriteria: AcceptanceCriterion[],
  mainAgentId: string,
  db: AgentHubDatabase,
  stream?: DispatchStreamHandler
): Promise<SendGroupMessageOutput> {
  const triggerContent =
    typeof triggerMessage.content === "object" &&
    triggerMessage.content !== null &&
    "text" in triggerMessage.content
      ? (triggerMessage.content as { text: string }).text
      : JSON.stringify(triggerMessage.content);
  let roundIndex = 0;
  let assignments = initialAssignments;
  const experienceAssignments = [...initialAssignments];
  let criteria = initialCriteria;
  let review: OrchestratorReview = {
    decision: "need_user_input",
    satisfiedCriteria: [],
    unresolvedCriteria: criteria.map((criterion) => criterion.id),
    evidence: [],
    nextAssignments: [],
    reason: "尚未执行子 Agent。"
  };
  const results: SubAgentResult[] = [];
  const previousOutputs: PreviousTaskSummary[] = [];
  const completedTaskIds = new Set<string>();

  while (assignments.length > 0) {
    updateDispatchRunExecution(
      dispatchRun.id,
      {
        roundIndex,
        acceptanceCriteria: criteria,
        orchestratorReview: review
      },
      db
    );
    updateDispatchRunStatus(dispatchRun.id, "running_subagents", db);

    const stepOffset = getStepsByDispatchRun(dispatchRun.id, db).length;
    const steps = assignments.map((assignment, index) =>
      createDispatchStep(
        {
          dispatchRunId: dispatchRun.id,
          stepIndex: stepOffset + index,
          agentId: assignment.agentId,
          instruction: assignment.instruction,
          roundIndex,
          assignmentId: assignment.id,
          targetCriteria: assignment.targetCriteria,
          maxIterations: AGENT_EXECUTION_LIMITS.groupSubagentMaxIterations
        },
        db
      )
    );
    updateDispatchRunStatus(dispatchRun.id, "plan_created", db);
    emitGroupRunEvent(
      {
        groupRunId: dispatchRun.id,
        conversationId: conversation.id,
        type: "plan_created",
        payload: {
          mode: dispatchRun.mode,
          roundIndex,
          assignments: toPlanAssignments(steps, assignments, db)
        }
      },
      db,
      stream
    );

    const planMessage = createPlanMessage(
      conversation,
      dispatchRun.id,
      mainAgentId,
      roundIndex,
      assignments,
      db
    );
    stream?.({ type: "dispatch_plan_message", message: planMessage });
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    updateDispatchRunStatus(dispatchRun.id, "running_subagents", db);

    const stepsByAssignmentId = new Map(
      steps
        .filter((step) => step.assignmentId)
        .map((step) => [step.assignmentId as string, step])
    );
    const executionBatches = buildExecutionBatches(assignments, completedTaskIds);
    for (const batch of executionBatches) {
      const batchSteps = batch
        .map((assignment) => stepsByAssignmentId.get(assignment.id))
        .filter((step): step is DispatchStep => step !== undefined);
      const batchResults = await Promise.all(
        batchSteps.map((step) =>
          executeSubAgentStep(
            step,
            conversation,
            triggerMessage,
            previousOutputs,
            db,
            stream,
            criteria
          )
        )
      );
      for (const result of batchResults) {
        results.push(result.subAgentResult);
        previousOutputs.push(formatSubAgentResultForContext(result.subAgentResult));
      }
      for (const assignment of batch) {
        completedTaskIds.add(assignment.id);
        if (assignment.subTask?.id) {
          completedTaskIds.add(assignment.subTask.id);
        }
      }
    }

    updateDispatchRunStatus(dispatchRun.id, "reviewing", db);
    const reviewed = reviewAcceptanceCriteria({
      criteria,
      results,
      assignments,
      roundIndex
    });
    criteria = reviewed.criteria;
    review = reviewed.review;
    updateDispatchRunExecution(
      dispatchRun.id,
      {
        roundIndex,
        acceptanceCriteria: criteria,
        orchestratorReview: review
      },
      db
    );

    if (review.decision !== "redispatch") {
      break;
    }

    updateDispatchRunStatus(dispatchRun.id, "redispatching", db);
    roundIndex += 1;
    assignments = review.nextAssignments;
    experienceAssignments.push(...assignments);
  }

  const finalStatus = toFinalGroupRunStatus(review, results);
  emitGroupRunEvent(
    {
      groupRunId: dispatchRun.id,
      conversationId: conversation.id,
      type: "summary_started",
      payload: { status: finalStatus }
    },
    db,
    stream
  );

  const finalSummary = await createFinalSummary(
    conversation,
    triggerContent,
    criteria,
    review,
    results,
    db
  );
  const summaryMessage = insertMessage(
    {
      workspaceId: conversation.workspaceId,
      conversationId: conversation.id,
      senderType: "agent",
      senderId: mainAgentId,
      messageType: "orchestrator_summary",
      content: {
        text: finalSummary
      },
      metadata: {
        type: "orchestrator_summary",
        dispatchRunId: dispatchRun.id,
        roundIndex,
        status: finalStatus
      }
    },
    db
  );
  updateDispatchRunStatus(dispatchRun.id, finalStatus, db);
  emitGroupRunEvent(
    {
      groupRunId: dispatchRun.id,
      conversationId: conversation.id,
      type: "summary_completed",
      payload: {
        status: finalStatus,
        summaryMessageId: summaryMessage.id,
        summary: finalSummary
      }
    },
    db,
    stream
  );

  try {
    await updateExperiencesAfterGroupDispatch(
      {
        groupConversationId: conversation.id,
        userTask: triggerContent,
        assignments: experienceAssignments,
        results,
        review
      },
      db
    );
  } catch {
    // Project experience enrichment must never block the group reply.
  }

  return {
    userMessage: triggerMessage,
    dispatchRun: getDispatchRunById(dispatchRun.id, db)!,
    dispatchSteps: getStepsByDispatchRun(dispatchRun.id, db),
    allMessages: getRecentMessagesByConversation(conversation.id, 50, db)
  };
}

export async function handleGroupUserMessage(
  conversationId: string,
  content: string,
  mentionAgentIds?: string[],
  db: AgentHubDatabase = getDatabase(),
  stream?: DispatchStreamHandler
): Promise<SendGroupMessageOutput> {
  const conversation = getConversationById(conversationId, db);

  if (!conversation) {
    throw new DispatchError("Conversation not found.");
  }

  if (conversation.type !== "group") {
    throw new DispatchError("Not a group conversation.");
  }

  const activeRuns = getDispatchRunsByConversation(conversationId, db).filter((run) =>
    ACTIVE_DISPATCH_RUN_STATUSES.has(run.status)
  );
  if (activeRuns.length > 0) {
    const active = activeRuns[0];
    throw new DispatchError(
      `当前群聊还有未完成的分派（状态: ${active.status}），请等待其结束再发新消息。`
    );
  }

  const userMessage = insertMessage(
    {
      workspaceId: conversation.workspaceId,
      conversationId,
      senderType: "user",
      senderId: "local-user",
      messageType: "text",
      content: { text: content },
      status: "completed",
      mentionAgentIds: mentionAgentIds && mentionAgentIds.length > 0 ? mentionAgentIds : undefined
    },
    db
  );

  // Use frontend-provided agent IDs directly when available
  if (mentionAgentIds && mentionAgentIds.length > 0) {
    const members = getActiveMembers(conversationId, db);
    const memberAgentIds = new Set(
      members.filter((m) => m.memberType === "agent").map((m) => m.memberId)
    );
    const workspace = getWorkspaceById(conversation.workspaceId, db);
    const mainAgentId = workspace?.mainAgentId ?? null;

    const mentionedAgents: Agent[] = [];
    for (const agentId of mentionAgentIds) {
      if (agentId === mainAgentId) continue;
      if (!memberAgentIds.has(agentId)) continue;
      const agent = getAgentById(agentId, db);
      if (isDispatchableGroupAgent(agent)) mentionedAgents.push(agent);
    }

    if (mentionedAgents.length > 0) {
      const result = await runMainAgentAutoDispatch(
        conversation,
        userMessage,
        content,
        db,
        stream,
        {
          mode: "mention",
          explicitAgentIds: mentionedAgents.map((agent) => agent.id)
        }
      );
      result.allMessages = getRecentMessagesByConversation(conversationId, 50, db);
      return result;
    }
    const result = await runBlockedMentionDispatch(
      conversation,
      userMessage,
      "用户显式 @ 的 Agent 不在当前群聊、不可用或是主 Agent，无法执行。请更换 Agent 或取消 @ 以启用自动分派。",
      db,
      stream
    );
    result.allMessages = getRecentMessagesByConversation(conversationId, 50, db);
    return result;
  }

  // Fallback: parse mentions from text content
  const mentionNames = parseMentionNames(content);

  if (mentionNames.length > 0) {
    const mentionedAgents = resolveMentionedAgents(mentionNames, conversationId, db);

    if (mentionedAgents.length > 0) {
      const result = await runMainAgentAutoDispatch(
        conversation,
        userMessage,
        content,
        db,
        stream,
        {
          mode: "mention",
          explicitAgentIds: mentionedAgents.map((agent) => agent.id)
        }
      );
      result.allMessages = getRecentMessagesByConversation(conversationId, 50, db);
      return result;
    }
    const result = await runBlockedMentionDispatch(
      conversation,
      userMessage,
      "用户显式 @ 的 Agent 没有解析到当前群聊中的可用子 Agent，系统不会 fallback 到其他 Agent。",
      db,
      stream
    );
    result.allMessages = getRecentMessagesByConversation(conversationId, 50, db);
    return result;
  }

  const result = await runMainAgentAutoDispatch(conversation, userMessage, content, db, stream);
  result.allMessages = getRecentMessagesByConversation(conversationId, 50, db);
  return result;
}

async function runMentionDispatch(
  conversation: Conversation,
  triggerMessage: Message,
  mentionedAgents: Agent[],
  db: AgentHubDatabase,
  stream?: DispatchStreamHandler
): Promise<SendGroupMessageOutput> {
  const dispatchRun = createDispatchRun(
    {
      conversationId: conversation.id,
      triggerMessageId: triggerMessage.id,
      mode: "mention"
    },
    db
  );

  const triggerContent =
    typeof triggerMessage.content === "object" &&
    triggerMessage.content !== null &&
    "text" in triggerMessage.content
      ? (triggerMessage.content as { text: string }).text
      : JSON.stringify(triggerMessage.content);

  const criteria = buildDefaultAcceptanceCriteria(triggerContent);

  return executeStructuredGroupDispatch(
    conversation,
    triggerMessage,
    dispatchRun,
    createAssignments(
      mentionedAgents,
      `根据用户消息执行任务: ${triggerContent}`,
      criteria
    ),
    criteria,
    conversation.mainAgentId ?? "orchestrator",
    db,
    stream
  );
}

async function runBlockedMentionDispatch(
  conversation: Conversation,
  triggerMessage: Message,
  reason: string,
  db: AgentHubDatabase,
  stream?: DispatchStreamHandler
): Promise<SendGroupMessageOutput> {
  const dispatchRun = createDispatchRun(
    {
      conversationId: conversation.id,
      triggerMessageId: triggerMessage.id,
      mode: "mention"
    },
    db
  );
  const mainAgentId = conversation.mainAgentId ?? "orchestrator";
  insertMessage(
    {
      workspaceId: conversation.workspaceId,
      conversationId: conversation.id,
      senderType: "agent",
      senderId: mainAgentId,
      messageType: "text",
      content: { text: reason }
    },
    db
  );
  updateDispatchRunStatus(dispatchRun.id, "failed", db);
  emitGroupRunEvent(
    {
      groupRunId: dispatchRun.id,
      conversationId: conversation.id,
      type: "summary_completed",
      payload: {
        status: "failed",
        summaryMessageId: null,
        summary: reason
      }
    },
    db,
    stream
  );

  return {
    userMessage: triggerMessage,
    dispatchRun: getDispatchRunById(dispatchRun.id, db)!,
    dispatchSteps: []
  };
}

async function runMainAgentAutoDispatch(
  conversation: Conversation,
  triggerMessage: Message,
  rawContent: string,
  db: AgentHubDatabase,
  stream?: DispatchStreamHandler,
  options?: {
    mode?: DispatchMode;
    explicitAgentIds?: string[];
  }
): Promise<SendGroupMessageOutput> {
  const dispatchRun = createDispatchRun(
    {
      conversationId: conversation.id,
      triggerMessageId: triggerMessage.id,
      mode: options?.mode ?? "auto_dispatch"
    },
    db
  );

  updateDispatchRunStatus(dispatchRun.id, "running", db);

  const workspace = getWorkspaceById(conversation.workspaceId, db);

  if (!workspace || !workspace.mainAgentId) {
    updateDispatchRunStatus(dispatchRun.id, "completed", db);
    return runMainAgentDirectReply(conversation, triggerMessage, rawContent, db, stream);
  }

  const mainAgent = getAgentById(workspace.mainAgentId, db);

  if (!mainAgent) {
    updateDispatchRunStatus(dispatchRun.id, "completed", db);
    return runMainAgentDirectReply(conversation, triggerMessage, rawContent, db, stream);
  }

  // Route orchestrator agents through built-in LLM
  if (mainAgent.type === "orchestrator" || isBuiltinProvider(mainAgent.runtimeProvider)) {
    return runOrchestratorAutoDispatch(
      conversation,
      triggerMessage,
      rawContent,
      mainAgent,
      dispatchRun,
      db,
      stream,
      options?.explicitAgentIds
    );
  }

  if (options?.explicitAgentIds && options.explicitAgentIds.length > 0) {
    const criteria = buildDefaultAcceptanceCriteria(rawContent);
    const assignments = await createScoredAssignmentsFromSubTasks({
      conversation,
      userMessage: rawContent,
      subTasks: [buildDefaultSubTask(rawContent, criteria)],
      criteria,
      explicitAgentIds: new Set(options.explicitAgentIds),
      db
    });
    return executeStructuredGroupDispatch(
      conversation,
      triggerMessage,
      dispatchRun,
      assignments,
      criteria,
      mainAgent.id,
      db,
      stream
    );
  }

  // Legacy path: non-orchestrator main agents use runAgent
  return runLegacyAutoDispatch(
    conversation,
    triggerMessage,
    rawContent,
    mainAgent,
    workspace,
    dispatchRun,
    db,
    stream
  );
}

function validateOrchestratorDispatchPlan(
  planSteps: DispatchPlanStepInput[],
  conversation: Conversation,
  mainAgentId: string,
  mentionAgentIds: string[] | undefined,
  db: AgentHubDatabase
): { ok: true } | { ok: false; error: string } {
  if (planSteps.length === 0) {
    return { ok: false, error: "Dispatch plan has no steps." };
  }

  if (planSteps.length > AGENT_EXECUTION_LIMITS.groupMaxAgentsPerRound) {
    return {
      ok: false,
      error: `Dispatch plan exceeds max agents per round (${AGENT_EXECUTION_LIMITS.groupMaxAgentsPerRound}).`
    };
  }

  const members = getActiveMembers(conversation.id, db);
  const memberAgentIds = new Set(
    members.filter((m) => m.memberType === "agent").map((m) => m.memberId)
  );

  const seenAgentIds = new Set<string>();

  for (let i = 0; i < planSteps.length; i++) {
    const step = planSteps[i];

    if (step.agentId === mainAgentId) {
      return { ok: false, error: `Step ${i}: cannot dispatch to main agent.` };
    }

    if (!memberAgentIds.has(step.agentId)) {
      return { ok: false, error: `Step ${i}: agent '${step.agentId}' is not a group member.` };
    }

    const agent = getAgentById(step.agentId, db);
    if (!isDispatchableGroupAgent(agent)) {
      return { ok: false, error: `Step ${i}: agent '${step.agentId}' is not available.` };
    }

    if (seenAgentIds.has(step.agentId)) {
      return { ok: false, error: `Step ${i}: agent '${step.agentId}' appears more than once.` };
    }

    seenAgentIds.add(step.agentId);

    // Check write_diff permission for diff_proposal expected output
    if (step.expectedOutput === "diff_proposal") {
      if (!agent.tools.writeDiff) {
        return {
          ok: false,
          error: `Step ${i}: agent '${step.agentId}' does not have write_diff permission but expectedOutput is 'diff_proposal'.`
        };
      }
    }
  }

  // Validate explicit @ candidate pool
  if (mentionAgentIds && mentionAgentIds.length > 0) {
    const explicitAgentIds = new Set(mentionAgentIds.filter((id) => id !== mainAgentId));
    for (let i = 0; i < planSteps.length; i++) {
      if (!explicitAgentIds.has(planSteps[i].agentId)) {
        const agent = getAgentById(planSteps[i].agentId, db);
        return {
          ok: false,
          error: `Step ${i}: agent '${agent?.name ?? planSteps[i].agentId}' is outside the explicit @ candidate pool.`
        };
      }
    }
  }

  return { ok: true };
}

async function runOrchestratorAutoDispatch(
  conversation: Conversation,
  triggerMessage: Message,
  rawContent: string,
  mainAgent: Agent,
  dispatchRun: ReturnType<typeof createDispatchRun>,
  db: AgentHubDatabase,
  stream?: DispatchStreamHandler,
  explicitAgentIds?: string[]
): Promise<SendGroupMessageOutput> {
  // Captured in the success path so the catch block can include the plan the
  // LLM actually tried to submit, giving it a chance to self-correct on the
  // next turn.
  let attemptedSubTasks: SubTask[] | undefined;
  let attemptedStepCount: number | undefined;

  try {
    const { decision } = await runGroupOrchestratorDecision(
      {
        workspaceId: conversation.workspaceId,
        conversationId: conversation.id,
        userMessage: rawContent,
        mentionAgentIds: explicitAgentIds
      },
      db
    );

    switch (decision.intent) {
      case "dispatch_agents": {
        const criteria =
          decision.acceptanceCriteria && decision.acceptanceCriteria.length > 0
            ? decision.acceptanceCriteria
            : buildDefaultAcceptanceCriteria(rawContent);
        if (decision.plan.subTasks && decision.plan.subTasks.length > 0) {
          attemptedSubTasks = decision.plan.subTasks;
          const assignments = await createScoredAssignmentsFromSubTasks({
            conversation,
            userMessage: rawContent,
            subTasks: decision.plan.subTasks,
            criteria,
            explicitAgentIds:
              explicitAgentIds && explicitAgentIds.length > 0
                ? new Set(explicitAgentIds)
                : undefined,
            db
          });

          if (decision.responseText.trim()) {
            insertMessage(
              {
                workspaceId: conversation.workspaceId,
                conversationId: conversation.id,
                senderType: "agent",
                senderId: mainAgent.id,
                messageType: "text",
                content: { text: decision.responseText }
              },
              db
            );
          }

          return executeStructuredGroupDispatch(
            conversation,
            triggerMessage,
            dispatchRun,
            assignments,
            criteria,
            mainAgent.id,
            db,
            stream
          );
        }

        // Validate the plan
        attemptedStepCount = decision.plan.steps.length;
        const validation = validateOrchestratorDispatchPlan(
          decision.plan.steps,
          conversation,
          mainAgent.id,
          explicitAgentIds,
          db
        );

        if (!validation.ok) {
          // Validation failed: write error message and mark completed
          insertMessage(
            {
              workspaceId: conversation.workspaceId,
              conversationId: conversation.id,
              senderType: "agent",
              senderId: mainAgent.id,
              messageType: "text",
              content: { text: `分派计划校验失败: ${validation.error}\n\n${decision.responseText}` }
            },
            db
          );
          updateDispatchRunStatus(dispatchRun.id, "completed", db);
          return {
            userMessage: triggerMessage,
            dispatchRun: getDispatchRunById(dispatchRun.id, db)!,
            dispatchSteps: []
          };
        }

        const criterionIds = criteria.map((criterion) => criterion.id);
        const assignments: AgentAssignment[] = decision.plan.steps.map((step) => ({
          id: step.id || randomUUID(),
          agentId: step.agentId,
          instruction: step.instruction,
          targetCriteria:
            step.targetCriteria?.filter((criterionId) => criterionIds.includes(criterionId))
              .length
              ? step.targetCriteria.filter((criterionId) => criterionIds.includes(criterionId))
              : criterionIds,
          reason: step.reason || "主 Agent 根据用户目标生成第一轮分派。"
        }));

        if (decision.responseText.trim()) {
          insertMessage(
            {
              workspaceId: conversation.workspaceId,
              conversationId: conversation.id,
              senderType: "agent",
              senderId: mainAgent.id,
              messageType: "text",
              content: { text: decision.responseText }
            },
            db
          );
        }

        return executeStructuredGroupDispatch(
          conversation,
          triggerMessage,
          dispatchRun,
          assignments,
          criteria,
          mainAgent.id,
          db,
          stream
        );
      }

      case "direct_answer":
      case "ask_clarification": {
        if (explicitAgentIds && explicitAgentIds.length > 0) {
          const criteria = buildDefaultAcceptanceCriteria(rawContent);
          const assignments = await createScoredAssignmentsFromSubTasks({
            conversation,
            userMessage: rawContent,
            subTasks: [buildDefaultSubTask(rawContent, criteria)],
            criteria,
            explicitAgentIds: new Set(explicitAgentIds),
            db
          });
          if (decision.responseText.trim()) {
            insertMessage(
              {
                workspaceId: conversation.workspaceId,
                conversationId: conversation.id,
                senderType: "agent",
                senderId: mainAgent.id,
                messageType: "text",
                content: { text: decision.responseText }
              },
              db
            );
          }
          return executeStructuredGroupDispatch(
            conversation,
            triggerMessage,
            dispatchRun,
            assignments,
            criteria,
            mainAgent.id,
            db,
            stream
          );
        }

        // Write the orchestrator's response as a text message
        insertMessage(
          {
            workspaceId: conversation.workspaceId,
            conversationId: conversation.id,
            senderType: "agent",
            senderId: mainAgent.id,
            messageType: "text",
            content: { text: decision.responseText }
          },
          db
        );

        updateDispatchRunStatus(dispatchRun.id, "completed", db);

        return {
          userMessage: triggerMessage,
          dispatchRun: getDispatchRunById(dispatchRun.id, db)!,
          dispatchSteps: []
        };
      }
    }
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : "Unknown error";
    const droppedToolNames = attemptedSubTasks?.flatMap((subTask) =>
      resolveRequiredToolNames(subTask).droppedOriginalNames
    );
    const hint = buildDispatchFailureHint({
      error: errorMsg,
      attemptedSubTasks,
      droppedToolNames: droppedToolNames && droppedToolNames.length > 0 ? droppedToolNames : undefined
    });

    insertMessage(
      {
        workspaceId: conversation.workspaceId,
        conversationId: conversation.id,
        senderType: "agent",
        senderId: mainAgent.id,
        messageType: "text",
        content: { text: hint },
        metadata: {
          type: "orchestrator_dispatch_failure",
          dispatchRunId: dispatchRun.id,
          error: errorMsg,
          attemptedSubTaskCount: attemptedSubTasks?.length,
          attemptedStepCount,
          droppedToolNames
        }
      },
      db
    );

    updateDispatchRunStatus(dispatchRun.id, "failed", db);

    return {
      userMessage: triggerMessage,
      dispatchRun: getDispatchRunById(dispatchRun.id, db)!,
      dispatchSteps: []
    };
  }
}

async function runLegacyAutoDispatch(
  conversation: Conversation,
  triggerMessage: Message,
  rawContent: string,
  mainAgent: Agent,
  workspace: Workspace,
  dispatchRun: ReturnType<typeof createDispatchRun>,
  db: AgentHubDatabase,
  stream?: DispatchStreamHandler
): Promise<SendGroupMessageOutput> {
  const members = getActiveMembers(conversation.id, db);
  const subAgentMembers = members.filter(
    (m) => m.memberType === "agent" && m.memberId !== workspace.mainAgentId
  );

  const subAgentList = subAgentMembers
    .map((m) => {
      const agent = getAgentById(m.memberId, db);
      return agent
        ? `- id: ${agent.id}, name: ${agent.name}, capabilities: ${getEffectiveAgentCapabilities(agent).join(", ")}`
        : "";
    })
    .filter((s) => s.length > 0)
    .join("\n");

  const dispatchPrompt = [
    buildMainAgentPrompt(mainAgent, workspace),
    "",
    "你现在需要分析用户消息，决定是否需要分派任务给子 Agent。",
    "",
    "可用子 Agent 列表:",
    subAgentList || "（无可用子 Agent）",
    "",
    `用户消息: ${rawContent}`,
    "",
    "请输出一个 JSON 对象，格式如下:",
    '```json',
    '{',
    '  "need_dispatch": true/false,',
    '  "steps": [',
    '    { "agent_id": "子Agent的ID", "instruction": "给该Agent的任务描述" }',
    '  ],',
    '  "final_summary_by_main_agent": true/false',
    '}',
    '```',
    "",
    "规则:",
    `- 最多选择 ${MAX_DISPATCH_STEPS} 个子 Agent`,
    "- 不能选择自己（主 Agent）",
    "- 每个 Agent 只能出现一次",
    "- instruction 不能为空",
    "- 如果不需要分派，设置 need_dispatch 为 false",
    "",
    "如果不需要分派，请直接回复用户消息。不要输出 JSON。"
  ].join("\n");

  try {
    const result = await runAgent(
      {
        workspaceId: conversation.workspaceId,
        conversationId: conversation.id,
        agentId: mainAgent.id,
        userMessage: dispatchPrompt
      },
      db,
      undefined,
      undefined,
      undefined
    );

    const mainAgentOutput = result.messages.find(
      (m) => m.senderType === "agent" && m.messageType === "text"
    );

    if (!mainAgentOutput) {
      updateDispatchRunStatus(dispatchRun.id, "completed", db);
      return runMainAgentDirectReply(conversation, triggerMessage, rawContent, db, stream);
    }

    const outputText =
      typeof mainAgentOutput.content === "object" &&
      mainAgentOutput.content !== null &&
      "text" in mainAgentOutput.content
        ? (mainAgentOutput.content as { text: string }).text
        : "";

    const plan = parseDispatchPlan(outputText);

    // Delete the main agent's raw output (contains JSON plan) from group conversation
    if (mainAgentOutput.id) {
      deleteMessage(mainAgentOutput.id, db);
    }

    if (!plan || !validateDispatchPlan(plan, conversation, workspace.mainAgentId!, db)) {
      updateDispatchRunStatus(dispatchRun.id, "completed", db);
      return {
        userMessage: triggerMessage,
        dispatchRun: getDispatchRunById(dispatchRun.id, db)!,
        dispatchSteps: []
      };
    }

    // Write dispatch plan as group message
    const planDescription = plan.steps
      .map((s, i) => {
        const agent = getAgentById(s.agent_id, db);
        const agentName = agent?.name ?? s.agent_id;
        return `${i + 1}. Agent(${agentName}): ${s.instruction}`;
      })
      .join("\n");

    const planMessage = insertMessage(
      {
        workspaceId: conversation.workspaceId,
        conversationId: conversation.id,
        senderType: "agent",
        senderId: mainAgent.id,
        messageType: "dispatch_plan",
        content: {
          text: `分派计划:\n${planDescription}`
        },
        metadata: {
          type: "dispatch_plan",
          dispatchRunId: dispatchRun.id,
          plan,
          agentNames: buildAgentNameMap(plan.steps.map((step) => step.agent_id), db)
        }
      },
      db
    );

    // Stream dispatch plan to frontend immediately
    stream?.({ type: "dispatch_plan_message", message: planMessage });

    // Yield the event loop to ensure the IPC event is delivered to the renderer
    // before sub-agents start executing and sending their own events
    await new Promise<void>((resolve) => setTimeout(resolve, 0));

    const steps: DispatchStep[] = plan.steps.map((planStep, index) =>
      createDispatchStep(
        {
          dispatchRunId: dispatchRun.id,
          stepIndex: index,
          agentId: planStep.agent_id,
          instruction: planStep.instruction
        },
        db
      )
    );

    const previousOutputs: PreviousTaskSummary[] = [];
    const stepOutputs: Array<string | undefined> = [];

    for (const step of steps) {
      const result = await executeSubAgentStep(
        step,
        conversation,
        triggerMessage,
        previousOutputs,
        db,
        stream
      );

      if (result.outputMessage) {
        const outputText =
          typeof result.outputMessage.content === "object" &&
          result.outputMessage.content !== null &&
          "text" in result.outputMessage.content
            ? (result.outputMessage.content as { text: string }).text
            : JSON.stringify(result.outputMessage.content);
        previousOutputs.push({
          summary: outputText,
          keyConstraints: []
        });
        stepOutputs[step.stepIndex] = outputText;
      }
    }

    // Write orchestrator summary
    const summaryParts = steps.map((step) => {
      const agent = getAgentById(step.agentId, db);
      const stepOutput = stepOutputs[step.stepIndex];
      return stepOutput
        ? `### ${agent?.name ?? step.agentId}\n${stepOutput}`
        : `### ${agent?.name ?? step.agentId}\n(执行失败或无输出)`;
    });

    const summaryContent = [
      `本轮群聊分派完成，共 ${steps.length} 个子 Agent 参与。`,
      "",
      ...summaryParts,
      "",
      "以上为各子 Agent 的独立产出。请结合 Workspace 的 Git Diff 核对实际变更。"
    ].join("\n");

    insertMessage(
      {
        workspaceId: conversation.workspaceId,
        conversationId: conversation.id,
        senderType: "agent",
        senderId: mainAgent.id,
        messageType: "orchestrator_summary",
        content: { text: summaryContent },
        metadata: {
          type: "orchestrator_summary",
          dispatchRunId: dispatchRun.id
        }
      },
      db
    );

    updateDispatchRunStatus(dispatchRun.id, "completed", db);

    return {
      userMessage: triggerMessage,
      dispatchRun: getDispatchRunById(dispatchRun.id, db)!,
      dispatchSteps: getStepsByDispatchRun(dispatchRun.id, db)
    };
  } catch {
    updateDispatchRunStatus(dispatchRun.id, "completed", db);
    return runMainAgentDirectReply(conversation, triggerMessage, rawContent, db, stream);
  }
}

async function runMainAgentDirectReply(
  conversation: Conversation,
  triggerMessage: Message,
  rawContent: string,
  db: AgentHubDatabase,
  stream?: DispatchStreamHandler
): Promise<SendGroupMessageOutput> {
  const dispatchRun = createDispatchRun(
    {
      conversationId: conversation.id,
      triggerMessageId: triggerMessage.id,
      mode: "main_direct"
    },
    db
  );

  updateDispatchRunStatus(dispatchRun.id, "running", db);

  const workspace = getWorkspaceById(conversation.workspaceId, db);

  if (!workspace || !workspace.mainAgentId) {
    updateDispatchRunStatus(dispatchRun.id, "failed", db);
    return {
      userMessage: triggerMessage,
      dispatchRun: getDispatchRunById(dispatchRun.id, db)!,
      dispatchSteps: []
    };
  }

  const mainAgent = getAgentById(workspace.mainAgentId, db);

  if (!mainAgent) {
    updateDispatchRunStatus(dispatchRun.id, "failed", db);
    return {
      userMessage: triggerMessage,
      dispatchRun: getDispatchRunById(dispatchRun.id, db)!,
      dispatchSteps: []
    };
  }

  const step = createDispatchStep(
    {
      dispatchRunId: dispatchRun.id,
      stepIndex: 0,
      agentId: mainAgent.id,
      instruction: `回复用户消息: ${rawContent}`
    },
    db
  );

  const result = await executeSubAgentStep(
    step,
    conversation,
    triggerMessage,
    [],
    db,
    stream
  );

  updateDispatchRunStatus(dispatchRun.id, result.success ? "completed" : "failed", db);

  return {
    userMessage: triggerMessage,
    dispatchRun: getDispatchRunById(dispatchRun.id, db)!,
    dispatchSteps: getStepsByDispatchRun(dispatchRun.id, db)
  };
}

export async function dispatchGroupTasks(
  input: DispatchGroupTasksInput,
  db: AgentHubDatabase = getDatabase(),
  stream?: DispatchStreamHandler
): Promise<DispatchGroupTasksOutput> {
  const conversation = getConversationById(input.conversationId, db);

  if (!conversation) {
    throw new DispatchError("Conversation not found.");
  }

  if (conversation.type !== "group") {
    throw new DispatchError("Not a group conversation.");
  }

  const triggerMessage = getMessageById(input.userMessageId, db);

  if (!triggerMessage) {
    throw new DispatchError("User message not found.");
  }

  if (
    triggerMessage.conversationId !== conversation.id ||
    triggerMessage.senderType !== "user"
  ) {
    throw new DispatchError("Trigger message must be a user message from this conversation.");
  }

  if (input.assignments.length === 0) {
    throw new DispatchError("At least one assignment is required.");
  }

  if (input.assignments.length > MAX_DISPATCH_STEPS) {
    throw new DispatchError(`Assignments exceed max steps (${MAX_DISPATCH_STEPS}).`);
  }

  const triggerContent =
    typeof triggerMessage.content === "object" &&
    triggerMessage.content !== null &&
    "text" in triggerMessage.content
      ? (triggerMessage.content as { text: string }).text
      : JSON.stringify(triggerMessage.content);

  // Validate all agents are group members
  const members = getActiveMembers(conversation.id, db);
  const memberAgentIds = new Set(
    members.filter((m) => m.memberType === "agent").map((m) => m.memberId)
  );

  const seenAgentIds = new Set<string>();

  for (const assignment of input.assignments) {
    if (assignment.agentId === conversation.mainAgentId) {
      throw new DispatchError("Cannot dispatch a task to the main agent.");
    }
    if (!memberAgentIds.has(assignment.agentId)) {
      throw new DispatchError(`Agent ${assignment.agentId} is not a member of this group.`);
    }
    if (!isDispatchableGroupAgent(getAgentById(assignment.agentId, db))) {
      throw new DispatchError(`Agent ${assignment.agentId} is not available.`);
    }
    if (seenAgentIds.has(assignment.agentId)) {
      throw new DispatchError(`Agent ${assignment.agentId} appears more than once.`);
    }
    if (!assignment.task.trim()) {
      throw new DispatchError("Assignment task must not be empty.");
    }
    seenAgentIds.add(assignment.agentId);
  }

  // Sort by order
  const sortedAssignments = [...input.assignments].sort((a, b) => a.order - b.order);

  const dispatchRun = createDispatchRun(
    {
      conversationId: conversation.id,
      triggerMessageId: triggerMessage.id,
      mode: "mention"
    },
    db
  );

  const criteria = buildDefaultAcceptanceCriteria(triggerContent);
  const criterionIds = criteria.map((criterion) => criterion.id);

  return executeStructuredGroupDispatch(
    conversation,
    triggerMessage,
    dispatchRun,
    sortedAssignments.map((assignment) => ({
      id: assignment.id || randomUUID(),
      agentId: assignment.agentId,
      instruction: assignment.task,
      targetCriteria:
        assignment.targetCriteria && assignment.targetCriteria.length > 0
          ? assignment.targetCriteria
          : criterionIds,
      reason: assignment.reason
    })),
    criteria,
    conversation.mainAgentId ?? "orchestrator",
    db,
    stream
  );
}

export async function retryDispatchStep(
  stepId: string,
  db: AgentHubDatabase = getDatabase(),
  stream?: DispatchStreamHandler
): Promise<{ step: DispatchStep; outputMessage: Message | null }> {
  const step = getDispatchStepById(stepId, db);

  if (!step) {
    throw new DispatchError("Dispatch step not found.");
  }

  if (step.status !== "failed") {
    throw new DispatchError("Can only retry failed steps.");
  }

  const dispatchRun = getDispatchRunById(step.dispatchRunId, db);

  if (!dispatchRun) {
    throw new DispatchError("Dispatch run not found.");
  }

  const triggerMessage = getMessageById(dispatchRun.triggerMessageId, db);

  if (!triggerMessage) {
    throw new DispatchError("Trigger message not found.");
  }

  const conversation = getConversationById(dispatchRun.conversationId, db);

  if (!conversation) {
    throw new DispatchError("Conversation not found.");
  }

  const result = await executeSubAgentStep(
    step,
    conversation,
    triggerMessage,
    [],
    db,
    stream
  );

  const updatedStep = getDispatchStepById(stepId, db)!;
  const outputMessage = result.outputMessage;

  return { step: updatedStep, outputMessage };
}

export async function runMainAgentDiffReview(
  conversationId: string,
  dispatchRunId: string,
  db: AgentHubDatabase = getDatabase()
): Promise<void> {
  const conversation = getConversationById(conversationId, db);

  if (!conversation || conversation.type !== "group") {
    return;
  }

  const workspace = getWorkspaceById(conversation.workspaceId, db);

  if (!workspace || !workspace.mainAgentId) {
    return;
  }

  const mainAgent = getAgentById(workspace.mainAgentId, db);

  if (!mainAgent) {
    return;
  }

  const diffProposals = getDiffProposalsByDispatchRun(dispatchRunId, db);

  if (diffProposals.length === 0) {
    return;
  }

  const diffSummaries = diffProposals
    .map(
      (dp) =>
        `- DiffProposal ${dp.id}: file=${dp.filePath}, agent=${dp.agentId}, status=${dp.status}`
    )
    .join("\n");

  const reviewPrompt = [
    "你正在审核群聊中子 Agent 提交的 DiffProposal。",
    "",
    "本轮 DiffProposal 列表:",
    diffSummaries,
    "",
    "请审核这些 DiffProposal，输出以下 JSON:",
    '```json',
    '{',
    '  "accepted_diff_ids": ["diff-id-1", "diff-id-2"],',
    '  "rejected_diff_ids": ["diff-id-3"],',
    '  "conflicts": [',
    '    { "file": "path/to/file", "reason": "冲突原因" }',
    '  ],',
    '  "review_summary": "审核总结"',
    '}',
    '```',
    "",
    "规则:",
    "- 如果多个 Agent 修改了同一文件的相近区域，标记为冲突",
    "- 不要自动应用任何 DiffProposal",
    "- 最终应用权在用户手里"
  ].join("\n");

  try {
    const result = await runAgent(
      {
        workspaceId: conversation.workspaceId,
        conversationId: conversation.id,
        agentId: mainAgent.id,
        userMessage: reviewPrompt
      },
      db
    );

    const reviewMessage = result.messages.find(
      (m) => m.senderType === "agent" && m.messageType === "text"
    );

    if (!reviewMessage) {
      return;
    }

    const reviewText =
      typeof reviewMessage.content === "object" &&
      reviewMessage.content !== null &&
      "text" in reviewMessage.content
        ? (reviewMessage.content as { text: string }).text
        : "";

    const jsonMatch = reviewText.match(/```json\s*([\s\S]*?)```/);
    const jsonStr = jsonMatch ? jsonMatch[1].trim() : reviewText.trim();

    try {
      const review = JSON.parse(jsonStr) as MainAgentDiffReviewOutput;

      if (review.accepted_diff_ids) {
        for (const diffId of review.accepted_diff_ids) {
          try {
            updateDiffProposal(diffId, { status: "pending" }, db);
          } catch {
            // diff not found, skip
          }
        }
      }

      if (review.rejected_diff_ids) {
        for (const diffId of review.rejected_diff_ids) {
          try {
            updateDiffProposal(diffId, { status: "rejected" }, db);
          } catch {
            // diff not found, skip
          }
        }
      }

      if (review.conflicts) {
        for (const conflict of review.conflicts) {
          const conflictingDiffs = diffProposals.filter((dp) => dp.filePath === conflict.file);
          for (const dp of conflictingDiffs) {
            updateDiffProposal(dp.id, { status: "conflicted" }, db);
          }
        }
      }
    } catch {
      // Failed to parse review JSON, skip
    }
  } catch {
    // Failed to run main agent review, skip
  }
}
