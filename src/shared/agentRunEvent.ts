/**
 * AgentRunEvent is the unified event protocol that the Agent runtime emits.
 *
 * Goals:
 *  - Every agent runtime (OpenAI-compatible, Anthropic-compatible, Claude Code CLI,
 *    Codex CLI) produces the same wire format.
 *  - Frontend never reads provider-specific event shapes; it only reads AgentRunEvent.
 *  - The runtime persists each event so a fresh page load can replay the full
 *    assistant response from the database alone.
 *  - Markdown body is delivered as small text deltas; tools, diffs, command
 *    results, file references, artifact previews, and errors ride on structured
 *    payloads.
 */

import type { ArtifactPreviewPayload, ArtifactRenderChangedPayload } from "./artifact";
import type { AgentArtifactTarget, AgentExecutionMode } from "./agentExecution";
import type { RuntimeProvider } from "./runtime";

export type AgentRunEventType =
  | "run.started"
  | "message.started"
  | "message.delta"
  | "message.thinking_delta"
  | "message.completed"
  | "tool.call.started"
  | "tool.call.completed"
  | "tool.result"
  | "diff.proposal"
  | "artifact.created"
  | "artifact.rendered"
  | "command.result"
  | "file.reference"
  | "run.completed"
  | "run.failed";

export type AgentRunEventBase = {
  id: string;
  runId: string;
  conversationId: string;
  seq: number;
  type: AgentRunEventType;
  createdAt: string;
};

export type MessageDeltaPayload = {
  messageId: string;
  /** Markdown text increment. Never an object — a plain UTF-8 string. */
  delta: string;
};

export type MessageThinkingDeltaPayload = {
  messageId: string;
  /** Reasoning / thinking text increment. Stored in messages.thinking_markdown. */
  delta: string;
};

export type ToolCallStartedPayload = {
  toolCallId: string;
  messageId: string;
  name: string;
  /** Optional structured arguments as the LLM emitted them. */
  arguments: Record<string, unknown> | null;
};

export type ToolCallCompletedPayload = {
  toolCallId: string;
  messageId: string;
  name: string;
  arguments: Record<string, unknown> | null;
  /** True if the call ended without an error. */
  ok: boolean;
};

export type ToolResultPayload = {
  toolCallId: string;
  messageId: string;
  name: string;
  /** Free-form structured result returned to the model by the tool runtime. */
  result: unknown;
  ok: boolean;
  errorMessage?: string;
};

export type DiffProposalFileStatus = "added" | "modified" | "deleted" | "renamed";

export type DiffProposalFile = {
  path: string;
  status: DiffProposalFileStatus;
  /** Unified diff content for the file. */
  unifiedDiff: string;
};

export type DiffProposalPayload = {
  proposalId: string;
  messageId: string;
  files: DiffProposalFile[];
};

export type CommandResultPayload = {
  messageId: string;
  command: string;
  exitCode: number | null;
  stdout: string;
  stderr: string;
};

export type FileReferencePayload = {
  messageId: string;
  path: string;
  /** Optional line range like "12-30". */
  range?: string;
  reason?: string;
};

export type ErrorPayload = {
  messageId: string | null;
  message: string;
  code?: string;
};

export type AgentRunEvent =
  | (AgentRunEventBase & { type: "run.started"; payload?: undefined })
  | (AgentRunEventBase & { type: "message.started"; payload: { messageId: string } })
  | (AgentRunEventBase & { type: "message.delta"; payload: MessageDeltaPayload })
  | (AgentRunEventBase & { type: "message.thinking_delta"; payload: MessageThinkingDeltaPayload })
  | (AgentRunEventBase & { type: "message.completed"; payload: { messageId: string } })
  | (AgentRunEventBase & { type: "tool.call.started"; payload: ToolCallStartedPayload })
  | (AgentRunEventBase & { type: "tool.call.completed"; payload: ToolCallCompletedPayload })
  | (AgentRunEventBase & { type: "tool.result"; payload: ToolResultPayload })
  | (AgentRunEventBase & { type: "diff.proposal"; payload: DiffProposalPayload })
  | (AgentRunEventBase & { type: "artifact.created"; payload: ArtifactPreviewPayload })
  | (AgentRunEventBase & { type: "artifact.rendered"; payload: ArtifactRenderChangedPayload })
  | (AgentRunEventBase & { type: "command.result"; payload: CommandResultPayload })
  | (AgentRunEventBase & { type: "file.reference"; payload: FileReferencePayload })
  | (AgentRunEventBase & {
      type: "run.completed";
      payload: { messageId: string | null; status: "completed" | "cancelled" };
    })
  | (AgentRunEventBase & {
      type: "run.failed";
      payload: ErrorPayload;
    });

export type MessageArtifactType =
  | "tool_call"
  | "tool_result"
  | "diff_proposal"
  | "artifact_preview"
  | "command_result"
  | "file_reference"
  | "error";

export type MessageArtifact<TPayload = unknown> = {
  id: string;
  messageId: string;
  conversationId: string;
  type: MessageArtifactType;
  payload: TPayload;
  createdAt: string;
};

export type ConversationRunStatus = "running" | "completed" | "failed" | "cancelled";

export type ConversationRun = {
  id: string;
  conversationId: string;
  agentId: string;
  status: ConversationRunStatus;
  startedAt: string;
  endedAt: string | null;
  errorMessage: string | null;
};

/**
 * Adapter contract that every provider must satisfy. Built-in HTTP adapters
 * (OpenAI / Anthropic) and CLI adapters (claude_code / codex_local) all
 * expose the same shape. The streaming run service consumes this directly.
 */
export interface AgentProviderAdapter {
  run(input: AgentProviderRunInput): AsyncIterable<AgentRunEvent>;
  cancel?(runId: string): Promise<void>;
}

export type AgentProviderRunInput = {
  runId: string;
  workspaceId?: string;
  conversationId: string;
  agentId: string;
  provider?: RuntimeProvider;
  rootPath?: string;
  systemPrompt: string;
  userMessage: string;
  contextMessages?: Array<{
    role: "user" | "assistant" | "system" | "agent";
    content: string;
  }>;
  artifactTarget?: AgentArtifactTarget;
  executionMode?: AgentExecutionMode;
  toolPermissions?: string[];
  /**
   * If true, the adapter may attempt to resume a prior provider session.
   * If false or the session is gone, the runtime rebuilds context from history.
   */
  resume: {
    enabled: boolean;
    providerSessionId?: string;
  };
  /** Maximum ReAct-like iterations the adapter may use. */
  maxIterations: number;
  /** Abort signal that the streaming service can fire to cancel the run. */
  abortSignal?: AbortSignal;
};
