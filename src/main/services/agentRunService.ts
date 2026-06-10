import type {
  Agent,
  AgentRunLog,
  AgentStatusCardContent,
  Conversation,
  Message,
  RunAgentInput,
  RunAgentOutput,
  RunAgentStreamEvent,
  RuntimeProvider,
  RuntimeStatus,
  Workspace
} from "../../shared/domain";
import { RUNTIME_PROVIDER_LABELS } from "../../shared/runtime";
import type { Artifact } from "../../shared/artifact";
import type { DiffProposal } from "../../shared/diff";
import { getDatabase, type AgentHubDatabase } from "../db";
import {
  getAgentById,
  updateAgentStatus as updateAgentStatusInRepo
} from "../db/repositories/agentRepo";
import {
  getConversationById,
  updateConversation
} from "../db/repositories/conversationRepo";
import { getWorkspaceById } from "../db/repositories/workspaceRepo";
import { runMockAgentTask } from "../demo/demoAgentRunner";
import { runLocalAgent } from "./localRuntimeRunner";
import { checkRuntimeProvider } from "./runtimeService";
import { createMessage } from "./messageService";
import { createDiffProposalFromText } from "./diffProposalTextService";

type RuntimeChecker = (provider: RuntimeProvider) => Promise<RuntimeStatus>;

export type AgentRunContext = {
  agent: Agent;
  workspace: Workspace;
  conversation: Conversation;
  workspaceId: string;
  workspaceRootPath: string;
  conversationId: string;
  conversationTitle: string;
  conversationMode: Conversation["mode"];
  userMessage: string;
  userMessageId?: string;
  metaPrompt?: string;
};

export type AgentTaskResult = Partial<Pick<AgentStatusCardContent, "title" | "detail">> & {
  messages?: Message[];
  diffProposal?: DiffProposal;
  diffProposals?: DiffProposal[];
  artifacts?: Artifact[];
  status?: Extract<Agent["status"], "available" | "error" | "unavailable">;
  runLog?: AgentRunLog;
  showCompletionStatus?: boolean;
};

export type AgentTaskRunner = (
  context: AgentRunContext
) => Promise<AgentTaskResult | void>;

export type AgentRunStreamSink = (event: RunAgentStreamEvent) => void;

const MOCK_RUNTIME_DELAY_MS = 180;
const MAX_LOCAL_OUTPUT_MESSAGE_LENGTH = 12_000;

class AgentRunValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AgentRunValidationError";
  }
}

function assertNonEmptyString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new AgentRunValidationError(`${label} is required.`);
  }

  return value.trim();
}

function normalizeRunAgentInput(input: RunAgentInput): RunAgentInput {
  if (!input || typeof input !== "object") {
    throw new AgentRunValidationError("Agent run input is required.");
  }

  return {
    workspaceId: assertNonEmptyString(input.workspaceId, "workspaceId"),
    conversationId: assertNonEmptyString(input.conversationId, "conversationId"),
    agentId: assertNonEmptyString(input.agentId, "agentId"),
    userMessage: assertNonEmptyString(input.userMessage, "userMessage"),
    userMessageId: input.userMessageId?.trim()
  };
}

function getRunContext(
  input: RunAgentInput,
  db: AgentHubDatabase
): AgentRunContext | null {
  const agent = getAgentById(input.agentId, db);

  if (!agent) {
    return null;
  }

  if (agent.workspaceId !== input.workspaceId) {
    throw new AgentRunValidationError("Agent does not belong to the workspace.");
  }

  const workspace = getWorkspaceById(input.workspaceId, db);

  if (!workspace) {
    throw new AgentRunValidationError("Workspace not found.");
  }

  const conversation = getConversationById(input.conversationId, db);

  if (!conversation || conversation.workspaceId !== workspace.id) {
    throw new AgentRunValidationError("Conversation not found.");
  }

  if (conversation.type !== "group" && conversation.agentId !== agent.id) {
    throw new AgentRunValidationError("Agent does not match the conversation.");
  }

    return {
      agent,
      workspace,
      conversation,
      workspaceId: workspace.id,
    workspaceRootPath: workspace.rootPath,
    conversationId: conversation.id,
    conversationTitle: conversation.title,
    conversationMode: conversation.mode,
    userMessage: input.userMessage,
    userMessageId: input.userMessageId,
    metaPrompt: input.metaPrompt
  };
}

function toErrorMessage(error: unknown, fallback: string): string {
  return error instanceof Error ? error.message : fallback;
}

function getRuntimeLabel(provider: RuntimeProvider): string {
  return RUNTIME_PROVIDER_LABELS[provider] ?? provider;
}

async function getRuntimeAvailability(
  agent: Agent,
  checkRuntime: RuntimeChecker
): Promise<{ available: boolean; detail?: string }> {
  try {
    const runtimeStatus = await checkRuntime(agent.runtimeProvider);

    return {
      available: runtimeStatus.available,
      detail: runtimeStatus.error
    };
  } catch (error) {
    return {
      available: agent.runtimeProvider === "mock",
      detail: toErrorMessage(error, "Runtime check failed.")
    };
  }
}

function updateStatusSafely(
  agent: Agent,
  status: Agent["status"],
  db: AgentHubDatabase
): Agent {
  try {
    return updateAgentStatusInRepo(agent.id, status, db) ?? agent;
  } catch (error) {
    console.warn("Failed to update Agent status.", error);
    return agent;
  }
}

function updateAgentStatusOnly(
  context: AgentRunContext,
  status: Agent["status"],
  db: AgentHubDatabase
): Agent {
  return db.transaction(() => updateStatusSafely(context.agent, status, db))();
}

function createAgentStatusMessage(
  context: AgentRunContext,
  content: AgentStatusCardContent,
  db: AgentHubDatabase
): Message {
  const message = createMessage(
    {
      workspaceId: context.workspaceId,
      conversationId: context.conversationId,
      senderType: "agent",
      senderId: context.agent.id,
      messageType: "agent_status",
      content
    },
    db
  );

  updateConversation(
    context.conversationId,
    {
      title: context.conversationTitle,
      mode: context.conversationMode
    },
    db
  );

  return message;
}

function createAgentTextMessage(
  context: AgentRunContext,
  text: string,
  db: AgentHubDatabase
): Message {
  const message = createMessage(
    {
      workspaceId: context.workspaceId,
      conversationId: context.conversationId,
      senderType: "agent",
      senderId: context.agent.id,
      messageType: "text",
      content: {
        text
      }
    },
    db
  );

  updateConversation(
    context.conversationId,
    {
      title: context.conversationTitle,
      mode: context.conversationMode
    },
    db
  );

  return message;
}

function recordAgentStatus(
  context: AgentRunContext,
  status: Agent["status"],
  title: string,
  detail: string | undefined,
  db: AgentHubDatabase
): { agent: Agent; message: Message } {
  const recordTransition = db.transaction(() => {
    const agent = updateStatusSafely(context.agent, status, db);
    const message = createAgentStatusMessage(
      {
        ...context,
        agent
      },
      {
        agentId: agent.id,
        status,
        title,
        detail
      },
      db
    );

    return {
      agent,
      message
    };
  });

  return recordTransition();
}

async function defaultAgentTaskRunner(
  context: AgentRunContext,
  db: AgentHubDatabase = getDatabase(),
  stream?: AgentRunStreamSink
): Promise<AgentTaskResult> {
  if (context.agent.runtimeProvider !== "mock") {
    return runLocalAgentTask(context, db, stream);
  }

  await new Promise<void>((resolve) => {
    setTimeout(resolve, MOCK_RUNTIME_DELAY_MS);
  });

  const output = await runMockAgentTask(
    {
      workspaceId: context.workspaceId,
      agentId: context.agent.id,
      conversationId: context.conversationId,
      userMessage: context.userMessage
    },
    db
  );

  return {
    ...output,
    title: output.diffProposal
      ? `${context.agent.name} generated a diff proposal.`
      : `${context.agent.name} finished the mock run.`,
    detail: output.diffProposal
      ? "Review the proposal before applying changes."
      : "Mock runtime handled the request without calling a real API."
  };
}

function appendOutput(current: string, next: string): string {
  const combined = `${current}${next}`;

  if (combined.length <= MAX_LOCAL_OUTPUT_MESSAGE_LENGTH) {
    return combined;
  }

  return `${combined.slice(0, MAX_LOCAL_OUTPUT_MESSAGE_LENGTH)}\n[output truncated]`;
}

function formatLocalRuntimeMessage(input: {
  provider: RuntimeProvider;
  cwd: string;
  stdout: string;
  stderr: string;
  exitCode: number | null;
  error?: string;
}): string {
  const sections = [
    `${getRuntimeLabel(input.provider)} run log`,
    `cwd: ${input.cwd}`,
    `exitCode: ${input.exitCode ?? "unknown"}`
  ];

  if (input.stdout.trim()) {
    sections.push(["stdout:", input.stdout.trimEnd()].join("\n"));
  }

  if (input.stderr.trim()) {
    sections.push(["stderr:", input.stderr.trimEnd()].join("\n"));
  }

  if (input.error) {
    sections.push(`error: ${input.error}`);
  }

  return sections.join("\n\n");
}

function formatLocalRuntimeReply(stdout: string): string | null {
  const reply = stdout.trim();

  return reply.length > 0 ? reply : null;
}

function isRuntimeUnavailableError(error: string): boolean {
  return /command not found|permission denied/i.test(error);
}

async function runLocalAgentTask(
  context: AgentRunContext,
  db: AgentHubDatabase,
  stream?: AgentRunStreamSink
): Promise<AgentTaskResult> {
  let stdout = "";
  let stderr = "";
  let cwd = context.workspaceRootPath;
  let exitCode: number | null = null;
  let runError: string | undefined;
  let started = false;
  const artifacts: Artifact[] = [];
  const diffProposals: DiffProposal[] = [];

  for await (const event of runLocalAgent({
    workspace: context.workspace,
    agent: context.agent,
    conversation: context.conversation,
    userMessage: context.userMessage,
    mode: "non_interactive",
    metaPrompt: context.metaPrompt
  })) {
    if (event.type === "started") {
      started = true;
      cwd = event.cwd;
      continue;
    }

    if (event.type === "stdout") {
      stdout = appendOutput(stdout, event.text);
      stream?.({
        type: "text_delta",
        workspaceId: context.workspaceId,
        conversationId: context.conversationId,
        agentId: context.agent.id,
        text: event.text
      });
      continue;
    }

    if (event.type === "stderr") {
      stderr = appendOutput(stderr, event.text);
      continue;
    }

    if (event.type === "exited") {
      exitCode = event.code;
      continue;
    }

    if (event.type === "artifact") {
      artifacts.push(event.artifact);
      continue;
    }

    if (event.type === "diff_proposal") {
      diffProposals.push(event.diffProposal);
      continue;
    }

    runError = event.error;
  }

  const provider = context.agent.runtimeProvider;
  const runLog: AgentRunLog = {
    id: `run-${Date.now()}`,
    workspaceId: context.workspaceId,
    agentId: context.agent.id,
    conversationId: context.conversationId,
    provider,
    cwd,
    status: runError || (exitCode !== null && exitCode !== 0) ? "error" : "exited",
    stdout: stdout || undefined,
    stderr: stderr || undefined,
    exitCode: exitCode ?? undefined,
    createdAt: new Date().toISOString()
  };

  function createRunLogMessage(): Message {
    return createAgentTextMessage(
      context,
      formatLocalRuntimeMessage({
        provider,
        cwd,
        stdout,
        stderr,
        exitCode,
        error: runError
      }),
      db
    );
  }

  async function createReplyMessages(): Promise<Message[]> {
    const rawReply = formatLocalRuntimeReply(stdout);
    const processed = rawReply
      ? await createDiffProposalFromText(
          {
            workspaceId: context.workspaceId,
            agentId: context.agent.id,
            conversationId: context.conversationId,
            text: rawReply
          },
          db
        )
      : {
          text: "",
          diffProposals: [],
          diffMessages: []
        };
    diffProposals.push(...processed.diffProposals);

    const messages: Message[] = [...processed.diffMessages];
    if (processed.text.length > 0) {
      messages.push(createAgentTextMessage(context, processed.text, db));
      return messages;
    }

    if (messages.length > 0) {
      return messages;
    }

    messages.push(
      createAgentTextMessage(
        context,
        formatLocalRuntimeMessage({
          provider,
          cwd,
          stdout: rawReply ? "" : stdout,
          stderr,
          exitCode,
          error: runError
        }),
        db
      )
    );
    return messages;
  }

  if (runError) {
    const logMessage = createRunLogMessage();
    const status = isRuntimeUnavailableError(runError) ? "unavailable" : "error";

    return {
      status,
      messages: [logMessage],
      title:
        status === "unavailable"
          ? `${getRuntimeLabel(provider)} runtime is unavailable.`
          : `${getRuntimeLabel(provider)} run failed.`,
      detail: runError,
      runLog,
      artifacts,
      diffProposal: diffProposals[0],
      diffProposals
    };
  }

  if (!started) {
    const logMessage = createRunLogMessage();

    return {
      status: "error",
      messages: [logMessage],
      title: `${getRuntimeLabel(provider)} did not start.`,
      detail: `cwd: ${cwd}`,
      runLog,
      artifacts,
      diffProposal: diffProposals[0],
      diffProposals
    };
  }

  if (exitCode !== 0) {
    const logMessage = createRunLogMessage();

    return {
      status: "error",
      messages: [logMessage],
      title: `${getRuntimeLabel(provider)} exited with code ${exitCode ?? "unknown"}.`,
      detail: `cwd: ${cwd}`,
      runLog,
      artifacts,
      diffProposal: diffProposals[0],
      diffProposals
    };
  }

  const replyMessages = await createReplyMessages();

  return {
    status: "available",
    messages: replyMessages,
    title: `${getRuntimeLabel(provider)} finished.`,
    detail: `cwd: ${cwd}`,
    runLog,
    artifacts,
    diffProposal: diffProposals[0],
    diffProposals,
    showCompletionStatus: false
  };
}

export async function runAgent(
  input: RunAgentInput,
  db: AgentHubDatabase = getDatabase(),
  checkRuntime: RuntimeChecker = checkRuntimeProvider,
  runTask: AgentTaskRunner = defaultAgentTaskRunner,
  stream?: AgentRunStreamSink
): Promise<RunAgentOutput> {
  const normalizedInput = normalizeRunAgentInput(input);
  const context = getRunContext(normalizedInput, db);

  if (!context) {
    return {
      agent: null,
      status: "error",
      messages: []
    };
  }

  const runtimeAvailability = await getRuntimeAvailability(context.agent, checkRuntime);

  if (!runtimeAvailability.available) {
    const unavailable = recordAgentStatus(
      context,
      "unavailable",
      `${context.agent.name} runtime is unavailable.`,
      runtimeAvailability.detail,
      db
    );

    return {
      agent: unavailable.agent,
      status: "unavailable",
      messages: [unavailable.message]
    };
  }

  const showRunningStatusMessage = context.agent.runtimeProvider === "mock";
  const running = showRunningStatusMessage
    ? recordAgentStatus(
        context,
        "running",
        `${context.agent.name} is running with Mock...`,
        undefined,
        db
      )
    : {
        agent: updateAgentStatusOnly(context, "running", db),
        message: null
      };
  const runningContext = {
    ...context,
    agent: running.agent
  };

  try {
    const result =
      runTask === defaultAgentTaskRunner
        ? await defaultAgentTaskRunner(runningContext, db, stream)
        : await runTask(runningContext);
    const finalStatus = result?.status ?? "available";
    const showCompletionStatusMessage = result?.showCompletionStatus !== false;
    const hasDiffProposal = Boolean(result?.diffProposal ?? result?.diffProposals?.[0]);
    const complete = showCompletionStatusMessage
      ? recordAgentStatus(
          runningContext,
          finalStatus,
          result?.title ??
            (finalStatus === "available"
              ? hasDiffProposal
                ? `${context.agent.name} generated a diff proposal.`
                : `${context.agent.name} finished.`
              : `${context.agent.name} run failed.`),
          result?.detail ??
            (finalStatus === "available" && hasDiffProposal
              ? "Review the proposal before applying changes."
              : undefined),
          db
        )
      : {
          agent: updateAgentStatusOnly(runningContext, finalStatus, db),
          message: null
        };

    return {
      agent: complete.agent,
      status: finalStatus,
      messages: [
        ...(running.message ? [running.message] : []),
        ...(result?.messages ?? []),
        ...(complete.message ? [complete.message] : [])
      ],
      diffProposal: result?.diffProposal ?? result?.diffProposals?.[0],
      diffProposals:
        result?.diffProposals ??
        (result?.diffProposal ? [result.diffProposal] : undefined),
      artifacts: result?.artifacts,
      runLog: result?.runLog
    };
  } catch (error) {
    const failed = recordAgentStatus(
      runningContext,
      "error",
      `${context.agent.name} hit an error.`,
      toErrorMessage(error, "Agent task failed."),
      db
    );

    return {
      agent: failed.agent,
      status: "error",
      messages: [...(running.message ? [running.message] : []), failed.message]
    };
  }
}

export function runAgentTask(
  input: RunAgentInput,
  db: AgentHubDatabase = getDatabase(),
  checkRuntime: RuntimeChecker = checkRuntimeProvider,
  runTask: AgentTaskRunner = defaultAgentTaskRunner,
  stream?: AgentRunStreamSink
): Promise<RunAgentOutput> {
  return runAgent(input, db, checkRuntime, runTask, stream);
}
