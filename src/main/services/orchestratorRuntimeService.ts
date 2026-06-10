import type {
  Agent,
  Message,
  RunAgentOutput,
  Workspace
} from "../../shared/domain";
import type {
  AcceptanceCriterion,
  CapabilityMatchResult,
  GroupAgentInfo,
  OrchestratorReview,
  SubTask,
  SubAgentResult
} from "../../shared/groupChat";
import { getDatabase, type AgentHubDatabase } from "../db";
import { getAgentById, getAgentsByWorkspace } from "../db/repositories/agentRepo";
import { getConversationById } from "../db/repositories/conversationRepo";
import {
  getRecentMessagesByConversation
} from "../db/repositories/messageRepo";
import { getWorkspaceById } from "../db/repositories/workspaceRepo";
import { loadMainAgentConfig, ConfigError } from "./configService";
import { listGroupAgents } from "./groupChatService";
import { callLLM, callLLMWithContinuation, callLLMWithToolSupport, LLMError } from "./llmRouter";
import { calculateContextUsage } from "./llmRouter";
import type { MainAgentModelConfig } from "./configService";
import type { ContextUsage } from "../../shared/modelProvider";
import {
  buildMainAgentContextPayload,
  prepareMainAgentContext
} from "./mainAgentContextService";
import type { MainAgentDecision } from "./mainAgentDecision";
import {
  MANUAL_SUB_AGENT_CREATION_GUIDANCE_TEXT,
  parseMainAgentDecision,
  shouldRedirectManualSubAgentCreation
} from "./mainAgentDecision";
import { buildGroupOrchestratorSystemPrompt, buildOrchestratorSystemPrompt } from "./orchestratorSystemPrompt";
import { createDiffProposalFromText } from "./diffProposalTextService";
import type { ChatMessage, LLMToolCall } from "./llmProviderAdapters";
import {
  executeMainAgentFileTool,
  isMainAgentFileTool,
  MAIN_AGENT_FILE_TOOLS,
  type MainAgentFileToolContext
} from "./mainAgentFileTools";
import { resolveExecutionWorkspaceForGroup } from "./workspaceContextResolver";
import { createMessage as insertMessage } from "./messageService";

export type RunMainAgentInput = {
  workspaceId: string;
  conversationId: string;
  userMessage: string;
};

const RECENT_MESSAGE_LIMIT = 20;

function formatMessageForLLM(messages: Message[]): Array<{ role: "user" | "assistant"; content: string }> {
  return messages
    .filter((m) => m.senderType === "user" || m.senderType === "agent")
    .map((m) => ({
      role: m.senderType === "user" ? "user" as const : "assistant" as const,
      content: typeof m.content === "object" && m.content !== null && "text" in m.content
        ? (m.content as { text: string }).text
        : JSON.stringify(m.content)
    }));
}

export function getMainAgentContextUsage(
  input: {
    workspaceId: string;
    conversationId: string;
  },
  db: AgentHubDatabase = getDatabase()
): ContextUsage {
  const workspace = getWorkspaceById(input.workspaceId, db);
  if (!workspace) {
    throw new Error("Workspace not found.");
  }

  const conversation = getConversationById(input.conversationId, db);
  if (!conversation || conversation.workspaceId !== workspace.id) {
    throw new Error("Conversation not found.");
  }

  if (conversation.type === "group") {
    const resolved = resolveExecutionWorkspaceForGroup(conversation.id, db);
    const executionWorkspace = {
      ...workspace,
      rootPath: resolved.rootPath,
      gitEnabled: resolved.gitEnabled
    };
    const recentMessages = getRecentMessagesByConversation(
      conversation.id,
      RECENT_MESSAGE_LIMIT,
      db
    );
    const systemPrompt = buildGroupOrchestratorSystemPrompt(
      executionWorkspace,
      listGroupAgents(conversation.id, db),
      recentMessages
    );

    return calculateContextUsage(
      loadMainAgentConfig(executionWorkspace.rootPath),
      systemPrompt,
      formatMessageForLLM(recentMessages)
    );
  }

  const config = loadMainAgentConfig(workspace.rootPath);
  const systemPrompt = buildOrchestratorSystemPrompt(
    workspace,
    getAgentsByWorkspace(workspace.id, db),
    []
  );

  return buildMainAgentContextPayload(
    {
      conversationId: conversation.id,
      config,
      systemPrompt
    },
    db
  ).usage;
}

const MAX_TOOL_CALL_ITERATIONS = 5;

function buildToolResultBlock(call: LLMToolCall, body: string): string {
  return [
    `Tool result for ${call.name} (${call.id}):`,
    body,
    "",
    "Continue based on this result."
  ].join("\n");
}

async function runMainAgentWithFileTools(
  config: MainAgentModelConfig,
  systemPrompt: string,
  initialMessages: ChatMessage[],
  toolContext: MainAgentFileToolContext,
  db?: AgentHubDatabase
): Promise<string> {
  const messages: ChatMessage[] = [...initialMessages];

  for (let iteration = 1; iteration <= MAX_TOOL_CALL_ITERATIONS; iteration += 1) {
    const response = await callLLMWithToolSupport(
      config,
      systemPrompt,
      messages,
      MAIN_AGENT_FILE_TOOLS
    );

    if (response.toolCalls.length === 0) {
      return response.text;
    }

    messages.push({
      role: "assistant",
      content: response.text.length > 0
        ? response.text
        : `[requested: ${response.toolCalls.map((call) => call.name).join(", ")}]`
    });

    for (const toolCall of response.toolCalls) {
      let body: string;
      if (!isMainAgentFileTool(toolCall.name)) {
        body = `Error: tool "${toolCall.name}" is not available to the main agent.`;
      } else {
        const result = await executeMainAgentFileTool(
          toolCall.name,
          toolCall.arguments,
          toolContext,
          db
        );
        body = result.ok
          ? result.output
          : `Error: ${result.error}`;
      }
      messages.push({
        role: "user",
        content: buildToolResultBlock(toolCall, body)
      });
    }
  }

  // Reached max iterations: ask the LLM to finalize without tools.
  const finalize = await callLLMWithToolSupport(
    config,
    systemPrompt,
    messages,
    []
  );
  return finalize.text;
}

export async function runMainAgent(
  input: RunMainAgentInput,
  db: AgentHubDatabase = getDatabase()
): Promise<RunAgentOutput> {
  const workspace = getWorkspaceById(input.workspaceId, db);
  if (!workspace) {
    throw new Error("Workspace not found.");
  }

  const conversation = getConversationById(input.conversationId, db);
  if (!conversation) {
    throw new Error("Conversation not found.");
  }
  if (conversation.workspaceId !== workspace.id) {
    throw new Error("Conversation does not belong to the workspace.");
  }

  const agent = getAgentById(conversation.agentId, db);
  if (!agent) {
    throw new Error("Agent not found.");
  }
  if (agent.type !== "orchestrator") {
    throw new Error("Agent is not an orchestrator.");
  }

  const messages: Message[] = [];

  // Save user message
  const userMsg = insertMessage(
    {
      workspaceId: workspace.id,
      conversationId: conversation.id,
      senderType: "user",
      senderId: "local-user",
      messageType: "text",
      content: { text: input.userMessage }
    },
    db
  );
  messages.push(userMsg);

  if (shouldRedirectManualSubAgentCreation(input.userMessage)) {
    const replyMsg = insertMessage(
      {
        workspaceId: workspace.id,
        conversationId: conversation.id,
        senderType: "agent",
        senderId: agent.id,
        messageType: "text",
        content: { text: MANUAL_SUB_AGENT_CREATION_GUIDANCE_TEXT }
      },
      db
    );
    messages.push(replyMsg);

    return {
      agent,
      status: "available",
      messages
    };
  }

  const agents = getAgentsByWorkspace(workspace.id, db);

  // Load model config
  let config;
  try {
    config = loadMainAgentConfig(workspace.rootPath);
  } catch (error) {
    const errorMsg = error instanceof ConfigError
      ? error.message
      : "Failed to load model config.";
    const replyMsg = insertMessage(
      {
        workspaceId: workspace.id,
        conversationId: conversation.id,
        senderType: "agent",
        senderId: agent.id,
        messageType: "text",
        content: { text: errorMsg }
      },
      db
    );
    messages.push(replyMsg);
    return { agent, status: "error", messages };
  }

  // Build system prompt and call LLM
  const systemPrompt = buildOrchestratorSystemPrompt(workspace, agents, []);

  let rawLLMOutput: string;
  try {
    const payload = await prepareMainAgentContext(
      {
        conversationId: conversation.id,
        config,
        systemPrompt
      },
      db
    );
    rawLLMOutput = config.toolCalling === "unsupported"
      ? await callLLMWithContinuation(
          config,
          payload.systemPrompt,
          payload.messages
        )
      : await runMainAgentWithFileTools(
          config,
          payload.systemPrompt,
          payload.messages,
          {
            workspaceId: workspace.id,
            conversationId: conversation.id,
            agentId: agent.id
          },
          db
        );
  } catch (error) {
    const errorMsg = error instanceof LLMError
      ? `LLM 调用失败: ${error.message}`
      : "LLM 调用发生未知错误。";
    const replyMsg = insertMessage(
      {
        workspaceId: workspace.id,
        conversationId: conversation.id,
        senderType: "agent",
        senderId: agent.id,
        messageType: "text",
        content: { text: errorMsg }
      },
      db
    );
    messages.push(replyMsg);
    return { agent, status: "error", messages };
  }

  // Parse decision. The parser now falls back to a `direct_answer` with the
  // raw Markdown body whenever the LLM output is not strict JSON, so the
  // `ok: false` branch only fires for empty output.
  const parseResult = parseMainAgentDecision(rawLLMOutput);
  if (!parseResult.ok) {
    const replyMsg = insertMessage(
      {
        workspaceId: workspace.id,
        conversationId: conversation.id,
        senderType: "agent",
        senderId: agent.id,
        messageType: "text",
        content: { text: "（主 Agent 没有返回内容，请重试或换个问法。）" }
      },
      db
    );
    messages.push(replyMsg);
    return { agent, status: "available", messages };
  }

  const { decision } = parseResult;

  // Execute based on intent
  switch (decision.intent) {
    case "direct_answer": {
      const processed = await createDiffProposalFromText(
        {
          workspaceId: workspace.id,
          agentId: agent.id,
          conversationId: conversation.id,
          text: decision.responseText
        },
        db
      );
      for (const diffMessage of processed.diffMessages) {
        messages.push(diffMessage);
      }
      if (processed.text.length > 0) {
        const replyMsg = insertMessage(
          {
            workspaceId: workspace.id,
            conversationId: conversation.id,
            senderType: "agent",
            senderId: agent.id,
            messageType: "text",
            content: { text: processed.text }
          },
          db
        );
        messages.push(replyMsg);
      }
      break;
    }
    case "ask_clarification": {
      const replyMsg = insertMessage(
        {
          workspaceId: workspace.id,
          conversationId: conversation.id,
          senderType: "agent",
          senderId: agent.id,
          messageType: "text",
          content: { text: decision.responseText }
        },
        db
      );
      messages.push(replyMsg);
      break;
    }
  }

  return {
    agent,
    status: "available",
    messages
  };
}

export type RunGroupOrchestratorInput = {
  workspaceId: string;
  conversationId: string;
  userMessage: string;
  mentionAgentIds?: string[];
};

export type GroupOrchestratorResult = {
  decision: MainAgentDecision;
  rawOutput: string;
};

export async function runGroupOrchestratorDecision(
  input: RunGroupOrchestratorInput,
  db: AgentHubDatabase = getDatabase()
): Promise<GroupOrchestratorResult> {
  const workspace = getWorkspaceById(input.workspaceId, db);
  if (!workspace) {
    throw new Error("Workspace not found.");
  }

  const conversation = getConversationById(input.conversationId, db);
  if (!conversation) {
    throw new Error("Conversation not found.");
  }
  if (conversation.type !== "group") {
    throw new Error("Conversation is not a group conversation.");
  }

  if (!workspace.mainAgentId) {
    throw new Error("Workspace has no main agent.");
  }

  const mainAgent = getAgentById(workspace.mainAgentId, db);
  if (!mainAgent) {
    throw new Error("Main agent not found.");
  }
  if (mainAgent.type !== "orchestrator") {
    throw new Error("Main agent is not an orchestrator.");
  }

  // Load group agents
  const groupAgents = listGroupAgents(input.conversationId, db);
  const recentMessages = getRecentMessagesByConversation(input.conversationId, RECENT_MESSAGE_LIMIT, db);

  // Load model config
  const resolved = resolveExecutionWorkspaceForGroup(conversation.id, db);
  const executionWorkspace = {
    ...workspace,
    rootPath: resolved.rootPath,
    gitEnabled: resolved.gitEnabled
  };
  const config = loadMainAgentConfig(executionWorkspace.rootPath);

  // Build group system prompt
  const systemPrompt = buildGroupOrchestratorSystemPrompt(
    executionWorkspace,
    groupAgents,
    recentMessages,
    input.mentionAgentIds
  );

  const llmMessages = formatMessageForLLM(recentMessages);
  const rawOutput = await callLLM(config, systemPrompt, llmMessages);

  // Parse decision
  const parseResult = parseMainAgentDecision(rawOutput);
  if (!parseResult.ok) {
    // Only empty output reaches this branch — the parser otherwise falls
    // back to a Markdown `direct_answer`. Surface a generic empty-reply
    // decision so the caller can still show a message to the user.
    return {
      decision: {
        intent: "direct_answer",
        responseText: "（主 Agent 没有返回内容，请重试或换个问法。）"
      },
      rawOutput
    };
  }

  return { decision: parseResult.decision, rawOutput };
}

export async function runGroupOrchestratorSynthesis(
  input: {
    workspaceId: string;
    conversationId: string;
    userMessage: string;
    criteria: AcceptanceCriterion[];
    review: OrchestratorReview;
    results: SubAgentResult[];
  },
  db: AgentHubDatabase = getDatabase()
): Promise<string> {
  const workspace = getWorkspaceById(input.workspaceId, db);
  if (!workspace) {
    throw new Error("Workspace not found.");
  }

  const conversation = getConversationById(input.conversationId, db);
  if (!conversation || conversation.type !== "group") {
    throw new Error("Group conversation not found.");
  }

  const resolved = resolveExecutionWorkspaceForGroup(conversation.id, db);
  const config = loadMainAgentConfig(resolved.rootPath);
  const systemPrompt = [
    "你是 AgentHub 群聊中的主 Agent。",
    "请基于子 Agent 的成果生成一份直接面向用户的最终答复。",
    "只输出最终答复正文，不要输出 JSON、内部审核记录、acceptance criteria、criterion ID、dispatch 状态、迭代预算或 Agent 执行日志。",
    "保留对用户有帮助的事实、建议、限制和必要风险，不要编造子 Agent 未提供的信息。",
    "如果任务只部分完成，清楚说明仍缺少什么以及用户需要补充什么。",
    "",
    "IMPORTANT: Output ONLY the final user-facing answer directly. Do NOT include any chain-of-thought, self-review, planning notes, restatement of constraints, English-language reasoning, checklist items, or meta-commentary. Stream the answer in the user's language without preamble."
  ].join("\n");
  const resultText = input.results
    .map((result, index) => [
      `子 Agent 成果 ${index + 1}:`,
      `状态: ${result.status}`,
      `摘要: ${result.summary}`,
      result.completedCriteria.length > 0
        ? `完成验收项: ${result.completedCriteria.join("，")}`
        : "",
      result.unresolvedCriteria.length > 0
        ? `未完成验收项: ${result.unresolvedCriteria.join("，")}`
        : "",
      result.artifactIds && result.artifactIds.length > 0
        ? `产物 artifactIds: ${result.artifactIds.join("，")}`
        : "",
      result.outputs && result.outputs.length > 0
        ? `产物预览: ${result.outputs
            .map((output) =>
              [
                output.type,
                output.artifactId ? `artifact=${output.artifactId}` : "",
                output.diffProposalId ? `diff=${output.diffProposalId}` : "",
                output.preview ? output.preview : ""
              ]
                .filter(Boolean)
                .join(" ")
            )
            .join("；")}`
        : "",
      result.evidence && result.evidence.length > 0
        ? `验收证据: ${result.evidence
            .map((item) => `${item.criterionId}: ${item.summary}`)
            .join("；")}`
        : "",
      result.assumptions.length > 0
        ? `假设: ${result.assumptions.join("；")}`
        : "",
      result.risks.length > 0 ? `风险: ${result.risks.join("；")}` : ""
    ].filter(Boolean).join("\n"))
    .join("\n\n");
  const criteriaText = input.criteria
    .map((criterion) => `- ${criterion.description}: ${criterion.status}`)
    .join("\n");

  return callLLMWithContinuation(config, systemPrompt, [
    {
      role: "user",
      content: [
        `用户原始请求:\n${input.userMessage}`,
        `\n内部完成情况: ${input.review.decision}`,
        `\n验收项:\n${criteriaText}`,
        `\n子 Agent 成果:\n${resultText || "无可用成果"}`
      ].join("\n")
    }
  ]);
}

function clampScore(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return 0;
  }
  return Math.max(0, Math.min(1, value));
}

function parseCapabilityMatchResults(
  rawOutput: string,
  taskId: string,
  candidateAgentIds: Set<string>
): CapabilityMatchResult[] {
  const json = rawOutput.match(/\[[\s\S]*\]/)?.[0] ?? rawOutput.match(/\{[\s\S]*\}/)?.[0];
  if (!json) {
    return [];
  }

  const parsed = JSON.parse(json) as unknown;
  const items = Array.isArray(parsed)
    ? parsed
    : typeof parsed === "object" && parsed !== null && "results" in parsed
      ? (parsed as { results?: unknown }).results
      : [];

  if (!Array.isArray(items)) {
    return [];
  }

  return items
    .map((item): CapabilityMatchResult | null => {
      if (!item || typeof item !== "object" || Array.isArray(item)) {
        return null;
      }
      const record = item as Record<string, unknown>;
      const agentId = typeof record.agentId === "string" ? record.agentId : "";
      if (!candidateAgentIds.has(agentId)) {
        return null;
      }
      const matchedSkills = Array.isArray(record.matchedSkills)
        ? record.matchedSkills
            .map((skill): CapabilityMatchResult["matchedSkills"][number] | null => {
              if (!skill || typeof skill !== "object" || Array.isArray(skill)) {
                return null;
              }
              const skillRecord = skill as Record<string, unknown>;
              return {
                skillName:
                  typeof skillRecord.skillName === "string"
                    ? skillRecord.skillName
                    : "unknown",
                relevance: clampScore(skillRecord.relevance),
                reason:
                  typeof skillRecord.reason === "string" ? skillRecord.reason : ""
              };
            })
            .filter((skill): skill is CapabilityMatchResult["matchedSkills"][number] => skill !== null)
        : [];

      return {
        agentId,
        taskId,
        capabilityMatch: clampScore(record.capabilityMatch),
        confidence: clampScore(record.confidence),
        matchedSkills,
        missingSkills: Array.isArray(record.missingSkills)
          ? record.missingSkills.filter((skill): skill is string => typeof skill === "string")
          : [],
        reason: typeof record.reason === "string" ? record.reason : ""
      };
    })
    .filter((item): item is CapabilityMatchResult => item !== null);
}

export async function runGroupCapabilityMatchJudge(
  input: {
    workspaceId: string;
    conversationId: string;
    userMessage: string;
    subTask: SubTask;
    candidates: Array<{
      agentId: string;
      name: string;
      capabilities: string[];
    }>;
  },
  db: AgentHubDatabase = getDatabase()
): Promise<CapabilityMatchResult[]> {
  if (input.candidates.length === 0) {
    return [];
  }

  const workspace = getWorkspaceById(input.workspaceId, db);
  if (!workspace) {
    throw new Error("Workspace not found.");
  }

  const conversation = getConversationById(input.conversationId, db);
  if (!conversation || conversation.type !== "group") {
    throw new Error("Conversation is not a group conversation.");
  }

  const resolved = resolveExecutionWorkspaceForGroup(conversation.id, db);
  const config = loadMainAgentConfig(resolved.rootPath);
  const candidateAgentIds = new Set(input.candidates.map((candidate) => candidate.agentId));
  const raw = await callLLM(
    config,
    [
      "You judge only semantic capability fit between one AgentHub SubTask and candidate Agent skills.",
      "Do not decide the final assignment. Do not score tools, permissions, history, recency, cost, or schedule.",
      "Return compact JSON only: {\"results\":[{\"agentId\":\"...\",\"capabilityMatch\":0-1,\"confidence\":0-1,\"matchedSkills\":[{\"skillName\":\"...\",\"relevance\":0-1,\"reason\":\"...\"}],\"missingSkills\":[\"...\"],\"reason\":\"...\"}]}",
      "Use this scale: 0.90-1.00 highly matched; 0.75-0.89 strong; 0.60-0.74 moderate; 0.40-0.59 weak; 0.20-0.39 very weak; 0.00-0.19 no real match."
    ].join("\n"),
    [
      {
        role: "user",
        content: JSON.stringify({
          userMessage: input.userMessage,
          subTask: input.subTask,
          candidates: input.candidates
        })
      }
    ]
  );

  return parseCapabilityMatchResults(raw, input.subTask.id, candidateAgentIds);
}
