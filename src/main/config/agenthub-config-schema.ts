import type { RuntimeProvider } from "../../shared/runtime";
import type {
  ModelProviderApiFormat,
  ModelProviderLimits,
  ProviderCapabilities
} from "../../shared/modelProvider";

export type ModelProviderConfig = {
  id: string;
  name: string;
  apiFormat: ModelProviderApiFormat;
  baseUrl: string;
  isFullUrl: boolean;
  model: string;
  apiKeyRef: string;
  supportsVision: boolean;
  supportsStreaming: boolean;
  capabilities?: ProviderCapabilities;
  isDefaultForMainAgent: boolean;
  limits: ModelProviderLimits;
  createdAt: string;
  updatedAt: string;
};

export type MainAgentConfig = {
  name?: string;
  type?: "orchestrator";
  modelProviderId?: string;
  model?: string;
  systemPromptPath?: string;
};

export type GroupChatConfig = {
  executionMode?: "sequential";
  maxRecentMessages?: number;
  mainAgentCanWriteFiles?: boolean;
  continueOnAgentFailure?: boolean;
  subagentMaxIterations?: number;
  maxRedispatchRounds?: number;
  maxAgentsPerRound?: number;
  orchestratorReviewMaxIterations?: number;
  debugDisableStreamForSubAgent?: boolean;
};

export type AgentDefaultsConfig = {
  provider?: RuntimeProvider;
  tools?: string[];
  requireDiffProposal?: boolean;
  requireUserConfirmBeforeApply?: boolean;
};

export type GlobalSettings = {
  version: 1;
  modelProviders?: ModelProviderConfig[];
  defaults?: {
    mainAgentProviderId?: string;
    specialistProvider?: RuntimeProvider;
  };
};

export type WorkspaceSettings = {
  version: 1;
  workspace?: {
    name?: string;
    autoAnalyzeOnOpen?: boolean;
  };
  mainAgent?: MainAgentConfig;
  groupChat?: GroupChatConfig;
  agentDefaults?: AgentDefaultsConfig;
};

export type WorkspaceLocalSettings = {
  modelProviderOverrides?: Array<
    Pick<ModelProviderConfig, "id"> & Partial<Omit<ModelProviderConfig, "id">>
  >;
  providerEnvOverrides?: Record<string, Record<string, string>>;
};

export type AgentFileDefinition = {
  version: 1;
  name: string;
  type: "specialist";
  provider: RuntimeProvider;
  description?: string;
  systemPromptPath?: string;
  systemPrompt?: string;
  tools: string[];
  capabilityTags?: string[];
  requireDiffProposal?: boolean;
};

export type MergedConfig = {
  modelProviders: ModelProviderConfig[];
  mainAgent: MainAgentConfig;
  groupChat: GroupChatConfig;
  agentDefaults: AgentDefaultsConfig;
};

export type ResolvedConfig = {
  global: GlobalSettings;
  workspace: WorkspaceSettings;
  local: WorkspaceLocalSettings;
  merged: MergedConfig;
};
