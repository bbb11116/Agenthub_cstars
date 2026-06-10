import type {
  Agent,
  Conversation,
  CreateSubAgentManuallyInput,
  CreateSubAgentManuallyOutput,
  DeleteAgentInput,
  DeleteAgentResult,
  CreateMessageInput,
  CreateWorkspaceOutput,
  CreateWorkspaceInput,
  Message,
  PreparedWorkspaceCreate,
  PrepareCreateWorkspaceInput,
  RunAgentInput,
  RunAgentOutput,
  RunAgentStreamEvent,
  RuntimeProvider,
  RuntimeStatus,
  UpdateAgentStatusInput,
  UpdateAgentDefaultWorkspaceInput,
  UpdateAgentProfileInput,
  WorkspaceContext,
  Workspace
} from "./domain";
import type { AgentRunEvent, MessageArtifact } from "./agentRunEvent";
import type {
  Artifact,
  ArtifactRenderChangedPayload,
  CreateArtifactDiffInput,
  CreateArtifactInput,
  PreviewArtifactInput,
  UpdateArtifactContentInput
} from "./artifact";
import type {
  ApplyDiffInput,
  ApplyDiffResult,
  CreateDiffProposalInput,
  DiffProposal,
  RejectDiffInput
} from "./diff";
import type {
  FileContent,
  FileTreeNode,
  ReadFileInput,
  ReadFileTreeInput
} from "./file";
import type {
  GitDiff,
  GitStatus,
  ReadGitDiffInput,
  ReadGitStatusInput
} from "./git";
import type {
  AddGroupMemberInput,
  AddGroupMembersInput,
  AddGroupMembersResult,
  ConversationMember,
  CreateGroupConversationInput,
  CreateGroupConversationOutput,
  DispatchGroupTasksInput,
  DispatchGroupTasksOutput,
  GroupRunEvent,
  DispatchRun,
  DispatchRunStreamEvent,
  DispatchStep,
  GroupAgentInfo,
  GroupMemberWithAgent,
  RemoveGroupMemberInput,
  RetryDispatchStepInput,
  RetryDispatchStepOutput,
  SendGroupMessageInput,
  SendGroupMessageOutput,
  UpdateGroupProfileInput,
  UpdateGroupWorkspaceInput
} from "./groupChat";
import type {
  ContextUsage,
  ModelProviderApiFormat,
  ModelProviderLimits,
  ProviderCapabilities
} from "./modelProvider";

export type GroupProfileDto = {
  conversation: {
    id: string;
    title: string;
    avatar: string | null;
    description: string;
    autoDispatchEnabled: boolean;
    type: "group";
    createdAt: string;
    updatedAt: string;
    lastMessageAt: string | null;
  };
  workspaceContext: {
    id: string;
    rootPath: string;
    gitEnabled: boolean;
  } | null;
  mainAgent: {
    id: string;
    name: string;
    avatar: string | null;
    description: string | null;
    role: string;
    type: string;
    status: string;
    runtimeProvider: string;
    model: string | null;
  } | null;
  members: Array<{
    memberId: string;
    memberType: "user" | "agent";
    memberRefId: string;
    name: string;
    avatar: string | null;
    role: "owner" | "main_agent" | "member";
    joinedAt: string;
  }>;
  memberCount: number;
  projectExperiences: Array<{
    agentId: string;
    agentName: string;
    summary: string;
    responsibilities: string[];
    keyDecisions: string[];
    filesTouched: string[];
    diffSummaries: string[];
    unresolvedIssues: string[];
    updatedAt: string;
  }>;
  recentDispatches: Array<{
    runId: string;
    status: string;
    createdAt: string;
    finishedAt: string | null;
  }>;
};

export type AgentProfileDto = {
  agent: {
    id: string;
    name: string;
    avatar?: string | null;
    description?: string | null;
    capabilities?: string[];
    skillIds?: string[];
    role: string;
    type?: string | null;
    runtimeProvider?: string | null;
    modelProviderId?: string | null;
    model?: string | null;
    status?: string | null;
    createdAt?: string | null;
    updatedAt?: string | null;
  };
  skills: AgentSkillSummary[];
  defaultWorkspaceContext?: {
    id: string;
    rootPath: string;
    gitEnabled?: boolean;
  } | null;
  tools: {
    readFile?: boolean;
    writeDiff?: boolean;
    applyDiff?: boolean;
    previewArtifact?: boolean;
    gitStatus?: boolean;
    [key: string]: unknown;
  };
  groups: Array<{
    conversationId: string;
    name: string;
    avatar?: string | null;
    description?: string | null;
    memberCount: number;
    lastMessageAt?: string | null;
    workspaceContext?: {
      id: string;
      rootPath: string;
    } | null;
  }>;
  projectExperiences: Array<{
    groupConversationId: string;
    groupName: string;
    summary: string;
    responsibilities: string[];
    keyDecisions: string[];
    filesTouched: string[];
    diffSummaries: string[];
    unresolvedIssues: string[];
    updatedAt?: string | null;
  }>;
};

export type AgentSkillSummary = {
  id: string;
  category: string;
  name: string;
  description: string;
};

export type AgentSkillDetail = AgentSkillSummary & {
  content: string;
};

export type AgentSkillCategory = {
  name: string;
  skills: AgentSkillSummary[];
};

export type ID = string;
export type Timestamp = string;

export interface WorkspaceApi {
  selectFolder: () => Promise<string | null>;
  prepareCreate: (input: PrepareCreateWorkspaceInput) => Promise<PreparedWorkspaceCreate>;
  create: (input: CreateWorkspaceInput) => Promise<CreateWorkspaceOutput>;
  delete: (workspaceId: string) => Promise<boolean>;
  list: () => Promise<Workspace[]>;
}

export interface AgentApi {
  listByWorkspace: (workspaceId: string) => Promise<Agent[]>;
  listContacts: () => Promise<Agent[]>;
  ensureDefaultMainAgent: () => Promise<Agent>;
  createSubAgentManually: (
    input: CreateSubAgentManuallyInput
  ) => Promise<CreateSubAgentManuallyOutput>;
  delete: (input: DeleteAgentInput) => Promise<DeleteAgentResult>;
  updateStatus: (input: UpdateAgentStatusInput) => Promise<Agent | null>;
  updateProfile: (input: UpdateAgentProfileInput) => Promise<Agent | null>;
  updateDefaultWorkspace: (input: UpdateAgentDefaultWorkspaceInput) => Promise<Agent | null>;
  getStatus: (agentId: string) => Promise<Agent["status"] | null>;
  run: (
    input: RunAgentInput,
    streamHandlers?: RunAgentStreamHandlers
  ) => Promise<RunAgentOutput>;
  runWithConversation: (
    input: RunWithConversationApiInput,
    streamHandlers?: RunAgentStreamHandlers
  ) => Promise<RunAgentOutput & { conversationId: string; usedFallback?: boolean }>;
  runWithConversationUnified: (
    input: RunWithConversationUnifiedApiInput,
    streamHandlers?: RunAgentUnifiedStreamHandlers
  ) => Promise<RunWithConversationUnifiedApiOutput>;
  getAgentProfile: (agentId: string) => Promise<AgentProfileDto>;
}

export interface SkillApi {
  listCatalog: () => Promise<AgentSkillCategory[]>;
  get: (skillId: string) => Promise<AgentSkillDetail | null>;
}

export interface AgentRunApi {
  listEvents: (conversationId: string) => Promise<AgentRunEvent[]>;
}

export type RunWithConversationApiInput = {
  workspaceId: string;
  agentId: string;
  conversationId?: string;
  message: string;
  resume?: boolean;
};

export type RunWithConversationUnifiedApiInput = {
  workspaceId: string;
  agentId: string;
  conversationId?: string;
  message: string;
  resume?: boolean;
};

export type RunWithConversationUnifiedApiOutput = {
  conversationId: string;
  runId: string;
  assistantMessageId: string;
  status: "completed" | "failed" | "cancelled";
  errorMessage?: string;
  agentId: string;
};

export type MessageWithArtifacts = Message & {
  artifacts: MessageArtifact[];
};

export type RunAgentStreamHandlers = {
  onTextDelta?: (event: RunAgentStreamEvent) => void;
  onThinkingDelta?: (event: RunAgentStreamEvent) => void;
};

export type RunAgentUnifiedStreamHandlers = {
  onEvent?: (event: AgentRunEvent) => void;
};

export interface RuntimeApi {
  checkAll: () => Promise<RuntimeStatus[]>;
  check: (provider: RuntimeProvider) => Promise<RuntimeStatus>;
}

export interface ConversationApi {
  listByAgent: (agentId: string) => Promise<Conversation[]>;
  listChats: () => Promise<Conversation[]>;
  resolveWorkspaceContext: (conversationId: string) => Promise<WorkspaceContext>;
  findOrCreateDirectConversationForAgent: (agentId: string) => Promise<Conversation>;
  createDirectConversationForAgent: (agentId: string) => Promise<Conversation>;
  delete: (conversationId: string) => Promise<boolean>;
}

export interface MessageApi {
  list: (conversationId: string) => Promise<Message[]>;
  listWithArtifacts: (conversationId: string) => Promise<MessageWithArtifacts[]>;
  create: (input: CreateMessageInput) => Promise<Message>;
}

export type WorkspaceTreeDTO = {
  workspace: Workspace;
  agents: Array<{
    agent: Agent;
    conversations: Conversation[];
  }>;
};

export interface NavigationApi {
  getTree: () => Promise<WorkspaceTreeDTO[]>;
}

export interface FileApi {
  tree: (input: ReadFileTreeInput) => Promise<FileTreeNode[]>;
  read: (input: ReadFileInput) => Promise<FileContent>;
}

export interface DiffApi {
  createProposal: (input: CreateDiffProposalInput) => Promise<DiffProposal>;
  get: (diffProposalId: string) => Promise<DiffProposal>;
  listByWorkspace: (workspaceId: string) => Promise<DiffProposal[]>;
  apply: (input: ApplyDiffInput) => Promise<ApplyDiffResult>;
  reject: (input: RejectDiffInput) => Promise<DiffProposal>;
}

export interface ArtifactApi {
  create: (input: CreateArtifactInput) => Promise<Artifact>;
  listByWorkspace: (workspaceId: string) => Promise<Artifact[]>;
  get: (input: string | PreviewArtifactInput) => Promise<Artifact>;
  render: (artifactId: string) => Promise<Artifact>;
  updateContent: (input: UpdateArtifactContentInput) => Promise<Artifact>;
  createDiff: (input: CreateArtifactDiffInput) => Promise<DiffProposal>;
  onRenderChanged: (
    handler: (payload: ArtifactRenderChangedPayload) => void
  ) => () => void;
}

export interface GitApi {
  status: (input: ReadGitStatusInput) => Promise<GitStatus>;
  diff: (input: ReadGitDiffInput) => Promise<GitDiff>;
}

export type DispatchStreamHandlers = {
  onStepUpdate?: (event: DispatchRunStreamEvent) => void;
};

export interface GroupConversationApi {
  create: (input: CreateGroupConversationInput) => Promise<CreateGroupConversationOutput>;
  listByWorkspace: (workspaceId: string) => Promise<Conversation[]>;
  list: () => Promise<Conversation[]>;
  listGroupAgents: (conversationId: string) => Promise<GroupAgentInfo[]>;
  listAvailableAgents: (conversationId: string) => Promise<Agent[]>;
  updateProfile: (input: UpdateGroupProfileInput) => Promise<Conversation>;
  updateWorkspace: (input: UpdateGroupWorkspaceInput) => Promise<Conversation>;
  getGroupProfile: (conversationId: string) => Promise<GroupProfileDto>;
  delete: (conversationId: string) => Promise<boolean>;
}

export interface GroupMemberApi {
  add: (input: AddGroupMemberInput) => Promise<ConversationMember>;
  addMany: (input: AddGroupMembersInput) => Promise<AddGroupMembersResult>;
  remove: (input: RemoveGroupMemberInput) => Promise<boolean>;
  list: (conversationId: string) => Promise<GroupMemberWithAgent[]>;
}

export interface GroupMessageApi {
  send: (
    input: SendGroupMessageInput,
    streamHandlers?: DispatchStreamHandlers
  ) => Promise<SendGroupMessageOutput>;
  dispatchGroupTasks: (
    input: DispatchGroupTasksInput,
    streamHandlers?: DispatchStreamHandlers
  ) => Promise<DispatchGroupTasksOutput>;
}

export interface DispatchApi {
  getRun: (runId: string) => Promise<DispatchRun | null>;
  listRuns: (conversationId: string) => Promise<DispatchRun[]>;
  listEvents: (conversationId: string) => Promise<GroupRunEvent[]>;
  retryStep: (
    input: RetryDispatchStepInput,
    streamHandlers?: DispatchStreamHandlers
  ) => Promise<RetryDispatchStepOutput>;
}

export type TestConnectionResult = {
  ok: boolean;
  errorType?: "UNAUTHORIZED" | "NOT_FOUND" | "BAD_REQUEST" | "RATE_LIMITED" | "NETWORK_ERROR" | "RESPONSE_FORMAT_MISMATCH" | "UNKNOWN_ERROR";
  error?: string;
  latencyMs?: number;
  model?: string;
  capabilities?: ProviderCapabilities;
  warnings?: string[];
};

export type SaveModelProviderInput = {
  id?: string;
  name: string;
  apiFormat: ModelProviderApiFormat;
  baseUrl: string;
  isFullUrl: boolean;
  model: string;
  apiKey?: string;
  supportsVision: boolean;
  supportsStreaming: boolean;
  capabilities?: ProviderCapabilities;
  isDefaultForMainAgent: boolean;
  enableOneMillionContext: boolean;
};

export type ModelProviderListItem = {
  id: string;
  name: string;
  apiFormat: ModelProviderApiFormat;
  baseUrl: string;
  isFullUrl: boolean;
  model: string;
  supportsVision: boolean;
  supportsStreaming: boolean;
  capabilities: ProviderCapabilities;
  isDefaultForMainAgent: boolean;
  limits: ModelProviderLimits;
  hasApiKey: boolean;
  createdAt: string;
  updatedAt: string;
};

export interface ModelProviderApi {
  list: () => Promise<ModelProviderListItem[]>;
  get: (id: string) => Promise<ModelProviderListItem | null>;
  save: (input: SaveModelProviderInput) => Promise<ModelProviderListItem>;
  delete: (id: string) => Promise<boolean>;
  testConnection: (input: SaveModelProviderInput) => Promise<TestConnectionResult>;
  hasAnyProvider: () => Promise<boolean>;
  getContextUsage: (input: {
    workspaceId: string;
    conversationId: string;
  }) => Promise<ContextUsage>;
}

export interface AgentHubApi {
  ping: () => Promise<string>;
  workspace: WorkspaceApi;
  agent: AgentApi;
  skill: SkillApi;
  agentRun: AgentRunApi;
  runtime: RuntimeApi;
  conversation: ConversationApi;
  message: MessageApi;
  navigation: NavigationApi;
  file: FileApi;
  artifact: ArtifactApi;
  diff: DiffApi;
  git: GitApi;
  groupConversation: GroupConversationApi;
  groupMember: GroupMemberApi;
  groupMessage: GroupMessageApi;
  dispatch: DispatchApi;
  modelProvider: ModelProviderApi;
}
