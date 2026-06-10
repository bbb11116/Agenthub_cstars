import { randomUUID } from "node:crypto";
import type { Agent, Message, MessageType } from "../../shared/domain";
import type {
  AgentProviderAdapter,
  AgentProviderRunInput,
  AgentRunEvent,
  ErrorPayload,
  MessageArtifact
} from "../../shared/agentRunEvent";
import type { MessageArtifactType } from "../../shared/agentRunEvent";
import { getDatabase, type AgentHubDatabase } from "../db";
import { createMessage } from "./messageService";
import { createDiffProposal } from "./diffService";
import { createAgentRun as createAgentRunRecord, updateAgentRunStatus, updateAgentRunProviderSessionId, markAgentRunUsedFallback, getAgentRunById } from "../db/repositories/agentRunRepo";
import { insertAgentRunEvent, generateAgentRunEventId } from "../db/repositories/agentRunEventRepo";
import { appendMessageMarkdown, appendMessageThinking, updateMessageStatus } from "../db/repositories/messageRepo";
import { createMessageArtifact, getArtifactsByMessage } from "../db/repositories/messageArtifactRepo";
import { acquireConversationRun, markRunFailed } from "./conversationRunLock";
import { getUnifiedProviderAdapter } from "./adapters";
import { getActiveProviderSession, createProviderSession, markActiveSessionsAsReplaced, type ProviderSessionExecutionScope } from "../db/repositories/providerSessionRepo";
import type { RuntimeProvider } from "../../shared/runtime";
import { isBuiltinProvider } from "../../shared/runtime";
import { buildConversationContextForAgentRun, DEFAULT_CONTEXT_SAFETY_MARGIN_TOKENS } from "./conversationContextService";
import { loadMainAgentConfig } from "./configService";
import { DEFAULT_CONTEXT_WINDOW_TOKENS, DEFAULT_MAX_OUTPUT_TOKENS } from "../../shared/modelProvider";
import { ThinkBlockParser } from "./thinkBlockParser";

export type StreamingRunSink = (event: AgentRunEvent) => void;

export type StreamingRunInput = {
  workspaceId: string;
  agent: Agent;
  conversationId: string;
  rootPath: string;
  workspaceContextId: string | null;
  systemPrompt: string;
  userMessage: string;
  executionScope?: ProviderSessionExecutionScope;
  dispatchStepId?: string | null;
  maxIterations: number;
  resume?: boolean;
  /** When true, skip saving the user message (used by sub-agents that already saved it). */
  silent?: boolean;
  /**
   * Optional override for the provider adapter. If omitted, the adapter is
   * resolved from `agent.runtimeProvider`.
   */
  adapter?: AgentProviderAdapter | null;
};

export type StreamingRunResult = {
  runId: string;
  assistantMessageId: string;
  status: "completed" | "failed" | "cancelled";
  errorMessage?: string;
  artifacts: MessageArtifact[];
};

function formatToolPermissions(agent: Agent): string {
  return Object.entries({ ...agent.tools, applyDiff: false })
    .map(([tool, enabled]) => `${tool}=${enabled ? "true" : "false"}`)
    .join(", ");
}

/**
 * Run an agent with the unified event protocol.
 *
 *   1. Save the user message (unless `silent: true`).
 *   2. Create an assistant message with `status = 'streaming'`, empty body.
 *   3. Acquire the conversation-level run lock (throws on conflict).
 *   4. Iterate the provider adapter. For each `AgentRunEvent`:
 *      - Persist it to `agent_run_events` (idempotent on run_id+seq).
 *      - For `message.delta`, append to `messages.content_markdown`.
 *      - For `diff.proposal`/`tool.call.completed`/`tool.result`/
 *        `command.result`/`file.reference`/`run.failed` with an
 *        assistant-bound payload, persist to `message_artifacts`.
 *      - Forward to the optional `sink` for IPC streaming.
 *   5. On `run.completed`, mark the assistant message completed.
 *   6. On `run.failed`, mark the assistant message failed and persist an
 *      error artifact.
 *   7. Release the lock in `finally` regardless of outcome.
 */
export async function* runStreamingAgent(
  input: StreamingRunInput,
  db: AgentHubDatabase = getDatabase(),
  sink?: StreamingRunSink
): AsyncIterable<AgentRunEvent> {
  // 1. Save the user message (skip in silent mode).
  if (!input.silent) {
    createMessage(
      {
        workspaceId: input.workspaceId,
        conversationId: input.conversationId,
        senderType: "user",
        senderId: "local-user",
        messageType: "text",
        content: { text: input.userMessage }
      },
      db
    );
  }

  // 2. Create assistant message placeholder.
  const assistantMessage = createAssistantPlaceholder(
    {
      workspaceId: input.workspaceId,
      conversationId: input.conversationId,
      agentId: input.agent.id
    },
    db
  );

  // 3. Acquire run lock. This is the conversation-level lock — only one run
  //    per conversation may be in flight at a time.
  const runLock = acquireConversationRun({
    conversationId: input.conversationId,
    agentId: input.agent.id,
    db
  });

  // Create the agent_runs row for telemetry parity with the existing flow.
  const executionScope =
    input.executionScope ?? (input.dispatchStepId ? "group_subagent" : "direct");
  const agentRunRecord = createAgentRunRecord(
    {
      conversationId: input.conversationId,
      workspaceId: input.workspaceId,
      agentId: input.agent.id,
      provider: input.agent.runtimeProvider,
      rootPath: input.rootPath,
      workspaceContextId: input.workspaceContextId,
      executionScope,
      dispatchStepId: input.dispatchStepId ?? null,
      systemPromptSnapshot: input.systemPrompt,
      toolPermissionsSnapshot: "unified",
      mode: input.dispatchStepId ? "group_subagent" : "single_chat",
      maxIterations: input.maxIterations
    },
    db
  );

  const adapter =
    input.adapter ?? getUnifiedProviderAdapter(input.agent.runtimeProvider);
  if (!adapter) {
    const errorMessage = `No unified adapter for provider: ${input.agent.runtimeProvider}`;
    const failed = await finalizeFailure(
      {
        db,
        runLock,
        agentRunRecordId: agentRunRecord.id,
        assistantMessageId: assistantMessage.id,
        errorMessage,
        sink
      }
    );
    yield failed;
    return;
  }

  // Resolve resume parameters.
  let providerSessionId: string | undefined;
  let usedFallback = false;
  if (input.resume !== false) {
    const activeSession = getActiveProviderSession(
      input.conversationId,
      {
        agentId: input.agent.id,
        provider: input.agent.runtimeProvider,
        workspaceContextId: input.workspaceContextId,
        rootPath: input.rootPath,
        executionScope
      },
      db
    );
    if (activeSession) {
      providerSessionId = activeSession.providerSessionId;
    }
  }

  // Build adapter input.
  const adapterInput: AgentProviderRunInput = {
    runId: runLock.runId,
    workspaceId: input.workspaceId,
    conversationId: input.conversationId,
    agentId: input.agent.id,
    provider: input.agent.runtimeProvider,
    rootPath: input.rootPath,
    systemPrompt: input.systemPrompt,
    userMessage: input.userMessage,
    contextMessages: isBuiltinProvider(input.agent.runtimeProvider)
      ? getBuiltinContextMessages(
          input,
          db
        )
      : undefined,
    resume: {
      enabled: Boolean(providerSessionId) && input.resume !== false,
      providerSessionId
    },
    toolPermissions: [formatToolPermissions(input.agent)],
    maxIterations: input.maxIterations
  };

  // 4. Iterate the unified event stream.
  let status: "completed" | "failed" | "cancelled" = "completed";
  let errorMessage: string | undefined;
  let newProviderSessionId: string | undefined;

  try {
    const thinkParser = new ThinkBlockParser();

    for await (const event of adapter.run(adapterInput)) {
      // Persist the event first (idempotent on run_id+seq).
      insertAgentRunEvent(event, db);

      // Update content_markdown + thinking_markdown on the assistant message.
      // The raw delta from the provider may carry `<think>...</think>` inline
      // (DeepSeek R1 / Qwen3 style); strip the block and route the inner text
      // to thinking_markdown, the rest to content_markdown. The IPC sink only
      // sees the cleaned visible text so the renderer never has to deal with
      // the raw tags during streaming.
      let forwardedEvent = event;
      if (event.type === "message.thinking_delta") {
        appendMessageThinking(assistantMessage.id, event.payload.delta, db);
      } else if (event.type === "message.delta") {
        const split = thinkParser.feed(event.payload.delta);
        if (split.visible.length > 0) {
          appendMessageMarkdown(assistantMessage.id, split.visible, db);
        }
        if (split.thinking.length > 0) {
          appendMessageThinking(assistantMessage.id, split.thinking, db);
        }
        if (split.visible.length !== event.payload.delta.length) {
          forwardedEvent = {
            ...event,
            payload: { ...event.payload, delta: split.visible }
          };
        }
      }

      // Persist structured artifacts.
      if (event.type === "diff.proposal") {
        // Only persist if there is at least one file. Empty diffs are
        // explicitly forbidden by the system prompt.
        if (event.payload.files.length > 0) {
          createMessageArtifact(
            {
              messageId: assistantMessage.id,
              conversationId: input.conversationId,
              type: "diff_proposal",
              payload: event.payload
            },
            db
          );
          // Also create a diff_proposals row + diff_card message per file
          // so the renderer can show the Apply/Reject card.
          for (const file of event.payload.files) {
            try {
              await createDiffProposal(
                {
                  workspaceId: input.workspaceId,
                  agentId: input.agent.id,
                  conversationId: input.conversationId,
                  filePath: file.path,
                  unifiedDiff: file.unifiedDiff
                },
                db
              );
            } catch (error) {
              console.warn(
                `Failed to create diff proposal for ${file.path}:`,
                error
              );
            }
          }
        }
      } else if (event.type === "artifact.created") {
        createMessageArtifact(
          {
            messageId: assistantMessage.id,
            conversationId: input.conversationId,
            type: "artifact_preview",
            payload: {
              ...event.payload,
              messageId: assistantMessage.id
            }
          },
          db
        );
      } else if (event.type === "tool.call.completed") {
        createMessageArtifact(
          {
            messageId: assistantMessage.id,
            conversationId: input.conversationId,
            type: "tool_call",
            payload: event.payload
          },
          db
        );
      } else if (event.type === "tool.result") {
        createMessageArtifact(
          {
            messageId: assistantMessage.id,
            conversationId: input.conversationId,
            type: "tool_result",
            payload: event.payload
          },
          db
        );
      } else if (event.type === "command.result") {
        createMessageArtifact(
          {
            messageId: assistantMessage.id,
            conversationId: input.conversationId,
            type: "command_result",
            payload: event.payload
          },
          db
        );
      } else if (event.type === "file.reference") {
        createMessageArtifact(
          {
            messageId: assistantMessage.id,
            conversationId: input.conversationId,
            type: "file_reference",
            payload: event.payload
          },
          db
        );
      } else if (event.type === "run.failed") {
        status = "failed";
        errorMessage = event.payload.message;
        // Persist error artifact for the assistant message so the UI can
        // show the error reason after a page refresh.
        createMessageArtifact(
          {
            messageId: assistantMessage.id,
            conversationId: input.conversationId,
            type: "error",
            payload: {
              message: event.payload.message,
              code: event.payload.code
            }
          },
          db
        );
        updateMessageStatus(assistantMessage.id, "failed", db);
        updateAgentRunStatus(agentRunRecord.id, "failed", errorMessage, db);
      }

      if (event.type === "run.completed") {
        status = event.payload.status === "cancelled" ? "cancelled" : "completed";
        updateMessageStatus(assistantMessage.id, "completed", db);
        updateAgentRunStatus(
          agentRunRecord.id,
          status === "cancelled" ? "cancelled" : "completed",
          undefined,
          db
        );
      }

      // Forward to the IPC sink and yield for the caller.
      sink?.(forwardedEvent);
      yield forwardedEvent;
    }
  } catch (error) {
    status = "failed";
    errorMessage = error instanceof Error ? error.message : String(error);
    // Persist the run.failed event so the DB and IPC stay consistent.
    const failedEvent: AgentRunEvent = {
      id: generateAgentRunEventId(),
      runId: runLock.runId,
      conversationId: input.conversationId,
      seq: Number.MAX_SAFE_INTEGER,
      type: "run.failed",
      createdAt: new Date().toISOString(),
      payload: {
        messageId: assistantMessage.id,
        message: errorMessage
      }
    };
    insertAgentRunEvent(failedEvent, db);
    createMessageArtifact(
      {
        messageId: assistantMessage.id,
        conversationId: input.conversationId,
        type: "error",
        payload: { message: errorMessage }
      },
      db
    );
    updateMessageStatus(assistantMessage.id, "failed", db);
    updateAgentRunStatus(agentRunRecord.id, "failed", errorMessage, db);
    sink?.(failedEvent);
    yield failedEvent;
  } finally {
    // 7. Release the lock atomically with the run state.
    if (status === "failed") {
      runLock.fail(errorMessage ?? "Agent run failed.");
    } else if (status === "cancelled") {
      runLock.release("cancelled");
    } else {
      runLock.release("completed");
    }
  }

  // Side-effects after the stream completes: provider session upsert.
  if (newProviderSessionId) {
    persistProviderSession(
      {
        providerSessionId: newProviderSessionId,
        provider: input.agent.runtimeProvider,
        conversationId: input.conversationId,
        workspaceId: input.workspaceId,
        agentId: input.agent.id,
        workspaceContextId: input.workspaceContextId,
        rootPath: input.rootPath,
        executionScope
      },
      db
    );
    updateAgentRunProviderSessionId(agentRunRecord.id, newProviderSessionId, db);
  }

  if (usedFallback) {
    markAgentRunUsedFallback(agentRunRecord.id, db);
  }
}

/**
 * Convenience helper that runs the streaming service to completion and
 * returns the final outcome. Used by the run-with-conversation service.
 */
export async function runStreamingAgentToCompletion(
  input: StreamingRunInput,
  db: AgentHubDatabase = getDatabase(),
  sink?: StreamingRunSink
): Promise<StreamingRunResult> {
  let lastEvent: AgentRunEvent | null = null;
  let runId = "";
  let assistantMessageId = "";
  for await (const event of runStreamingAgent(input, db, sink)) {
    lastEvent = event;
    if (!runId) {
      runId = event.runId;
    }
    if (event.type === "message.started") {
      assistantMessageId = event.payload.messageId;
    }
  }
  if (!lastEvent || !runId) {
    throw new Error("Streaming run produced no events.");
  }
  // Look up the actual assistant message by run id (we may not have caught
  // the message.started event if the sink was nil and the caller only wants
  // the final state).
  const status =
    lastEvent.type === "run.completed"
      ? lastEvent.payload.status
      : lastEvent.type === "run.failed"
      ? "failed"
      : "completed";
  const errorMessage =
    lastEvent.type === "run.failed" ? lastEvent.payload.message : undefined;
  const artifacts = assistantMessageId
    ? getArtifactsByMessage(assistantMessageId, db)
    : [];
  return {
    runId,
    assistantMessageId,
    status,
    ...(errorMessage ? { errorMessage } : {}),
    artifacts
  };
}

function createAssistantPlaceholder(
  input: {
    workspaceId: string;
    conversationId: string;
    agentId: string;
  },
  db: AgentHubDatabase
): Message {
  return createMessage(
    {
      workspaceId: input.workspaceId,
      conversationId: input.conversationId,
      senderType: "agent",
      senderId: input.agentId,
      messageType: "text",
      content: { text: "" },
      status: "streaming"
    },
    db
  );
}

async function finalizeFailure(input: {
  db: AgentHubDatabase;
  runLock: { runId: string; fail: (m: string) => void };
  agentRunRecordId: string;
  assistantMessageId: string;
  errorMessage: string;
  sink?: StreamingRunSink;
}): Promise<AgentRunEvent> {
  const event: AgentRunEvent = {
    id: generateAgentRunEventId(),
    runId: input.runLock.runId,
    conversationId: "",
    seq: 0,
    type: "run.failed",
    createdAt: new Date().toISOString(),
    payload: {
      messageId: input.assistantMessageId,
      message: input.errorMessage
    }
  };
  insertAgentRunEvent(event, input.db);
  createMessageArtifact(
    {
      messageId: input.assistantMessageId,
      conversationId: event.conversationId,
      type: "error",
      payload: { message: input.errorMessage }
    },
    input.db
  );
  updateMessageStatus(input.assistantMessageId, "failed", input.db);
  updateAgentRunStatus(input.agentRunRecordId, "failed", input.errorMessage, input.db);
  input.runLock.fail(input.errorMessage);
  input.sink?.(event);
  return event;
}

function persistProviderSession(
  input: {
    providerSessionId: string;
    provider: RuntimeProvider;
    conversationId: string;
    workspaceId: string;
    agentId: string;
    workspaceContextId: string | null;
    rootPath: string;
    executionScope: ProviderSessionExecutionScope;
  },
  db: AgentHubDatabase
): void {
  markActiveSessionsAsReplaced(
    input.conversationId,
    {
      agentId: input.agentId,
      provider: input.provider,
      workspaceContextId: input.workspaceContextId,
      rootPath: input.rootPath,
      executionScope: input.executionScope
    },
    db
  );
  createProviderSession(
    {
      conversationId: input.conversationId,
      workspaceId: input.workspaceId,
      agentId: input.agentId,
      provider: input.provider,
      providerSessionId: input.providerSessionId,
      workspaceContextId: input.workspaceContextId,
      rootPath: input.rootPath,
      executionScope: input.executionScope
    },
    db
  );
}

function getBuiltinContextMessages(
  input: StreamingRunInput,
  db: AgentHubDatabase
): NonNullable<AgentProviderRunInput["contextMessages"]> {
  let contextWindowTokens = DEFAULT_CONTEXT_WINDOW_TOKENS;
  let reservedOutputTokens = DEFAULT_MAX_OUTPUT_TOKENS;
  try {
    const limits = loadMainAgentConfig(input.rootPath).limits;
    contextWindowTokens = limits.contextWindowTokens;
    reservedOutputTokens = limits.maxOutputTokens;
  } catch {
    // Adapter will report the config error; use defaults.
  }
  return buildConversationContextForAgentRun(
    {
      conversationId: input.conversationId,
      currentUserMessage: input.userMessage,
      systemPrompt: input.systemPrompt,
      workspaceInfo: `rootPath: ${input.rootPath}`,
      budget: {
        contextWindowTokens,
        reservedOutputTokens,
        safetyMarginTokens: DEFAULT_CONTEXT_SAFETY_MARGIN_TOKENS
      }
    },
    db
  ).contextMessages;
}

export { markRunFailed };
export type { MessageArtifactType, ErrorPayload };
