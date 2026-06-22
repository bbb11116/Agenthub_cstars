export const AGENT_EXECUTION_LIMITS = {
  singleChatMaxIterations: 40,
  groupSubagentMaxIterations: 15,
  groupMaxRedispatchRounds: 3,
  groupMaxAgentsPerRound: 3,
  orchestratorReviewMaxIterations: 5
} as const;

export type AgentExecutionMode =
  | "single_chat"
  | "group_subagent"
  | "orchestrator_review";

export type AgentRunOptions = {
  mode: AgentExecutionMode;
  maxIterations: number;
  conversationId: string;
  agentId: string;
  workspaceRoot: string;
  prompt: string;
  structuredOutput?: boolean;
  disableStream?: boolean;
};

export type AgentArtifactTarget = {
  workspaceId: string;
  conversationId: string;
  workspaceRootPath?: string;
  workspaceContextId?: string | null;
  dispatchRunId?: string;
  dispatchStepId?: string;
};

export type AgentRunResult = {
  status:
    | "completed"
    | "failed"
    | "cancelled"
    | "waiting_for_permission"
    | "iteration_limit_reached"
    | "verification_failed";
  finalMessage?: string;
  structuredResult?: unknown;
  diffProposalId?: string;
  error?: string;
  iterationsUsed?: number;
};
