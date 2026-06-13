import type {
  Agent,
  Conversation,
  Message,
  RunAgentOutput,
  RunAgentStreamEvent,
  Workspace
} from "../../shared/domain";
import type { RuntimeProvider } from "../../shared/runtime";
import type { AgentAdapter, AgentEvent, AgentRunInput } from "../../shared/agentAdapter";
import {
  AGENT_EXECUTION_LIMITS,
  type AgentExecutionMode,
  type AgentRunOptions,
  type AgentRunResult
} from "../../shared/agentExecution";
import {
  ConversationNotFoundError,
  ProviderMismatchError,
  ConversationAlreadyRunningError,
  ResumeFailedError,
  FallbackRebuildFailedError
} from "../../shared/agentAdapter";
import { isBuiltinProvider } from "../../shared/runtime";
import {
  DEFAULT_CONTEXT_WINDOW_TOKENS,
  DEFAULT_MAX_OUTPUT_TOKENS
} from "../../shared/modelProvider";
import { runMainAgent } from "./orchestratorRuntimeService";
import { getDatabase, type AgentHubDatabase } from "../db";
import { getAgentById, updateAgentStatus as updateAgentStatusInRepo } from "../db/repositories/agentRepo";
import { getConversationById, createConversation } from "../db/repositories/conversationRepo";
import { getWorkspaceById } from "../db/repositories/workspaceRepo";
import { getMessagesByConversation, getMessageById, updateMessageContent } from "../db/repositories/messageRepo";
import {
  createProviderSession,
  getActiveProviderSession,
  updateProviderSessionStatus,
  markActiveSessionsAsReplaced,
  type ProviderSessionExecutionScope
} from "../db/repositories/providerSessionRepo";
import {
  createAgentRun,
  getRunningAgentRunByScope,
  updateAgentRunStatus,
  updateAgentRunProviderSessionId,
  updateAgentRunRawOutput,
  markAgentRunUsedFallback
} from "../db/repositories/agentRunRepo";
import { getAdapter } from "./adapters";
import { RUNTIME_PROVIDER_LABELS } from "../../shared/runtime";
import { getResolvedConfig, loadMainAgentConfig } from "./configService";
import { resolveProviderEnv } from "../config/provider-env-resolver";
import {
  buildConversationContextForAgentRun,
  DEFAULT_CONTEXT_SAFETY_MARGIN_TOKENS,
  type ContextBudget
} from "./conversationContextService";
import { resolveExecutionWorkspaceForConversation } from "./workspaceContextResolver";
import { buildDirectAgentMemoryContext } from "./memoryContextService";
import { createMessage } from "./messageService";
import { createDiffProposalFromText } from "./diffProposalTextService";
import { createDiffProposal } from "./diffService";
import { UNIFIED_RUN_POLICY } from "../../shared/agentRunPolicy";
import {
  runStreamingAgent,
  type StreamingRunSink
} from "./streamingRunService";
import type { AgentRunEvent } from "../../shared/agentRunEvent";
import { acquireConversationRun } from "./conversationRunLock";
import {
  getAgentRunsByConversation
} from "../db/repositories/agentRunRepo";
import { getArtifactsByMessage } from "../db/repositories/messageArtifactRepo";
import { appendMessageThinking } from "../db/repositories/messageRepo";
import { buildAgentSkillsSystemPrompt } from "./agentSkillCatalogService";

export type RunWithConversationStreamSink = (event: RunAgentStreamEvent) => void;

const DIRECT_EDIT_POLICY = [
  "AgentHub workspace editing policy:",
  "Language policy: follow the user's latest message language. If the user writes in Chinese, answer in Chinese unless they explicitly request another language.",
  "Execution rule: when the user gives you a deliverable request in their latest message, produce the full deliverable in THIS turn. Do NOT respond with anticipatory acknowledgments like '好的，我来为您制作' / 'Got it, I will create...' followed by stopping. The user expects the artifact, not a promise of one.",
  "If a clarification is genuinely required, ask at most one short question AND emit a best-effort placeholder deliverable in the same turn. Never produce zero artifacts when the user clearly asked for one.",
  "When the user asks you to create, modify, or write any file (HTML, code, config, markdown, etc.), emit a SEARCH/REPLACE block as plain text inside your reply. SEARCH/REPLACE is TEXT in your message, NOT a tool call. The user reviews the diff in the AgentHub UI and clicks Apply to commit it to the workspace.",
  "When the user asks for a 'preview', 'draft', 'demo', 'slide deck', or any 'show me what it would look like' HTML deliverable, treat it as a file write request: emit a SEARCH/REPLACE block for the target .html file inside the workspace. AgentHub will auto-render an HTML preview card from the new file content the moment you emit the SEARCH/REPLACE — the user sees the preview without clicking Apply. Apply is only needed if the user wants the file persisted to disk. Do NOT paste the full HTML body as plain text in your reply — always emit it as a SEARCH/REPLACE block so the preview card is generated.",
  "Slide-deck HTML format: when the deliverable is a multi-slide deck (e.g., 4-page PPT), produce ONE single HTML document with all slides stacked vertically — do NOT add JavaScript-based navigation, onclick/onkeydown handlers, prev/next buttons, page indicators, or any interactive controls. The AgentHub renderer scales the document to the panel width and lets the user scroll the iframe vertically to view each slide. Building a 'click next' / 'keyboard arrow' / 'swipe' interaction layer is wrong: it will be silently disabled by the iframe sandbox and the user will be left with broken controls. Just lay out each slide as a <section> (or <div> with a clear top margin) and the natural page-by-page scroll will work.",
  "Do not mention keyboard shortcuts, mouse-click regions, swipe gestures, or built-in navigation controls in your reply text. The user navigates by scrolling the preview.",
  "After emitting a SEARCH/REPLACE block, end your reply with a one-line note: 'Preview is shown above. Click Apply in the diff card if you want the file saved to disk.' (or the Chinese equivalent). This is required so the user knows the preview came from the diff.",
  "For ordinary chat, identity questions, architecture discussion, code explanation, and design advice, answer naturally as plain text.",
  "Do not append a 'No file changes proposed' tail to ordinary Q&A answers.",
  "Do not read or write files outside workspace.rootPath."
].join("\n");
const GROUP_SUBAGENT_POLICY = [
  "AgentHub group sub-agent policy:",
  "Language policy: follow the user's latest message language. If the user writes in Chinese, make summaries and reports Chinese unless explicitly requested otherwise.",
  "You only handle the assigned acceptance criteria.",
  "For assigned code or file modification criteria, emit a SEARCH/REPLACE block as plain text in your reply. The user reviews and applies via the AgentHub UI. SEARCH/REPLACE is TEXT, not a tool call.",
  "For analysis, explanation, review, or report criteria, do not emit a SEARCH/REPLACE block.",
  "Return one SubAgentResult JSON object as your final message."
].join("\n");
function formatToolPermissions(agent: Agent): string {
  return Object.entries({ ...agent.tools, applyDiff: false })
    .filter(([tool]) => tool !== "applyDiff")
    .map(([tool, enabled]) => `${tool}=${enabled ? "true" : "false"}`)
    .join(", ");
}

function buildEffectiveSystemPrompt(
  agent: Agent,
  mode: AgentExecutionMode,
  maxIterations: number
): string {
  const runtimePolicy = mode === "group_subagent"
    ? GROUP_SUBAGENT_POLICY
    : DIRECT_EDIT_POLICY;
  const skillsPrompt = buildAgentSkillsSystemPrompt(agent.skillIds ?? []);

  return [
    agent.systemPrompt,
    skillsPrompt,
    runtimePolicy,
    `Execution mode: ${mode}. ReAct-like iteration budget: maxIterations=${maxIterations}.`,
    UNIFIED_RUN_POLICY
  ]
    .filter((part) => part.trim().length > 0)
    .join("\n\n");
}

function getContextBudget(
  provider: RuntimeProvider,
  rootPath: string
): ContextBudget {
  if (isBuiltinProvider(provider)) {
    try {
      const limits = loadMainAgentConfig(rootPath).limits;
      return {
        contextWindowTokens: limits.contextWindowTokens,
        reservedOutputTokens: limits.maxOutputTokens,
        safetyMarginTokens: DEFAULT_CONTEXT_SAFETY_MARGIN_TOKENS
      };
    } catch {
      // The adapter will report a config error. Use defaults while preparing context.
    }
  }

  return {
    contextWindowTokens: DEFAULT_CONTEXT_WINDOW_TOKENS,
    reservedOutputTokens: DEFAULT_MAX_OUTPUT_TOKENS,
    safetyMarginTokens: DEFAULT_CONTEXT_SAFETY_MARGIN_TOKENS
  };
}

function getWorkspaceInfo(workspace: Workspace): string {
  return [
    `name: ${workspace.name}`,
    `rootPath: ${workspace.rootPath}`,
    `gitEnabled: ${workspace.gitEnabled ? "true" : "false"}`
  ].join("\n");
}

function getContextMessages(
  input: {
    conversationId: string;
    currentUserMessage: string;
    systemPrompt: string;
    workspace: Workspace;
    provider: RuntimeProvider;
  },
  db: AgentHubDatabase
): NonNullable<AgentRunInput["contextMessages"]> {
  return buildConversationContextForAgentRun(
    {
      conversationId: input.conversationId,
      currentUserMessage: input.currentUserMessage,
      systemPrompt: input.systemPrompt,
      workspaceInfo: getWorkspaceInfo(input.workspace),
      budget: getContextBudget(input.provider, input.workspace.rootPath)
    },
    db
  ).contextMessages;
}

function buildFallbackPrompt(input: {
  systemPrompt: string;
  contextMessages: Array<{ role: string; content: string }>;
  userMessage: string;
}): string {
  const parts = [
    input.systemPrompt,
    "你正在继续一个 AgentHub 历史对话，但底层 Provider 原生 session 已失效。",
    "下面是平台保存的历史消息，请基于这些上下文继续工作。",
    "不要声称你拥有失效的原生 session 上下文。",
    "继续执行用户当前请求。",
    "\n---\n历史消息:"
  ];

  const historyMessages = [...input.contextMessages];
  const lastMessage = historyMessages.at(-1);
  if (lastMessage?.role === "user" && lastMessage.content === input.userMessage) {
    historyMessages.pop();
  }

  for (const msg of historyMessages) {
    parts.push(`[${msg.role}]: ${msg.content}`);
  }

  parts.push(`\n---\n当前用户请求:\n${input.userMessage}`);
  return parts.join("\n\n");
}

function getRuntimeLabel(provider: RuntimeProvider): string {
  return RUNTIME_PROVIDER_LABELS[provider] ?? provider;
}

function readDebugDisableStreamForSubAgent(rootPath: string): boolean {
  try {
    const resolved = getResolvedConfig(rootPath);
    return resolved.merged.groupChat?.debugDisableStreamForSubAgent === true;
  } catch {
    return false;
  }
}

function requestsCodeChanges(message: string): boolean {
  const text = message.trim();
  const editIntent =
    /(?:实现|修复|修改|编辑|生成|新增|添加|删除|移除|重构|改成|改为|替换|创建|写入|调整|优化|补充|代码变更)/i.test(text) ||
    /\b(?:fix|implement|refactor|edit|modify|change|update|add|remove|delete|create|write|rename)\b/i.test(text);
  if (!editIntent) {
    return false;
  }

  if (
    /(?:解释|说明|讨论|分析|建议|设计建议|架构讨论|怎么看|为什么)/i.test(text) ||
    /\b(?:explain|describe|discuss|analyze|analyse|advice|suggest|why|what)\b/i.test(text)
  ) {
    return false;
  }

  return (
    /(?:代码|文件|组件|页面|按钮|文案|样式|函数|接口|配置|测试|bug|缺陷|报错|README|package\.json|src\/)/i.test(text) ||
    /\b[\w./-]+\.(?:ts|tsx|js|jsx|css|scss|html|json|md|py|go|rs|java|yaml|yml)\b/i.test(text) ||
    /(?:实现|修复|新增|删除|重构|创建|写入|代码变更)/i.test(text) ||
    /\b(?:fix|implement|refactor|create|write|rename)\b/i.test(text)
  );
}

function explicitlyNeedsNoChanges(message: string): boolean {
  return /(?:no_changes_needed|无需修改|不需要修改|没有代码变更|no file changes? needed)/i.test(
    message
  );
}

export type RunWithConversationInput = {
  workspaceId: string;
  agentId: string;
  conversationId?: string;
  message: string;
  resume?: boolean;
  streamId?: string;
  /** When true, skip saving user message and reply to the conversation (used for group chat sub-agents) */
  silent?: boolean;
  mode?: AgentExecutionMode;
  structuredOutput?: boolean;
  workspaceContextId?: string;
  workspaceRootPath?: string;
  executionScope?: ProviderSessionExecutionScope;
  dispatchStepId?: string;
};

export type RunWithConversationResult = RunAgentOutput & {
  conversationId: string;
  usedFallback?: boolean;
};

export async function runAgentWithConversation(
  input: RunWithConversationInput,
  db: AgentHubDatabase = getDatabase(),
  stream?: RunWithConversationStreamSink,
  injectedAdapter?: AgentAdapter | null
): Promise<RunWithConversationResult> {
  // 1. Validate workspace
  const workspace = getWorkspaceById(input.workspaceId, db);
  if (!workspace) {
    throw new Error("Workspace not found.");
  }

  // 2. Validate agent
  const agent = getAgentById(input.agentId, db);
  if (!agent) {
    throw new Error("Agent not found.");
  }
  if (agent.workspaceId !== workspace.id) {
    throw new Error("Agent does not belong to the workspace.");
  }

  // 2a. Route orchestrator agents to runMainAgent
  if (agent.type === "orchestrator") {
    const conversationId = input.conversationId ?? "";
    if (!conversationId) {
      throw new Error("Orchestrator requires an existing conversation.");
    }
    const result = await runMainAgent(
      {
        workspaceId: workspace.id,
        conversationId,
        userMessage: input.message
      },
      db
    );
    return {
      ...result,
      conversationId
    };
  }

  const provider = agent.runtimeProvider;
  const isBuiltin = isBuiltinProvider(provider);
  const executionMode = input.mode ?? "single_chat";
  const executionScope =
    input.executionScope ?? (executionMode === "group_subagent" ? "group_subagent" : "direct");
  const maxIterations =
    executionMode === "group_subagent"
      ? AGENT_EXECUTION_LIMITS.groupSubagentMaxIterations
      : executionMode === "orchestrator_review"
        ? AGENT_EXECUTION_LIMITS.orchestratorReviewMaxIterations
        : AGENT_EXECUTION_LIMITS.singleChatMaxIterations;
  if (provider === "mock" && !injectedAdapter) {
    throw new Error("Resume is not supported for mock runtime.");
  }

  const adapter = injectedAdapter ?? getAdapter(provider);
  if (!adapter) {
    throw new Error(`No adapter for provider: ${provider}`);
  }

  // 3. Find or create conversation
  let conversation: Conversation;
  let isNewConversation = false;

  if (input.conversationId) {
    const found = getConversationById(input.conversationId, db);
    if (!found) {
      throw new ConversationNotFoundError(input.conversationId);
    }
    if (found.workspaceId !== workspace.id) {
      throw new Error("Conversation does not belong to the workspace.");
    }
    if (found.type === "direct" && found.agentId !== agent.id) {
      throw new Error("Conversation does not belong to the agent.");
    }
    if (found.provider && found.provider !== provider) {
      throw new ProviderMismatchError(found.provider, provider);
    }
    // Auto-set provider on old conversations that don't have one
    if (!found.provider) {
      db.prepare("UPDATE conversations SET provider = ? WHERE id = ?")
        .run(provider, found.id);
      found.provider = provider;
    }
    conversation = found;
  } else {
    // Auto-create new conversation
    conversation = createConversation(
      {
        workspaceId: workspace.id,
        agentId: agent.id,
        title: input.message.slice(0, 50) || "New Chat",
        mode: "single",
        provider
      },
      db
    );
    isNewConversation = true;
  }

  const resolvedWorkspace =
    input.workspaceContextId && input.workspaceRootPath
      ? {
          workspaceContextId: input.workspaceContextId,
          rootPath: input.workspaceRootPath,
          gitEnabled: workspace.gitEnabled
        }
      : resolveExecutionWorkspaceForConversation(conversation.id, agent.id, db);
  const executionWorkspace: Workspace = {
    ...workspace,
    rootPath: resolvedWorkspace.rootPath,
    gitEnabled: resolvedWorkspace.gitEnabled
  };

  // 4. Check concurrency lock. Group sub-agents use dispatch-step scope.
  const runningRun = getRunningAgentRunByScope(
    {
      conversationId: conversation.id,
      agentId: agent.id,
      executionScope,
      dispatchStepId: input.dispatchStepId
    },
    db
  );
  if (runningRun) {
    throw new ConversationAlreadyRunningError(conversation.id);
  }

  // 5. Save user message (skip in silent mode for group chat sub-agents)
  if (!input.silent) {
    createMessage(
      {
        workspaceId: workspace.id,
        conversationId: conversation.id,
        senderType: "user",
        senderId: "local-user",
        messageType: "text",
        content: { text: input.message }
      },
      db
    );
  }

  // 6. Determine resume parameters
  const shouldResume = input.resume === true && !isNewConversation && !isBuiltin;
  let providerSessionId: string | undefined;
  let usedFallback = false;

  if (shouldResume) {
    const activeSession = getActiveProviderSession(
      conversation.id,
      {
        agentId: agent.id,
        provider,
        workspaceContextId: resolvedWorkspace.workspaceContextId,
        rootPath: executionWorkspace.rootPath,
        executionScope
      },
      db
    );
    if (activeSession) {
      providerSessionId = activeSession.providerSessionId;
    }
  }

  // 7. Create agent run snapshot
  const agentRun = createAgentRun(
    {
      conversationId: conversation.id,
      workspaceId: workspace.id,
      agentId: agent.id,
      provider,
      providerSessionId,
      rootPath: executionWorkspace.rootPath,
      workspaceContextId: resolvedWorkspace.workspaceContextId,
      executionScope,
      dispatchStepId: input.dispatchStepId,
      systemPromptSnapshot: agent.systemPrompt,
      toolPermissionsSnapshot: formatToolPermissions(agent),
      mode: executionMode,
      maxIterations
    },
    db
  );

  // 8. Build adapter input
  // Resolve provider env from config
  let providerEnv: Record<string, string> | undefined;
  try {
    const resolvedConfig = getResolvedConfig(executionWorkspace.rootPath);
    providerEnv = resolveProviderEnv(agent, resolvedConfig);
  } catch {
    // Config resolution failure is non-fatal; adapter uses defaults
  }

  let adapterInput: AgentRunInput;
  const baseSystemPrompt = buildEffectiveSystemPrompt(
    agent,
    executionMode,
    maxIterations
  );
  const directMemoryContext =
    executionMode === "single_chat"
      ? buildDirectAgentMemoryContext(agent.id, conversation.id, undefined, db)
      : "";
  const effectiveSystemPrompt = [
    baseSystemPrompt,
    directMemoryContext ? `Layered persisted memory:\n${directMemoryContext}` : ""
  ]
    .filter(Boolean)
    .join("\n\n");
  const runOptions: AgentRunOptions = {
    mode: executionMode,
    maxIterations,
    conversationId: conversation.id,
    agentId: agent.id,
    workspaceRoot: executionWorkspace.rootPath,
    prompt: input.message,
    structuredOutput: input.structuredOutput ?? executionMode !== "single_chat",
    ...(executionMode === "group_subagent" && readDebugDisableStreamForSubAgent(executionWorkspace.rootPath)
      ? { disableStream: true }
      : {})
  };

  if (shouldResume && providerSessionId) {
    // Try native resume
    adapterInput = {
      workspaceId: workspace.id,
      conversationId: conversation.id,
      agentId: agent.id,
      provider,
      rootPath: executionWorkspace.rootPath,
      systemPrompt: effectiveSystemPrompt,
      userMessage: input.message,
      toolPermissions: [formatToolPermissions(agent)],
      claudeCodeConfig: agent.claudeCodeConfig,
      env: providerEnv,
      runOptions,
      resume: {
        enabled: true,
        providerSessionId
      }
    };
  } else if (shouldResume && !providerSessionId) {
    // Fallback rebuild - no provider session ID
    usedFallback = true;
    const contextMessages = getContextMessages(
      {
        conversationId: conversation.id,
        currentUserMessage: input.message,
        systemPrompt: effectiveSystemPrompt,
        workspace: executionWorkspace,
        provider
      },
      db
    );

    adapterInput = {
      workspaceId: workspace.id,
      conversationId: conversation.id,
      agentId: agent.id,
      provider,
      rootPath: executionWorkspace.rootPath,
      systemPrompt: buildFallbackPrompt({
        systemPrompt: effectiveSystemPrompt,
        contextMessages,
        userMessage: input.message
      }),
      userMessage: input.message,
      toolPermissions: [formatToolPermissions(agent)],
      claudeCodeConfig: agent.claudeCodeConfig,
      env: providerEnv,
      runOptions,
      resume: {
        enabled: false,
        fallbackRebuild: true
      }
    };
  } else {
    // New session
    adapterInput = {
      workspaceId: workspace.id,
      conversationId: conversation.id,
      agentId: agent.id,
      provider,
      rootPath: executionWorkspace.rootPath,
      systemPrompt: effectiveSystemPrompt,
      userMessage: input.message,
      contextMessages: isBuiltin
        ? getContextMessages(
            {
              conversationId: conversation.id,
              currentUserMessage: input.message,
              systemPrompt: effectiveSystemPrompt,
              workspace: executionWorkspace,
              provider
            },
            db
          )
        : undefined,
      toolPermissions: [formatToolPermissions(agent)],
      claudeCodeConfig: agent.claudeCodeConfig,
      env: providerEnv,
      runOptions,
      resume: { enabled: false }
    };
  }

  // 9. Run adapter with fallback logic
  let finalUsedFallback = usedFallback;
  let agentStatus: "available" | "error" | "unavailable" = "available";
  let replyText = "";
  let replyThinking = "";
  let runError: string | undefined;
  let newProviderSessionId: string | undefined;
  let structuredResult: unknown;
  let diffProposalId: string | undefined;
  let iterationsUsed: number | undefined;
  let runResultStatus: AgentRunResult["status"] = "completed";

  // Set agent to running
  try {
    updateAgentStatusInRepo(agent.id, "running", db);
  } catch {
    // ignore
  }

  try {
    for await (const event of runAdapterWithFallback(
      adapter,
      adapterInput,
      shouldResume,
      providerSessionId,
      conversation,
      executionWorkspace,
      input.message,
      db
    )) {
      // Track if fallback was used from the event stream
      if ("usedFallback" in event && event.usedFallback) {
        finalUsedFallback = true;
      }

      if (event.type === "text_delta") {
        replyText += event.content;
        stream?.({
          type: "text_delta",
          workspaceId: workspace.id,
          conversationId: conversation.id,
          agentId: agent.id,
          text: event.content,
          usedFallback: finalUsedFallback
        });
      } else if (event.type === "reasoning_delta") {
        // Reasoning text is deliberately excluded from `replyText` so it
        // does not pollute the SubAgentResult JSON parse for group chat
        // sub-agents. It is streamed to the UI as a separate channel and
        // accumulated separately so we can persist it to thinking_markdown
        // when the assistant message is created at the end of the run.
        replyThinking += event.content;
        stream?.({
          type: "thinking_delta",
          workspaceId: workspace.id,
          conversationId: conversation.id,
          agentId: agent.id,
          text: event.content
        });
      } else if (event.type === "provider_session") {
        newProviderSessionId = event.providerSessionId;
      } else if (event.type === "structured_result") {
        structuredResult = event.result;
      } else if (event.type === "diff_proposal") {
        if (
          typeof event.proposal === "object" &&
          event.proposal !== null &&
          "id" in event.proposal &&
          typeof event.proposal.id === "string"
        ) {
          diffProposalId = event.proposal.id;
        }
      } else if (event.type === "error") {
        runError = event.message;
        agentStatus = "error";
        runResultStatus = "failed";
      } else if (event.type === "status") {
        iterationsUsed = event.iterationsUsed ?? iterationsUsed;
        if (event.status === "failed") {
          agentStatus = "error";
          runResultStatus = "failed";
        } else if (event.status === "iteration_limit_reached") {
          agentStatus = "error";
          runResultStatus = "iteration_limit_reached";
        } else if (event.status === "waiting_for_permission") {
          runResultStatus = "waiting_for_permission";
        } else if (event.status === "cancelled") {
          runResultStatus = "cancelled";
        }
      }
    }
  } catch (error) {
    runError = error instanceof Error ? error.message : "Agent run failed";
    agentStatus = "error";

    // Check if this was a fallback failure
    if (error instanceof FallbackRebuildFailedError) {
      // Still mark the agent run as failed before re-throwing
      updateAgentRunStatus(agentRun.id, "failed", runError, db);
      throw error;
    }
  } finally {
    // Always mark the agent run as completed/failed so it doesn't block future runs
    const currentRun = db
      .prepare("SELECT status FROM agent_runs WHERE id = ?")
      .get(agentRun.id) as { status: string } | undefined;
    if (currentRun?.status === "running") {
      updateAgentRunStatus(
        agentRun.id,
        runError ? "failed" : runResultStatus,
        runError,
        db,
        iterationsUsed
      );
    }
  }

  const hadExplicitNoChanges = explicitlyNeedsNoChanges(replyText);
  const processedReply = replyText.trim()
    ? await createDiffProposalFromText(
        {
          workspaceId: workspace.id,
          agentId: agent.id,
          conversationId: conversation.id,
          text: replyText,
          dispatchStepId: input.dispatchStepId
        },
        db
      )
    : {
        text: replyText,
        diffProposals: [],
        diffMessages: []
      };
  replyText = processedReply.text;
  if (!diffProposalId && processedReply.diffProposals[0]) {
    diffProposalId = processedReply.diffProposals[0].id;
  }
  updateAgentRunRawOutput(agentRun.id, replyText, db);

  if (
    executionMode === "single_chat" &&
    runResultStatus === "completed" &&
    requestsCodeChanges(input.message) &&
    !diffProposalId &&
    !hadExplicitNoChanges
  ) {
    runResultStatus = "verification_failed";
    runError =
      "Provider finished without a valid DiffProposal or an explicit no_changes_needed result.";
    agentStatus = "error";
    updateAgentRunStatus(agentRun.id, "verification_failed", runError, db, iterationsUsed);
  }

  // If we fell back, mark it
  if (usedFallback || finalUsedFallback) {
    finalUsedFallback = true;
    markAgentRunUsedFallback(agentRun.id, db);
  }

  // 10. Handle provider session ID
  if (newProviderSessionId) {
    // Mark old sessions as replaced
    markActiveSessionsAsReplaced(
      conversation.id,
      {
        agentId: agent.id,
        provider,
        workspaceContextId: resolvedWorkspace.workspaceContextId,
        rootPath: executionWorkspace.rootPath,
        executionScope
      },
      db
    );

    // Create new provider session mapping
    createProviderSession(
      {
        conversationId: conversation.id,
        workspaceId: workspace.id,
        agentId: agent.id,
        provider,
        providerSessionId: newProviderSessionId,
        workspaceContextId: resolvedWorkspace.workspaceContextId,
        rootPath: executionWorkspace.rootPath,
        executionScope
      },
      db
    );

    // Update agent run with the session ID
    updateAgentRunProviderSessionId(agentRun.id, newProviderSessionId, db);
  }

  // 11. Update agent status
  try {
    updateAgentStatusInRepo(agent.id, agentStatus, db);
  } catch {
    // ignore
  }

  // 13. Create reply message (skip saving to conversation in silent mode)
  const messages: Message[] = [];

  messages.push(...processedReply.diffMessages);

  if (replyText.trim()) {
    if (!input.silent) {
      const replyMessage = createMessage(
        {
          workspaceId: workspace.id,
          conversationId: conversation.id,
          senderType: "agent",
          senderId: agent.id,
          messageType: "text",
          content: { text: replyText }
        },
        db
      );
      if (replyThinking.length > 0) {
        appendMessageThinking(replyMessage.id, replyThinking, db);
      }
      messages.push(replyMessage);
    } else {
      // In silent mode, still return the reply text but don't save to conversation
      messages.push({
        id: `silent-${Date.now()}`,
        workspaceId: workspace.id,
        conversationId: conversation.id,
        senderType: "agent",
        senderId: agent.id,
        messageType: "text",
        content: { text: replyText },
        createdAt: new Date().toISOString(),
        status: "completed",
        mentionAgentIds: null,
        dispatchRunId: null,
        dispatchStepId: null,
        replyToMessageId: null,
        updatedAt: null,
        metadata: null
      });
    }
  }

  // 14. Add fallback notice if applicable (skip in silent mode)
  if (finalUsedFallback && !input.silent) {
    const fallbackNotice = createMessage(
      {
        workspaceId: workspace.id,
        conversationId: conversation.id,
        senderType: "system",
        senderId: "agenthub",
        messageType: "text",
        content: {
          text: "底层会话恢复失败，已基于平台历史消息重建上下文并开启新会话。"
        }
      },
      db
    );
    messages.push(fallbackNotice);
  }

  return {
    agent,
    status: agentStatus,
    messages,
    conversationId: conversation.id,
    usedFallback: finalUsedFallback,
    runLog: {
      id: agentRun.id,
      workspaceId: workspace.id,
      agentId: agent.id,
      conversationId: conversation.id,
      provider,
      cwd: executionWorkspace.rootPath,
      status: runError ? "error" : "exited",
      stdout: replyText || undefined,
      createdAt: agentRun.startedAt
    },
    runResult: {
      status: runResultStatus,
      finalMessage: replyText || undefined,
      structuredResult,
      diffProposalId,
      error: runError,
      iterationsUsed
    }
  };
}

async function* runAdapterWithFallback(
  adapter: AgentAdapter,
  input: AgentRunInput,
  shouldResume: boolean,
  providerSessionId: string | undefined,
  conversation: Conversation,
  workspace: Workspace,
  userMessage: string,
  db: AgentHubDatabase
): AsyncIterable<AgentEvent & { usedFallback?: boolean }> {
  try {
    for await (const event of adapter.run(input)) {
      yield event;
    }
    return;
  } catch (error) {
    if (!(error instanceof ResumeFailedError) || !shouldResume) {
      throw error;
    }
    // Resume failed - fall through to fallback
    console.warn(`Resume failed for conversation ${conversation.id}, falling back to rebuild`);
  }

  // Mark old session as failed
  if (providerSessionId) {
    const activeSession = getActiveProviderSession(
      conversation.id,
      {
        agentId: input.agentId,
        provider: input.provider,
        rootPath: input.rootPath
      },
      db
    );
    if (activeSession) {
      updateProviderSessionStatus(
        activeSession.id,
        "failed",
        "Resume failed, falling back to rebuild",
        db
      );
    }
  }

  // Fallback rebuild
  const contextMessages = getContextMessages(
    {
      conversationId: conversation.id,
      currentUserMessage: userMessage,
      systemPrompt: input.systemPrompt,
      workspace,
      provider: input.provider
    },
    db
  );

  const fallbackInput: AgentRunInput = {
    ...input,
    systemPrompt: buildFallbackPrompt({
      systemPrompt: input.systemPrompt,
      contextMessages,
      userMessage
    }),
    resume: { enabled: false, fallbackRebuild: true }
  };

  try {
    for await (const event of adapter.run(fallbackInput)) {
      yield { ...event, usedFallback: true };
    }
  } catch (fallbackError) {
    throw new FallbackRebuildFailedError(
      fallbackError instanceof Error ? fallbackError.message : "Unknown error"
    );
  }
}

// -----------------------------------------------------------------------------
// Unified event pipeline
// -----------------------------------------------------------------------------
//
// The legacy `runAgentWithConversation` (above) drives the provider adapter
// directly and accumulates text in memory. The group chat dispatch depends on
// its structuredResult + diffProposal flow, so we keep it for that caller.
//
// The unified pipeline below drives the new `runStreamingAgent` service and
// exposes the AgentRunEvent protocol to the renderer via IPC. The single-chat
// renderer uses this path; the group chat path keeps the legacy one.

export type RunWithConversationUnifiedInput = Omit<
  RunWithConversationInput,
  "streamId" | "structuredOutput"
> & {
  streamId?: string;
};

export type RunWithConversationUnifiedResult = {
  conversationId: string;
  runId: string;
  assistantMessageId: string;
  status: "completed" | "failed" | "cancelled";
  errorMessage?: string;
  agentId: string;
};

export async function runAgentWithConversationUnified(
  input: RunWithConversationUnifiedInput,
  db: AgentHubDatabase = getDatabase(),
  streamSink?: (event: AgentRunEvent) => void
): Promise<RunWithConversationUnifiedResult> {
  // 1. Validate workspace and agent.
  const workspace = getWorkspaceById(input.workspaceId, db);
  if (!workspace) {
    throw new Error("Workspace not found.");
  }
  const agent = getAgentById(input.agentId, db);
  if (!agent) {
    throw new Error("Agent not found.");
  }
  if (agent.workspaceId !== workspace.id) {
    throw new Error("Agent does not belong to the workspace.");
  }
  if (agent.type === "orchestrator") {
    // Orchestrator agents keep the legacy orchestrator runtime path. The
    // unified pipeline is for specialist (sub-agent) single chat.
    throw new Error(
      "Orchestrator agents must use the legacy runAgentWithConversation path."
    );
  }

  const provider = agent.runtimeProvider;
  const executionMode = input.mode ?? "single_chat";
  const executionScope =
    input.executionScope ??
    (executionMode === "group_subagent" ? "group_subagent" : "direct");
  const maxIterations =
    executionMode === "group_subagent"
      ? AGENT_EXECUTION_LIMITS.groupSubagentMaxIterations
      : executionMode === "orchestrator_review"
        ? AGENT_EXECUTION_LIMITS.orchestratorReviewMaxIterations
        : AGENT_EXECUTION_LIMITS.singleChatMaxIterations;

  // 2. Find or create conversation.
  let conversation: Conversation;
  let isNewConversation = false;
  if (input.conversationId) {
    const found = getConversationById(input.conversationId, db);
    if (!found) {
      throw new ConversationNotFoundError(input.conversationId);
    }
    if (found.workspaceId !== workspace.id) {
      throw new Error("Conversation does not belong to the workspace.");
    }
    if (found.type === "direct" && found.agentId !== agent.id) {
      throw new Error("Conversation does not belong to the agent.");
    }
    if (found.provider && found.provider !== provider) {
      throw new ProviderMismatchError(found.provider, provider);
    }
    if (!found.provider) {
      db.prepare("UPDATE conversations SET provider = ? WHERE id = ?")
        .run(provider, found.id);
      found.provider = provider;
    }
    conversation = found;
  } else {
    conversation = createConversation(
      {
        workspaceId: workspace.id,
        agentId: agent.id,
        title: input.message.slice(0, 50) || "New Chat",
        mode: "single",
        provider
      },
      db
    );
    isNewConversation = true;
  }

  // 3. Resolve execution workspace.
  const resolvedWorkspace =
    input.workspaceContextId && input.workspaceRootPath
      ? {
          workspaceContextId: input.workspaceContextId,
          rootPath: input.workspaceRootPath,
          gitEnabled: workspace.gitEnabled
        }
      : resolveExecutionWorkspaceForConversation(conversation.id, agent.id, db);
  const executionWorkspace: Workspace = {
    ...workspace,
    rootPath: resolvedWorkspace.rootPath,
    gitEnabled: resolvedWorkspace.gitEnabled
  };

  // 4. Build the effective system prompt.
  const baseSystemPrompt = buildEffectiveSystemPrompt(
    agent,
    executionMode,
    maxIterations
  );
  const directMemoryContext =
    executionMode === "single_chat"
      ? buildDirectAgentMemoryContext(agent.id, conversation.id, undefined, db)
      : "";
  const effectiveSystemPrompt = [
    baseSystemPrompt,
    directMemoryContext ? `Layered persisted memory:\n${directMemoryContext}` : ""
  ]
    .filter(Boolean)
    .join("\n\n");

  // 5. Pre-flight: if the conversation is already running, throw the same
  //    ConversationAlreadyRunningError that the legacy path uses. The
  //    streaming service will also check, but doing it up-front lets us
  //    return a clean error before saving the user message.
  try {
    acquireConversationRun({
      conversationId: conversation.id,
      agentId: agent.id,
      db
    }).release("cancelled");
  } catch (error) {
    if (error instanceof ConversationAlreadyRunningError) {
      throw error;
    }
    throw error;
  }

  // 6. Mark agent as running.
  try {
    updateAgentStatusInRepo(agent.id, "running", db);
  } catch {
    // ignore
  }

  // 7. Drive the streaming service.
  let runId = "";
  let assistantMessageId = "";
  let status: "completed" | "failed" | "cancelled" = "completed";
  let errorMessage: string | undefined;
  try {
    for await (const event of runStreamingAgent(
      {
        workspaceId: workspace.id,
        agent,
        conversationId: conversation.id,
        rootPath: executionWorkspace.rootPath,
        workspaceContextId: resolvedWorkspace.workspaceContextId,
        systemPrompt: effectiveSystemPrompt,
        userMessage: input.message,
        executionScope,
        dispatchStepId: input.dispatchStepId,
        maxIterations,
        resume: input.resume,
        silent: input.silent
      },
      db,
      streamSink as StreamingRunSink | undefined
    )) {
      if (!runId) {
        runId = event.runId;
      }
      if (event.type === "message.started" && !assistantMessageId) {
        assistantMessageId = event.payload.messageId;
      }
      if (event.type === "run.completed") {
        status = event.payload.status;
      } else if (event.type === "run.failed") {
        status = "failed";
        errorMessage = event.payload.message;
      }
    }
  } catch (error) {
    status = "failed";
    errorMessage = error instanceof Error ? error.message : "Agent run failed";
  } finally {
    try {
      updateAgentStatusInRepo(
        agent.id,
        status === "failed" ? "error" : "available",
        db
      );
    } catch {
      // ignore
    }
  }

  // The `message.started` event from the unified provider adapter carries
  // a random UUID, NOT the id of the assistant message that the streaming
  // service actually created in the DB. The DB row is the source of
  // truth — always look it up. See `findLatestAgentMessageId`.
  const resolvedAssistantMessageId = findLatestAgentMessageId(conversation.id, db);
  console.info("[AgentHub] runAgentWithConversationUnified: post-processing", {
    conversationId: conversation.id,
    resolvedAssistantMessageId,
    runId,
    status
  });
  if (resolvedAssistantMessageId) {
    try {
      await postProcessStreamingAssistantMessage({
        workspaceId: workspace.id,
        agentId: agent.id,
        conversationId: conversation.id,
        messageId: resolvedAssistantMessageId,
        silent: input.silent ?? false,
        dispatchStepId: input.dispatchStepId,
        db
      });
    } catch (error) {
      console.error("[AgentHub] runAgentWithConversationUnified: postProcess threw", error);
    }
  }

  return {
    conversationId: conversation.id,
    runId: runId || "",
    assistantMessageId,
    status,
    ...(errorMessage ? { errorMessage } : {}),
    agentId: agent.id
  };
}

function findLatestAgentMessageId(
  conversationId: string,
  db: AgentHubDatabase
): string | null {
  const row = db
    .prepare(
      `SELECT id FROM messages
       WHERE conversation_id = ? AND sender_type = 'agent' AND message_type = 'text'
       ORDER BY created_at DESC, id DESC
       LIMIT 1`
    )
    .get(conversationId) as { id: string } | undefined;
  return row?.id ?? null;
}

async function postProcessStreamingAssistantMessage(input: {
  workspaceId: string;
  agentId: string;
  conversationId: string;
  messageId: string;
  silent: boolean;
  dispatchStepId: string | undefined;
  db: AgentHubDatabase;
}): Promise<void> {
  if (input.silent) return;
  const message = getMessageById(input.messageId, input.db);
  if (!message) {
    console.info("[AgentHub] postProcess: no message found", { messageId: input.messageId });
    return;
  }
  const content = message.content;
  if (!content || typeof content !== "object" || !("text" in content)) {
    console.info("[AgentHub] postProcess: message has no text content", { messageId: input.messageId });
    return;
  }
  const rawText = (content as { text?: unknown }).text;
  if (typeof rawText !== "string" || rawText.trim().length === 0) {
    console.info("[AgentHub] postProcess: text empty", { messageId: input.messageId });
    return;
  }

  console.info("[AgentHub] postProcess: starting", {
    conversationId: input.conversationId,
    messageId: input.messageId,
    textLength: rawText.length
  });

  let processed: Awaited<ReturnType<typeof createDiffProposalFromText>>;
  try {
    processed = await createDiffProposalFromText(
      {
        workspaceId: input.workspaceId,
        agentId: input.agentId,
        conversationId: input.conversationId,
        text: rawText,
        dispatchStepId: input.dispatchStepId
      },
      input.db
    );
  } catch (error) {
    console.warn("[AgentHub] postProcess: createDiffProposalFromText threw", error);
    return;
  }

  console.info("[AgentHub] postProcess: parsed", {
    conversationId: input.conversationId,
    proposalsCount: processed.diffProposals.length
  });

  // Strip the SEARCH/REPLACE blocks from the visible message body so the
  // user sees prose + diff cards / preview cards, not raw edit blocks.
  if (processed.text !== rawText) {
    updateMessageContent(input.messageId, { text: processed.text }, input.db);
  }

  // Each HTML DiffProposal already has its own diff_card message with the
  // preview attached (created by createDiffProposal inside
  // createDiffProposalFromText). Nothing more to do here for that path.

  // Fallback: if no DiffProposal produced an HTML preview above, scan the
  // assistant text for raw HTML (LLMs often ignore the SEARCH/REPLACE
  // policy and just dump the HTML body inline). If we find a substantial
  // HTML document, render it as a preview so the user still sees the
  // output. Skip when the text clearly looks like SEARCH/REPLACE output
  // (handled above) or when the LLM is just discussing HTML in prose.
  if (processed.diffProposals.length > 0) return;
  const extraction = extractStandaloneHtml(rawText);
  if (!extraction) {
    console.info("[AgentHub] postProcess: HTML fallback skipped", {
      conversationId: input.conversationId,
      messageId: input.messageId,
      textLength: rawText.length,
      hasHtml: /<[a-zA-Z]/.test(rawText),
      hasFence: /```/.test(rawText),
      hasDoctype: /<!doctype/i.test(rawText)
    });
    return;
  }
  const { html: fallbackHtml, strippedText } = extraction;
  // Route the inline HTML through the same diff_card flow as a real
  // SEARCH/REPLACE block: build a DiffProposal (new file) so the user
  // gets an Apply button identical to the main agent's path. createDiffProposal
  // also creates the diff_card message and attaches the rendered preview to it.
  const fallbackFilePath = "preview.html";
  try {
    const proposal = await createDiffProposal(
      {
        workspaceId: input.workspaceId,
        agentId: input.agentId,
        conversationId: input.conversationId,
        filePath: fallbackFilePath,
        newContent: fallbackHtml,
        isNewFile: true
      },
      input.db
    );
    if (strippedText && strippedText !== rawText) {
      updateMessageContent(
        input.messageId,
        { text: strippedText },
        input.db
      );
    }
    console.info("[AgentHub] postProcess: attached inline-HTML fallback diff_card", {
      conversationId: input.conversationId,
      messageId: input.messageId,
      proposalId: proposal.id,
      filePath: proposal.filePath,
      htmlLength: fallbackHtml.length,
      stripped: strippedText !== rawText
    });
  } catch (error) {
    console.warn(
      "Failed to auto-create fallback HTML DiffProposal:",
      error
    );
  }

  // No DiffProposal, no inline-HTML fallback. If the reply looks like an
  // anticipatory acknowledgment ("I will make it" / "好的我来制作")
  // followed by silence, surface a warning so the user knows the LLM did
  // not actually deliver. The user can then re-prompt explicitly.
  if (looksLikeAnticipatoryReply(rawText)) {
    console.warn(
      "[AgentHub] postProcess: LLM produced an anticipatory acknowledgment without delivering. Reply was:",
      rawText.slice(0, 200)
    );
  }
}

/**
 * Heuristic for "LLM said it would deliver but did not actually produce
 * the deliverable". Matches short Chinese and English phrases that are
 * commonly used as polite confirmations before a (missing) artifact.
 */
function looksLikeAnticipatoryReply(text: string): boolean {
  if (text.length > 400) return false;
  const patterns = [
    /好的[,，].{0,40}(我|让|马上|立刻|这就开始|我这就)/,
    /信息已经充分/,
    /我(将|会|来|马上|立刻|这就).{0,40}(制作|创建|生成|做|为您|给你)/,
    /I('ll| will) (create|make|generate|build|prepare)/i,
    /let me (create|make|generate|build|prepare)/i,
    /sure[,，]? (i('ll| will)|let me)/i
  ];
  return patterns.some((pattern) => pattern.test(text));
}

const HTML_FALLBACK_MIN_LENGTH = 100;
const HTML_FALLBACK_MIN_TAGS = 2;
const HTML_FALLBACK_REQUIRED_OPEN = /<(html|body|head|section|article|main|div|h1|h2|h3|h4|p|table|ul|ol|li|header|footer|nav|figure)\b/i;
const HTML_FALLBACK_TAG_COUNT = /<\/?[a-zA-Z][a-zA-Z0-9-]*\b[^>]*>/g;

/**
 * Detects a substantial standalone HTML document inside the LLM's reply.
 * Returns the HTML body to render and the stripped message text, or null
 * if the text does not look like a real HTML deliverable. Strips
 * surrounding markdown fences if any.
 */
export function extractStandaloneHtml(
  text: string
): { html: string; strippedText: string } | null {
  if (text.length < HTML_FALLBACK_MIN_LENGTH) return null;
  if (!HTML_FALLBACK_REQUIRED_OPEN.test(text)) return null;
  const tagMatches = text.match(HTML_FALLBACK_TAG_COUNT);
  if (!tagMatches || tagMatches.length < HTML_FALLBACK_MIN_TAGS) return null;

  // If wrapped in a fenced code block, extract the body of the first
  // matching fence and strip the fence from the message text. Accept
  // backtick or tilde fences, optional language tag, with or without
  // a trailing newline before the closing fence.
  const fencePatterns = [
    /```[a-zA-Z0-9_+-]*\n([\s\S]*?)\n```/,
    /~~~[a-zA-Z0-9_+-]*\n([\s\S]*?)\n~~~/
  ];
  for (const pattern of fencePatterns) {
    const fenceMatch = text.match(pattern);
    if (!fenceMatch) continue;
    const body = fenceMatch[1];
    if (
      body.length >= HTML_FALLBACK_MIN_LENGTH &&
      HTML_FALLBACK_REQUIRED_OPEN.test(body) &&
      (body.match(HTML_FALLBACK_TAG_COUNT) ?? []).length >= HTML_FALLBACK_MIN_TAGS
    ) {
      const strippedText = (text.slice(0, fenceMatch.index ?? 0) +
        text.slice(
          (fenceMatch.index ?? 0) + fenceMatch[0].length,
          text.length
        ))
        .replace(/\n{3,}/g, "\n\n")
        .trim();
      return { html: body, strippedText: strippedText || "" };
    }
  }
  return { html: text, strippedText: text };
}

export type { AgentRunEvent };
