import type { RuntimeProvider, RuntimeStatus } from "./runtime";
import type { Artifact } from "./artifact";
import type { DiffProposal } from "./diff";
import type { AgentRunResult } from "./agentExecution";

export type { RuntimeProvider, RuntimeStatus } from "./runtime";

export type Workspace = {
  id: string;
  name: string;
  rootPath: string;
  mainAgentId: string | null;
  gitEnabled: boolean;
  createdAt: string;
  updatedAt: string;
};

export type WorkspaceContextOwnerType =
  | "agent"
  | "group"
  | "conversation"
  | "legacy_workspace";

export type WorkspaceContext = {
  id: string;
  ownerType: WorkspaceContextOwnerType;
  ownerId: string;
  rootPath: string;
  gitEnabled: boolean;
  createdAt: string;
  updatedAt: string;
};

export type CreateWorkspaceInput = {
  name?: string;
  rootPath: string;
  mainAgentId?: string | null;
  gitEnabled?: boolean;
  mainAgentRuntimeProvider?: RuntimeProvider;
};

export type UpdateWorkspaceInput = Partial<
  Pick<Workspace, "name" | "rootPath" | "mainAgentId" | "gitEnabled">
>;

export type PrepareCreateWorkspaceInput = {
  rootPath: string;
};

export type PreparedWorkspaceCreate = {
  rootPath: string;
  inferredName: string;
  gitEnabled: boolean;
  runtimeStatuses: RuntimeStatus[];
  defaultRuntimeProvider: RuntimeProvider;
  existingWorkspace?: Workspace;
};

export type AgentRole = "main" | "sub";

export type AgentType = "orchestrator" | "specialist";

export type AgentStatus =
  | "draft"
  | "available"
  | "running"
  | "error"
  | "unavailable"
  | "disabled"
  | "deleted";

export type AgentRuntimeStatus = Extract<
  AgentStatus,
  "available" | "running" | "error" | "unavailable"
>;

export type AgentToolPermissions = {
  readFile: boolean;
  writeDiff: boolean;
  applyDiff: boolean;
  previewArtifact: boolean;
  gitStatus: boolean;
  webSearch?: boolean;
  webFetch?: boolean;
};

export type AgentToolName = keyof AgentToolPermissions;

// Claude Code permission modes
export type ClaudeCodePermissionMode =
  | "default"
  | "acceptEdits"
  | "plan"
  | "auto"
  | "dontAsk"
  | "bypassPermissions";

// Claude Code specific configuration
export type ClaudeCodeConfig = {
  permissionMode: ClaudeCodePermissionMode;
  allowedTools: string[];
  deniedTools: string[];
};

export type ToolPermissionError = {
  code: "TOOL_PERMISSION_DENIED" | "PATH_OUTSIDE_WORKSPACE";
  message: string;
  agentId?: string;
  tool?: AgentToolName;
  path?: string;
};

export type Agent = {
  id: string;
  /** Compatibility owner only. New execution paths resolve defaultWorkspaceContextId. */
  workspaceId: string;
  defaultWorkspaceContextId?: string;
  avatar?: string;
  name: string;
  description?: string;
  role: AgentRole;
  type: AgentType;
  runtimeProvider: RuntimeProvider;
  systemPrompt: string;
  capabilities: string[];
  skillIds?: string[];
  tools: AgentToolPermissions;
  fileScope: string[];
  claudeCodeConfig?: ClaudeCodeConfig;
  modelProviderId?: string;
  model?: string;
  status: AgentStatus;
  createdAt: string;
  updatedAt: string;
};

export type CreateAgentInput = {
  workspaceId: string;
  id?: string;
  defaultWorkspaceContextId?: string;
  avatar?: string;
  name: string;
  description?: string;
  role: AgentRole;
  type?: AgentType;
  runtimeProvider: RuntimeProvider;
  systemPrompt?: string;
  capabilities?: string[];
  skillIds?: string[];
  tools?: Partial<AgentToolPermissions>;
  fileScope?: string[];
  claudeCodeConfig?: ClaudeCodeConfig;
  modelProviderId?: string;
  model?: string;
  status?: AgentStatus;
};

export type UpdateAgentInput = Partial<
  Pick<
    Agent,
    | "name"
    | "description"
    | "avatar"
    | "defaultWorkspaceContextId"
    | "role"
    | "type"
    | "runtimeProvider"
    | "systemPrompt"
    | "capabilities"
    | "skillIds"
    | "fileScope"
    | "claudeCodeConfig"
    | "modelProviderId"
    | "model"
    | "status"
  >
> & {
  tools?: Partial<AgentToolPermissions>;
};

export type UpdateAgentStatusInput = {
  agentId: string;
  status: AgentRuntimeStatus;
};

export type ConversationMode = "single" | "main_agent_setup";

export type Conversation = {
  id: string;
  /** Compatibility owner only. New execution paths resolve workspaceContextId. */
  workspaceId: string;
  workspaceContextId: string | null;
  agentId: string;
  avatar: string | null;
  status: "active" | "archived";
  lastMessageAt: string | null;
  lastMessagePreview?: string;
  provider: RuntimeProvider | null;
  title: string;
  mode: ConversationMode;
  createdAt: string;
  updatedAt: string;
  type: import("./groupChat").ConversationType;
  description: string;
  ownerUserId: string;
  mainAgentId: string | null;
  autoDispatchEnabled: boolean;
};

export type CreateConversationInput = {
  workspaceId: string;
  id?: string;
  workspaceContextId?: string | null;
  agentId: string;
  avatar?: string | null;
  status?: Conversation["status"];
  lastMessageAt?: string | null;
  title: string;
  mode: ConversationMode;
  provider?: RuntimeProvider | null;
  type?: import("./groupChat").ConversationType;
  description?: string;
  ownerUserId?: string;
  mainAgentId?: string | null;
  autoDispatchEnabled?: boolean;
};

export type CreateWorkspaceOutput = {
  workspace: Workspace;
  mainAgent: Agent;
  mainConversation: Conversation;
};

export type UpdateConversationInput = Partial<
  Pick<
    Conversation,
    | "title"
    | "description"
    | "mode"
    | "workspaceContextId"
    | "avatar"
    | "status"
    | "autoDispatchEnabled"
    | "lastMessageAt"
  >
>;

export type MessageType =
  | "text"
  | "code"
  | "diff_card"
  | "file_card"
  | "preview_card"
  | "deploy_status"
  | "agent_status"
  | "dispatch_plan"
  | "agent_assignment"
  | "orchestrator_summary";

export type MessageSenderType = "user" | "agent" | "system";

export type LegacyMessageType = "agent_config_card";

export type TextMessageContent = {
  text: string;
};

export type CodeMessageContent = {
  language: string;
  code: string;
  filePath?: string;
};

export type AgentStatusCardContent = {
  agentId: string;
  status: AgentStatus;
  title: string;
  detail?: string;
};

export type AgentRunLog = {
  id: string;
  workspaceId: string;
  agentId: string;
  conversationId: string;
  provider: RuntimeProvider;
  cwd: string;
  status: "started" | "running" | "exited" | "error";
  stdout?: string;
  stderr?: string;
  exitCode?: number;
  createdAt: string;
};

export type Message = {
  id: string;
  workspaceId: string;
  conversationId: string;
  senderType: MessageSenderType;
  senderId: string;
  messageType: MessageType | LegacyMessageType;
  content: unknown;
  createdAt: string;
  status?: import("./groupChat").MessageStatus;
  mentionAgentIds?: string[] | null;
  dispatchRunId?: string | null;
  dispatchStepId?: string | null;
  replyToMessageId?: string | null;
  updatedAt?: string | null;
  metadata?: Record<string, unknown> | null;
  /**
   * 思考过程正文。模型把 `<think>...</think>` 块以普通文本形式塞进 SSE 流时，
   * streamingRunService 会把块内文字剥到这里，块外继续写到 content_markdown。
   * 渲染层应只在折叠块里展示，不混入正文。
   */
  thinking?: string | null;
};

export type CreateMessageInput = {
  workspaceId: string;
  conversationId: string;
  senderType: MessageSenderType;
  senderId: string;
  messageType: MessageType;
  content: unknown;
  status?: import("./groupChat").MessageStatus;
  mentionAgentIds?: string[] | null;
  dispatchRunId?: string | null;
  dispatchStepId?: string | null;
  replyToMessageId?: string | null;
  metadata?: Record<string, unknown> | null;
};

export type RunAgentInput = {
  workspaceId: string;
  conversationId: string;
  agentId: string;
  userMessage: string;
  userMessageId?: string;
  metaPrompt?: string;
  resume?: boolean;
};

export type RunAgentOutput = {
  agent: Agent | null;
  status: AgentStatus;
  messages: Message[];
  diffProposal?: DiffProposal;
  diffProposals?: DiffProposal[];
  artifacts?: Artifact[];
  runLog?: AgentRunLog;
  conversationId?: string;
  usedFallback?: boolean;
  runResult?: AgentRunResult;
};

export type RunAgentResult = RunAgentOutput;

export type RunAgentStreamEvent = {
  type: "text_delta";
  workspaceId: string;
  conversationId: string;
  agentId: string;
  text: string;
  usedFallback?: boolean;
} | {
  type: "thinking_delta";
  workspaceId: string;
  conversationId: string;
  agentId: string;
  text: string;
};

export type CreateSubAgentManuallyInput = {
  /** Legacy compatibility owner. Omit when creating a global Agent contact. */
  workspaceId?: string;
  provider: RuntimeProvider;
  name: string;
  description?: string;
  skillIds?: string[];
};

export type UpdateAgentProfileInput = {
  agentId: string;
  name?: string;
  description?: string;
  avatar?: string;
  skillIds?: string[];
};

export type UpdateAgentDefaultWorkspaceInput = {
  agentId: string;
  rootPath: string;
  gitEnabled?: boolean;
};

export type CreateSubAgentManuallyOutput = {
  agent: Agent;
  conversation: Conversation;
};

export type DeleteAgentInput = {
  agentId: string;
  deleteDefaultWorkspaceDirectory?: boolean;
  preserveGroupHistory?: boolean;
};

export type DeleteAgentResult = {
  agentId: string;
  deletedConversationIds: string[];
  trashedWorkspaceDirectory?: string;
  warning?: string;
};

export type {
  ApplyDiffInput,
  ApplyDiffResult,
  CreateDiffProposalInput,
  DiffCardContent,
  DiffProposal,
  DiffProposalStatus,
  RejectDiffInput,
  UpdateDiffProposalInput
} from "./diff";

export type {
  Artifact,
  ArtifactTabState,
  ArtifactType,
  CreateArtifactInput,
  CreateArtifactDiffInput,
  UpdateArtifactContentInput,
  UpdateArtifactInput
} from "./artifact";

export type {
  AcceptanceCriterion,
  AddGroupMemberInput,
  AgentAssignment,
  ConversationMember,
  ConversationMemberRole,
  ConversationMemberStatus,
  ConversationMemberType,
  ConversationType,
  CreateGroupConversationInput,
  CreateGroupConversationOutput,
  DispatchMode,
  DispatchPlan,
  DispatchPlanStep,
  DispatchRun,
  DispatchRunStatus,
  DispatchStep,
  DispatchStepStatus,
  GroupMemberWithAgent,
  GroupRunStatus,
  MainAgentDiffReviewOutput,
  MessageStatus,
  OrchestratorReview,
  RemoveGroupMemberInput,
  RetryDispatchStepInput,
  RetryDispatchStepOutput,
  SendGroupMessageInput,
  SendGroupMessageOutput,
  SubAgentResult,
  SubAgentRunStatus
} from "./groupChat";

export type {
  AgentExecutionMode,
  AgentRunOptions,
  AgentRunResult
} from "./agentExecution";

export type {
  AgentRunInput as AgentAdapterRunInput,
  AgentEvent as AgentAdapterEvent,
  AgentAdapter
} from "./agentAdapter";

export {
  ConversationNotFoundError,
  ProviderMismatchError,
  ConversationAlreadyRunningError,
  ProviderSessionMissingError,
  ResumeFailedError,
  FallbackRebuildFailedError
} from "./agentAdapter";
