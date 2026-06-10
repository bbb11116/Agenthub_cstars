import { randomUUID } from "node:crypto";
import type { AgentAdapter, AgentEvent, AgentRunInput } from "../../../shared/agentAdapter";
import type { ArtifactPreviewPayload } from "../../../shared/artifact";
import type {
  AgentProviderAdapter,
  AgentProviderRunInput,
  AgentRunEvent,
  CommandResultPayload,
  DiffProposalPayload,
  ErrorPayload,
  FileReferencePayload,
  MessageDeltaPayload,
  MessageThinkingDeltaPayload,
  ToolCallCompletedPayload,
  ToolCallStartedPayload,
  ToolResultPayload
} from "../../../shared/agentRunEvent";

/**
 * Unified provider adapter.
 *
 * Wraps any existing `AgentAdapter` (builtin OpenAI/Anthropic, claude_code,
 * codex_local, opencode) and translates its provider-specific `AgentEvent`
 * stream into the unified `AgentRunEvent` stream consumed by the streaming
 * run service. The frontend never sees the provider-specific shape; the
 * streaming service persists each event to `agent_run_events` so a fresh
 * page load can replay the full assistant response from the database alone.
 *
 * Lifecycle:
 *   run.started → (message.started) → (message.delta)* → (tool.* | diff.* |
 *   command.* | file.* | error) → message.completed → run.completed|run.failed
 */
export class UnifiedAgentProviderAdapter implements AgentProviderAdapter {
  private readonly inner: AgentAdapter;

  constructor(inner: AgentAdapter) {
    this.inner = inner;
  }

  async *run(input: AgentProviderRunInput): AsyncIterable<AgentRunEvent> {
    const startedAt = new Date().toISOString();
    let seq = 0;
    let activeMessageId: string | null = null;
    let messageStarted = false;
    const runId = input.runId;

    const emit = (
      type: AgentRunEvent["type"],
      payload: AgentRunEvent["payload"]
    ): AgentRunEvent => {
      const event = {
        id: randomUUID(),
        runId,
        conversationId: input.conversationId,
        seq: seq++,
        type,
        createdAt: new Date().toISOString(),
        payload
      } as AgentRunEvent;
      return event;
    };

    const adapterInput: AgentRunInput = {
      workspaceId: input.workspaceId ?? input.conversationId,
      conversationId: input.conversationId,
      agentId: input.agentId,
      provider: input.provider ?? "mock",
      rootPath: input.rootPath ?? "",
      systemPrompt: input.systemPrompt,
      userMessage: input.userMessage,
      contextMessages: input.contextMessages,
      toolPermissions: input.toolPermissions ?? [],
      runOptions: {
        mode: "single_chat",
        maxIterations: input.maxIterations,
        conversationId: input.conversationId,
        agentId: input.agentId,
        workspaceRoot: input.rootPath ?? "",
        prompt: input.userMessage
      },
      resume: {
        enabled: input.resume.enabled,
        providerSessionId: input.resume.providerSessionId
      }
    };

    yield emit("run.started", undefined);
    if (!messageStarted) {
      activeMessageId = randomUUID();
      messageStarted = true;
      yield emit("message.started", { messageId: activeMessageId });
    }

    try {
      for await (const event of this.inner.run(adapterInput)) {
        for (const unified of translateAgentEvent(
          event,
          input.conversationId,
          runId,
          startedAt,
          seq,
          activeMessageId ?? (activeMessageId = randomUUID())
        )) {
          if (!messageStarted && unified.type === "message.started") {
            messageStarted = true;
            activeMessageId = unified.payload.messageId;
            seq = unified.seq + 1;
            yield unified;
            continue;
          }
          seq = unified.seq + 1;
          yield unified;
        }
      }
      if (messageStarted && activeMessageId) {
        yield emit("message.completed", { messageId: activeMessageId });
      }
      yield emit("run.completed", {
        messageId: activeMessageId,
        status: "completed"
      });
    } catch (error) {
      const errorPayload: ErrorPayload = {
        messageId: activeMessageId,
        message: error instanceof Error ? error.message : String(error)
      };
      yield emit("run.failed", errorPayload);
    }
  }
}

/**
 * Pure translation function from a single `AgentEvent` to one or more
 * `AgentRunEvent`s. Exposed for unit testing.
 */
export function translateAgentEvent(
  event: AgentEvent,
  conversationId: string,
  runId: string,
  startedAt: string,
  startingSeq: number,
  messageId: string
): AgentRunEvent[] {
  const base = {
    runId,
    conversationId,
    createdAt: new Date().toISOString(),
    id: randomUUID()
  };
  let seq = startingSeq;
  const emit = <T extends AgentRunEvent>(type: T["type"], payload: T["payload"]): T => {
    const ev = {
      ...base,
      seq: seq++,
      type,
      payload
    } as T;
    return ev;
  };

  switch (event.type) {
    case "text_delta": {
      const payload: MessageDeltaPayload = {
        messageId,
        delta: event.content
      };
      return [emit<AgentRunEvent>("message.delta", payload)];
    }

    case "reasoning_delta": {
      const payload: MessageThinkingDeltaPayload = {
        messageId,
        delta: event.content
      };
      return [emit<AgentRunEvent>("message.thinking_delta", payload)];
    }

    case "provider_session": {
      // Provider session is metadata, not a user-facing event. Persist as a
      // tool.call.completed pseudo-event? No — the streaming run service can
      // capture this in the run metadata instead. Here we surface it as a
      // synthetic tool call so the renderer can react if it wants, but the
      // primary consumer is the run service.
      return [];
    }

    case "diff_proposal": {
      const proposal = event.proposal as unknown;
      const payload: DiffProposalPayload = extractDiffProposal(proposal, messageId);
      return [emit<AgentRunEvent>("diff.proposal", payload)];
    }

    case "structured_result": {
      const result = event.result as unknown;
      const payloads = extractStructuredResult(result, messageId);
      return payloads.map((p) => {
        if (p.type === "diff.proposal") {
          return emit<AgentRunEvent>("diff.proposal", p.payload as DiffProposalPayload);
        }
        if (p.type === "artifact.created") {
          return emit<AgentRunEvent>("artifact.created", p.payload as ArtifactPreviewPayload);
        }
        if (p.type === "command.result") {
          return emit<AgentRunEvent>("command.result", p.payload as CommandResultPayload);
        }
        if (p.type === "file.reference") {
          return emit<AgentRunEvent>("file.reference", p.payload as FileReferencePayload);
        }
        if (p.type === "tool.result") {
          return emit<AgentRunEvent>("tool.result", p.payload as ToolResultPayload);
        }
        return emit<AgentRunEvent>("tool.call.completed", p.payload as ToolCallCompletedPayload);
      });
    }

    case "error": {
      const payload: ErrorPayload = {
        messageId,
        message: event.message
      };
      return [emit<AgentRunEvent>("run.failed", payload)];
    }

    case "status": {
      // Adapter-level status events don't translate directly. The streaming
      // run service synthesizes its own lifecycle events. We only forward
      // status.iteration_limit_reached as a hint.
      if (event.status === "iteration_limit_reached") {
        const payload: ErrorPayload = {
          messageId,
          message: "Iteration limit reached"
        };
        return [emit<AgentRunEvent>("run.failed", payload)];
      }
      return [];
    }
  }
}

function extractDiffProposal(proposal: unknown, messageId: string): DiffProposalPayload {
  const record =
    proposal && typeof proposal === "object" ? (proposal as Record<string, unknown>) : null;
  const proposalId =
    (record && typeof record.id === "string" && record.id) ||
    (record && typeof record.proposalId === "string" && record.proposalId) ||
    randomUUID();
  const rawFiles = record && Array.isArray(record.files) ? (record.files as unknown[]) : [];
  const files = rawFiles
    .map((file) => {
      if (!file || typeof file !== "object") {
        return null;
      }
      const obj = file as Record<string, unknown>;
      const path = typeof obj.path === "string" ? obj.path : null;
      const unifiedDiff = typeof obj.unifiedDiff === "string" ? obj.unifiedDiff : null;
      const status: "added" | "modified" | "deleted" | "renamed" =
        obj.status === "added" ||
        obj.status === "modified" ||
        obj.status === "deleted" ||
        obj.status === "renamed"
          ? obj.status
          : "modified";
      if (!path || unifiedDiff === null) {
        return null;
      }
      return { path, status, unifiedDiff };
    })
    .filter((entry): entry is NonNullable<typeof entry> => entry !== null);

  return {
    proposalId,
    messageId,
    files
  };
}

function extractStructuredResult(
  result: unknown,
  messageId: string
): Array<
  | { type: "diff.proposal"; payload: DiffProposalPayload }
  | { type: "artifact.created"; payload: ArtifactPreviewPayload }
  | { type: "command.result"; payload: CommandResultPayload }
  | { type: "file.reference"; payload: FileReferencePayload }
  | { type: "tool.result"; payload: ToolResultPayload }
  | { type: "tool.call.completed"; payload: ToolCallCompletedPayload }
> {
  if (!result || typeof result !== "object") {
    return [];
  }
  const out: ReturnType<typeof extractStructuredResult> = [];
  const record = result as Record<string, unknown>;
  if (Array.isArray(record.toolCalls)) {
    for (const toolCall of record.toolCalls) {
      if (!toolCall || typeof toolCall !== "object") {
        continue;
      }
      const tc = toolCall as Record<string, unknown>;
      const startedPayload: ToolCallStartedPayload = {
        toolCallId:
          typeof tc.id === "string" ? tc.id : randomUUID(),
        messageId,
        name: typeof tc.name === "string" ? tc.name : "tool",
        arguments: tc.arguments && typeof tc.arguments === "object"
          ? (tc.arguments as Record<string, unknown>)
          : null
      };
      out.push({
        type: "tool.call.completed",
        payload: { ...startedPayload, ok: true }
      });
    }
  }
  if (Array.isArray(record.toolResults)) {
    for (const toolResult of record.toolResults) {
      if (!toolResult || typeof toolResult !== "object") {
        continue;
      }
      const tr = toolResult as Record<string, unknown>;
      const payload: ToolResultPayload = {
        toolCallId:
          typeof tr.toolCallId === "string"
            ? tr.toolCallId
            : typeof tr.id === "string"
              ? tr.id
              : randomUUID(),
        messageId,
        name: typeof tr.name === "string" ? tr.name : "tool",
        result: "result" in tr ? tr.result : null,
        ok: typeof tr.ok === "boolean" ? tr.ok : true,
        ...(typeof tr.errorMessage === "string" ? { errorMessage: tr.errorMessage } : {})
      };
      out.push({ type: "tool.result", payload });
    }
  }
  if (Array.isArray(record.diffProposals)) {
    for (const proposal of record.diffProposals) {
      out.push({
        type: "diff.proposal",
        payload: extractDiffProposal(proposal, messageId)
      });
    }
  }
  if (Array.isArray(record.artifacts)) {
    for (const artifact of record.artifacts) {
      if (!artifact || typeof artifact !== "object") {
        continue;
      }
      const obj = artifact as Record<string, unknown>;
      const artifactId =
        typeof obj.artifactId === "string"
          ? obj.artifactId
          : typeof obj.id === "string"
            ? obj.id
            : null;
      const title = typeof obj.title === "string" ? obj.title : "Artifact";
      const artifactType =
        obj.type === "html" ||
        obj.type === "markdown" ||
        obj.type === "diff" ||
        obj.type === "document" ||
        obj.type === "presentation" ||
        obj.type === "pdf" ||
        obj.type === "code"
          ? obj.type
          : "code";

      if (!artifactId) {
        continue;
      }

      out.push({
        type: "artifact.created",
        payload: {
          messageId,
          artifactId,
          title,
          artifactType,
          renderMode:
            artifactType === "html"
              ? "html_iframe"
              : artifactType === "markdown"
                ? "markdown"
                : artifactType === "document"
                  ? "document_pages"
                  : artifactType === "presentation"
                    ? "presentation_pages"
                    : artifactType === "pdf"
                      ? "pdf"
                      : artifactType === "diff"
                        ? "diff"
                        : "code",
          renderStatus:
            obj.renderStatus === "queued" ||
            obj.renderStatus === "rendering" ||
            obj.renderStatus === "ready" ||
            obj.renderStatus === "error"
              ? obj.renderStatus
              : "ready",
          filePath: typeof obj.filePath === "string" ? obj.filePath : undefined,
          language: typeof obj.language === "string" ? obj.language : undefined,
          pageCount: typeof obj.pageCount === "number" ? obj.pageCount : undefined,
          sizeBytes: typeof obj.sizeBytes === "number" ? obj.sizeBytes : undefined
        }
      });
    }
  }
  if (Array.isArray(record.commandResults)) {
    for (const cr of record.commandResults) {
      if (!cr || typeof cr !== "object") {
        continue;
      }
      const obj = cr as Record<string, unknown>;
      const payload: CommandResultPayload = {
        messageId,
        command: typeof obj.command === "string" ? obj.command : "",
        exitCode: typeof obj.exitCode === "number" ? obj.exitCode : null,
        stdout: typeof obj.stdout === "string" ? obj.stdout : "",
        stderr: typeof obj.stderr === "string" ? obj.stderr : ""
      };
      out.push({ type: "command.result", payload });
    }
  }
  if (Array.isArray(record.fileReferences)) {
    for (const fr of record.fileReferences) {
      if (!fr || typeof fr !== "object") {
        continue;
      }
      const obj = fr as Record<string, unknown>;
      if (typeof obj.path !== "string") {
        continue;
      }
      const payload: FileReferencePayload = {
        messageId,
        path: obj.path,
        range: typeof obj.range === "string" ? obj.range : undefined,
        reason: typeof obj.reason === "string" ? obj.reason : undefined
      };
      out.push({ type: "file.reference", payload });
    }
  }
  return out;
}
