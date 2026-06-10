import type { RuntimeProvider } from "./runtime";
import type { ClaudeCodeConfig } from "./domain";
import type { AgentRunOptions } from "./agentExecution";

export type AgentRunInput = {
  workspaceId: string;
  conversationId: string;
  agentId: string;
  provider: RuntimeProvider;
  rootPath: string;
  systemPrompt: string;
  userMessage: string;
  contextMessages?: Array<{
    role: "user" | "assistant" | "system" | "agent";
    content: string;
    createdAt?: string;
  }>;
  toolPermissions: string[];
  claudeCodeConfig?: ClaudeCodeConfig;
  env?: Record<string, string>;
  runOptions: AgentRunOptions;
  resume: {
    enabled: boolean;
    providerSessionId?: string;
    fallbackRebuild?: boolean;
  };
};

export type AgentEvent =
  | {
      type: "status";
      status:
        | "running"
        | "completed"
        | "failed"
        | "cancelled"
        | "waiting_for_permission"
        | "iteration_limit_reached";
      iterationsUsed?: number;
    }
  | { type: "text_delta"; content: string }
  | { type: "reasoning_delta"; content: string }
  | { type: "provider_session"; providerSessionId: string }
  | { type: "diff_proposal"; proposal: unknown }
  | { type: "structured_result"; result: unknown }
  | { type: "error"; message: string };

export interface AgentAdapter {
  run(input: AgentRunInput): AsyncIterable<AgentEvent>;
}

export class ConversationNotFoundError extends Error {
  constructor(conversationId: string) {
    super(`Conversation not found: ${conversationId}`);
    this.name = "ConversationNotFoundError";
  }
}

export class ProviderMismatchError extends Error {
  constructor(expected: RuntimeProvider, actual: RuntimeProvider) {
    super(
      `Provider mismatch: conversation is bound to ${expected}, but agent uses ${actual}`
    );
    this.name = "ProviderMismatchError";
  }
}

export class ConversationAlreadyRunningError extends Error {
  constructor(conversationId: string) {
    super(`Conversation ${conversationId} is already running`);
    this.name = "ConversationAlreadyRunningError";
  }
}

export class ProviderSessionMissingError extends Error {
  constructor(conversationId: string) {
    super(`No active provider session for conversation ${conversationId}`);
    this.name = "ProviderSessionMissingError";
  }
}

export class ResumeFailedError extends Error {
  constructor(reason: string) {
    super(`Resume failed: ${reason}`);
    this.name = "ResumeFailedError";
  }
}

export class FallbackRebuildFailedError extends Error {
  constructor(reason: string) {
    super(`Fallback rebuild failed: ${reason}`);
    this.name = "FallbackRebuildFailedError";
  }
}
