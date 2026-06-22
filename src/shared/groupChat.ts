import type { Agent } from "./domain";
import type { AgentRunResult } from "./agentExecution";

export const MAX_DISPATCH_STEPS = 30;

export type ConversationType = "direct" | "group";

export type ConversationMemberType = "user" | "agent";

export type ConversationMemberRole = "owner" | "main_agent" | "member";

export type ConversationMemberStatus = "active" | "removed";

export type ConversationMember = {
  id: string;
  conversationId: string;
  memberType: ConversationMemberType;
  memberId: string;
  role: ConversationMemberRole;
  status: ConversationMemberStatus;
  joinedAt: string;
};

export type MessageStatus = "streaming" | "completed" | "failed" | "cancelled";

export type DispatchMode = "mention" | "auto_dispatch" | "main_direct";

export type GroupRunStatus =
  | "planning"
  | "plan_created"
  | "running_subagents"
  | "reviewing"
  | "redispatching"
  | "completed"
  | "partial"
  | "partial_failed"
  | "failed"
  | "waiting_for_user";

export type DispatchRunStatus = GroupRunStatus | "running" | "cancelled";

export type SubAgentRunStatus =
  | "queued"
  | "running"
  | "completed"
  | "partial"
  | "failed"
  | "iteration_limit_reached"
  | "waiting_for_permission"
  | "cancelled";

export type DispatchStepStatus =
  | SubAgentRunStatus
  | "pending"
  | "streaming"
  | "skipped";

export type AcceptanceCriterion = {
  id: string;
  description: string;
  type: "code_change" | "test" | "ui" | "doc" | "analysis" | "constraint";
  required: boolean;
  status: "pending" | "satisfied" | "failed" | "unknown";
  evidence?: string;
};

export type SubAgentResultMetadata = {
  parseSucceeded?: boolean;
  parseError?: string;
  outputTruncated?: boolean;
  finishReason?: string | null;
  stopReason?: string | null;
  rawTextLength?: number;
  timeoutTriggered?: boolean;
  continuationAttempts?: number;
  recoveredFromTruncation?: boolean;
  deliverableValidationFailed?: boolean;
  localRepairExhausted?: boolean;
  invalidArtifactIds?: string[];
};

export type SubAgentOutputRef = {
  type: "markdown" | "html" | "text" | "diff" | "file" | "json" | "command_result";
  artifactId?: string;
  diffProposalId?: string;
  filePath?: string;
  preview?: string;
  isComplete?: boolean;
};

export type SubAgentEvidence = {
  criterionId: string;
  artifactId?: string;
  outputIndex?: number;
  summary: string;
};

export type SubTaskRiskLevel = "low" | "medium" | "high";

export type SubTaskExpectedOutputType =
  | "analysis"
  | "design"
  | "diff_proposal"
  | "test_plan"
  | "summary";

export type SubTask = {
  id: string;
  title: string;
  objective: string;
  acceptanceCriteria: string[];
  requiredSkillQueries: string[];
  requiredTools: string[];
  taskType: string;
  targetFiles?: string[];
  dependsOn: string[];
  riskLevel: SubTaskRiskLevel;
  expectedOutputType: SubTaskExpectedOutputType;
};

export type CapabilityMatchResult = {
  agentId: string;
  taskId: string;
  capabilityMatch: number;
  confidence: number;
  matchedSkills: {
    skillName: string;
    relevance: number;
    reason: string;
  }[];
  missingSkills: string[];
  reason: string;
};

export type AgentDispatchScore = {
  agentId: string;
  taskId: string;
  finalScore: number;
  capabilityMatch: number;
  toolMatch: number;
  contextRelevance: number;
  historicalReliability: number;
  confidence: number;
  matchedSkills: CapabilityMatchResult["matchedSkills"];
  missingSkills: string[];
  reason: string;
};

export type PreviousTaskSummary = {
  summary: string;
  keyConstraints: string[];
  diffSummary?: string;
  failedItems?: string[];
  nextRequiredActions?: string[];
};

export type SubAgentResult = {
  agentId: string;
  status:
    | "completed"
    | "partial"
    | "failed"
    | "no_changes_needed"
    | "iteration_limit_reached";
  summary: string;
  deliverable?: string;
  outputs?: SubAgentOutputRef[];
  evidence?: SubAgentEvidence[];
  artifactIds?: string[];
  completedCriteria: string[];
  unresolvedCriteria: string[];
  filesRead: string[];
  filesChanged?: string[];
  diffProposalId?: string;
  verification?: {
    commandsRun: string[];
    passed: boolean;
    outputSummary?: string;
  };
  assumptions: string[];
  risks: string[];
  nextSuggestedTask?: string;
  parseError?: string;
  metadata?: SubAgentResultMetadata;
  runResult?: AgentRunResult;
};

export type AgentAssignment = {
  id: string;
  agentId: string;
  instruction: string;
  targetCriteria: string[];
  dependsOn?: string[];
  reason: string;
  subTask?: SubTask;
  score?: AgentDispatchScore;
  reviewerAgentId?: string;
};

export type SubAgentTaskSelectedMessage = {
  id: string;
  role: "user" | "main_agent" | "sub_agent" | "system";
  senderId: string;
  text: string;
  reason: string;
  createdAt?: string;
};

export type SubAgentTaskFileSummary = {
  path: string;
  summary: string;
  reason?: string;
};

export type SubAgentTaskPreviousOutput = {
  summary: string;
  keyConstraints?: string[];
  diffSummary?: string;
  failedItems?: string[];
  nextRequiredActions?: string[];
  agentId?: string;
  outputRefs?: SubAgentOutputRef[];
  reason: string;
};

export type SubAgentTaskInput = {
  schemaVersion: 1;
  taskId: string;
  dispatchRunId: string;
  dispatchStepId: string;
  parentMessageId: string;
  userGoal: string;
  assignedInstruction: string;
  assignedAgent: {
    id: string;
    name: string;
    role: Agent["role"];
    systemPrompt: string;
  };
  targetCriteria: AcceptanceCriterion[];
  constraints: string[];
  allowedTools: string[];
  workspace: {
    rootPath: string;
    gitEnabled: boolean;
  };
  relevantContext: {
    selectedMessages: SubAgentTaskSelectedMessage[];
    selectedFiles?: SubAgentTaskFileSummary[];
    previousAgentOutputs?: SubAgentTaskPreviousOutput[];
    workspaceSummary?: string;
    memorySummary?: string;
  };
  expectedOutput: {
    format: "sub_agent_result_json" | "markdown" | "diff_proposal";
    requiredFields: string[];
  };
};

export type OrchestratorReview = {
  decision: "complete" | "redispatch" | "need_user_input" | "partial" | "failed";
  satisfiedCriteria: string[];
  unresolvedCriteria: string[];
  evidence: {
    criterionId: string;
    sourceAgentId: string;
    evidenceText: string;
  }[];
  nextAssignments: AgentAssignment[];
  reason: string;
};

export type DispatchRun = {
  id: string;
  conversationId: string;
  triggerMessageId: string;
  mode: DispatchMode;
  status: DispatchRunStatus;
  maxSteps: number;
  roundIndex: number;
  acceptanceCriteria: AcceptanceCriterion[];
  orchestratorReview: OrchestratorReview | null;
  finalSummaryEnabled: boolean;
  diffReviewRequired: boolean;
  createdAt: string;
  finishedAt: string | null;
};

export type GroupRun = DispatchRun;

export type DispatchStep = {
  id: string;
  dispatchRunId: string;
  stepIndex: number;
  agentId: string;
  instruction: string;
  status: DispatchStepStatus;
  roundIndex: number;
  assignmentId: string | null;
  targetCriteria: string[];
  subAgentResult: SubAgentResult | null;
  maxIterations: number;
  inputContextSnapshot: SubAgentTaskInput | null;
  outputMessageId: string | null;
  errorMessage: string | null;
  startedAt: string | null;
  finishedAt: string | null;
};

export type DispatchPlanStep = {
  agent_id: string;
  instruction: string;
  expectedOutput?: "text" | "diff_proposal" | "review_report";
  targetCriteria?: string[];
  reason?: string;
};

export type DispatchPlan = {
  need_dispatch: boolean;
  steps: DispatchPlanStep[];
  subTasks?: SubTask[];
  final_summary_by_main_agent: boolean;
};

export type MainAgentDiffReviewOutput = {
  accepted_diff_ids: string[];
  rejected_diff_ids: string[];
  conflicts: Array<{
    file: string;
    reason: string;
  }>;
  review_summary: string;
};

export type CreateGroupConversationInput = {
  /** Legacy compatibility owner. Omit when creating a global group chat. */
  workspaceId?: string;
  title: string;
  description?: string;
  memberAgentIds?: string[];
};

export type CreateGroupConversationOutput = {
  conversation: import("./domain").Conversation;
  members: ConversationMember[];
  memberAgentIds: string[];
};

export type AddGroupMemberInput = {
  conversationId: string;
  agentId: string;
};

export type AddGroupMembersInput = {
  groupConversationId: string;
  agentIds: string[];
};

export type AddGroupMembersResult = {
  addedAgentIds: string[];
  skippedAgentIds: string[];
  invalidAgentIds: string[];
};

export type RemoveGroupMemberInput = {
  conversationId: string;
  memberId: string;
};

export type UpdateGroupProfileInput = {
  conversationId: string;
  title?: string;
  description?: string;
  avatar?: string;
  autoDispatchEnabled?: boolean;
};

export type UpdateGroupWorkspaceInput = {
  conversationId: string;
  rootPath: string;
  gitEnabled?: boolean;
};

export type SendGroupMessageInput = {
  conversationId: string;
  content: string;
  mentionAgentIds?: string[];
};

export type SendGroupMessageOutput = {
  userMessage: import("./domain").Message;
  dispatchRun: DispatchRun;
  dispatchSteps: DispatchStep[];
  allMessages?: import("./domain").Message[];
};

export type RetryDispatchStepInput = {
  stepId: string;
};

export type RetryDispatchStepOutput = {
  step: DispatchStep;
  outputMessage: import("./domain").Message | null;
};

export type GroupMemberWithAgent = ConversationMember & {
  agent: Agent | null;
};

export type GroupRunEventType =
  | "plan_created"
  | "agent_started"
  | "agent_progress"
  | "agent_completed"
  | "agent_failed"
  | "summary_started"
  | "summary_completed";

export type GroupRunPlanAssignment = {
  stepId: string;
  stepIndex: number;
  roundIndex: number;
  assignmentId: string | null;
  agentId: string;
  agentName: string;
  instruction: string;
  targetCriteria: string[];
  reason?: string;
  dependsOn?: string[];
  targetFiles?: string[];
  taskTitle?: string;
  taskType?: string;
  expectedOutputType?: SubTaskExpectedOutputType;
  riskLevel?: SubTaskRiskLevel;
  score?: AgentDispatchScore;
};

export type GroupRunAgentEventPayload = {
  stepId: string;
  stepIndex: number;
  roundIndex: number;
  agentId: string;
  agentName?: string;
  agentRunId?: string;
  instruction?: string;
  status?: DispatchStepStatus;
  summary?: string;
  diffProposalId?: string;
  detailAvailable?: boolean;
  errorMessage?: string;
};

export type GroupRunAgentProgressPayload = GroupRunAgentEventPayload & {
  title: string;
  body?: string;
  level: "info" | "warning" | "error";
  phase:
    | "context"
    | "runtime"
    | "model"
    | "stream"
    | "parse"
    | "validation"
    | "complete";
};

export type GroupRunEventBase = {
  id: string;
  groupRunId: string;
  conversationId: string;
  seq: number;
  type: GroupRunEventType;
  createdAt: string;
};

export type GroupRunEvent =
  | (GroupRunEventBase & {
      type: "plan_created";
      payload: {
        mode: DispatchMode;
        roundIndex: number;
        assignments: GroupRunPlanAssignment[];
      };
    })
  | (GroupRunEventBase & {
      type: "agent_started";
      payload: GroupRunAgentEventPayload;
    })
  | (GroupRunEventBase & {
      type: "agent_progress";
      payload: GroupRunAgentProgressPayload;
    })
  | (GroupRunEventBase & {
      type: "agent_completed";
      payload: GroupRunAgentEventPayload & {
        status: DispatchStepStatus;
        summary: string;
        detailAvailable: boolean;
      };
    })
  | (GroupRunEventBase & {
      type: "agent_failed";
      payload: GroupRunAgentEventPayload & {
        status: "failed";
        summary: string;
        detailAvailable: boolean;
      };
    })
  | (GroupRunEventBase & {
      type: "summary_started";
      payload: {
        status: DispatchRunStatus;
      };
    })
  | (GroupRunEventBase & {
      type: "summary_completed";
      payload: {
        status: DispatchRunStatus;
        summaryMessageId: string | null;
        summary: string;
      };
    });

export type DispatchStepUpdateEvent = {
  type: "dispatch_step_update";
  dispatchRunId: string;
  stepId: string;
  stepIndex: number;
  agentId: string;
  status: DispatchStepStatus;
  textDelta?: string;
};

export type DispatchPlanMessageEvent = {
  type: "dispatch_plan_message";
  message: import("./domain").Message;
};

export type GroupRunStreamEvent = {
  type: "group_run_event";
  event: GroupRunEvent;
};

export type DispatchRunStreamEvent =
  | DispatchStepUpdateEvent
  | DispatchPlanMessageEvent
  | GroupRunStreamEvent;

export type GroupAgentInfo = {
  agentId: string;
  name: string;
  role: string;
  provider: string;
  capabilities: string[];
  tools: Record<string, boolean>;
  status: string;
  workspaceId: string;
  rootPath: string;
};

export type GroupTaskAssignment = {
  id?: string;
  agentId: string;
  task: string;
  reason: string;
  order: number;
  targetCriteria?: string[];
};

export type DispatchGroupTasksInput = {
  conversationId: string;
  userMessageId: string;
  assignments: GroupTaskAssignment[];
};

export type DispatchGroupTasksOutput = {
  userMessage: import("./domain").Message;
  dispatchRun: DispatchRun;
  dispatchSteps: DispatchStep[];
  allMessages?: import("./domain").Message[];
};
