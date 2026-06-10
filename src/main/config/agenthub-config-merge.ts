import type {
  GlobalSettings,
  WorkspaceSettings,
  WorkspaceLocalSettings,
  MergedConfig,
  ResolvedConfig,
  ModelProviderConfig
} from "./agenthub-config-schema";
import { AGENT_EXECUTION_LIMITS } from "../../shared/agentExecution";

const DEFAULT_GROUP_CHAT = {
  executionMode: "sequential" as const,
  maxRecentMessages: 20,
  mainAgentCanWriteFiles: false,
  continueOnAgentFailure: true,
  subagentMaxIterations: AGENT_EXECUTION_LIMITS.groupSubagentMaxIterations,
  maxRedispatchRounds: AGENT_EXECUTION_LIMITS.groupMaxRedispatchRounds,
  maxAgentsPerRound: AGENT_EXECUTION_LIMITS.groupMaxAgentsPerRound,
  orchestratorReviewMaxIterations:
    AGENT_EXECUTION_LIMITS.orchestratorReviewMaxIterations
};

const DEFAULT_AGENT_DEFAULTS = {
  provider: "codex_local" as const,
  tools: ["read_file", "write_diff", "preview_artifact"],
  requireDiffProposal: false,
  requireUserConfirmBeforeApply: false
};

function mergeModelProviders(
  globalProviders: ModelProviderConfig[],
  localOverrides: WorkspaceLocalSettings["modelProviderOverrides"]
): ModelProviderConfig[] {
  if (!localOverrides || localOverrides.length === 0) {
    return globalProviders;
  }

  const overrideMap = new Map(localOverrides.map((o) => [o.id, o]));
  const merged: ModelProviderConfig[] = [];

  for (const provider of globalProviders) {
    const override = overrideMap.get(provider.id);
    if (override) {
      merged.push({
        ...provider,
        ...override,
        id: provider.id
      });
    } else {
      merged.push(provider);
    }
  }

  return merged;
}

export function mergeResolvedConfig(
  global: GlobalSettings,
  workspace: WorkspaceSettings,
  local: WorkspaceLocalSettings
): MergedConfig {
  const modelProviders = mergeModelProviders(
    global.modelProviders ?? [],
    local.modelProviderOverrides
  );

  return {
    modelProviders,
    mainAgent: workspace.mainAgent ?? {},
    groupChat: { ...DEFAULT_GROUP_CHAT, ...workspace.groupChat },
    agentDefaults: { ...DEFAULT_AGENT_DEFAULTS, ...workspace.agentDefaults }
  };
}

export function buildResolvedConfig(
  global: GlobalSettings,
  workspace: WorkspaceSettings,
  local: WorkspaceLocalSettings
): ResolvedConfig {
  return {
    global,
    workspace,
    local,
    merged: mergeResolvedConfig(global, workspace, local)
  };
}
