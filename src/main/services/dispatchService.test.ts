import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { RunWithConversationInput } from "./agentRunWithConversationService";
import { closeDatabase, initializeDatabase, type AgentHubDatabase } from "../db";
import { createAgent } from "../db/repositories/agentRepo";
import { getArtifactsByConversation } from "../db/repositories/artifactRepo";
import { getGroupRunEventsByConversation } from "../db/repositories/groupRunEventRepo";
import { createWorkspace, updateWorkspace } from "../db/repositories/workspaceRepo";
import { createConversation } from "../db/repositories/conversationRepo";
import { createMessage } from "./messageService";
import { createGroupConversation, addAgentMembers } from "./groupChatService";
import { dispatchGroupTasks, handleGroupUserMessage } from "./dispatchService";
import { createArtifact } from "./artifactService";
import { getArtifactsByConversation as getMessageArtifactsByConversation } from "../db/repositories/messageArtifactRepo";

vi.mock("./agentRunWithConversationService", () => ({
  runAgentWithConversation: vi.fn()
}));

vi.mock("./orchestratorRuntimeService", () => ({
  runGroupOrchestratorDecision: vi.fn(),
  runGroupCapabilityMatchJudge: vi.fn(),
  runGroupOrchestratorSynthesis: vi.fn(async () => "最终总结")
}));

vi.mock("./agentProjectExperienceService", () => ({
  updateExperiencesAfterGroupDispatch: vi.fn()
}));

let tempDir: string | null = null;

function initializeTempDatabase(): AgentHubDatabase {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "agenthub-dispatch-"));
  return initializeDatabase({ dbPath: path.join(tempDir, "agenthub.db") });
}

function createTestWorkspace(db: AgentHubDatabase) {
  const workspace = createWorkspace(
    {
      name: "Dispatch Test",
      rootPath: path.join(tempDir!, "workspace"),
      gitEnabled: false
    },
    db
  );
  const mainAgent = createAgent(
    {
      workspaceId: workspace.id,
      name: "Main Agent",
      role: "main",
      type: "orchestrator",
      runtimeProvider: "builtin_openai",
      status: "available"
    },
    db
  );
  updateWorkspace(workspace.id, { mainAgentId: mainAgent.id }, db);
  const firstAgent = createAgent(
    {
      workspaceId: workspace.id,
      name: "First Agent",
      role: "sub",
      type: "specialist",
      runtimeProvider: "codex_local",
      status: "available"
    },
    db
  );
  const secondAgent = createAgent(
    {
      workspaceId: workspace.id,
      name: "Second Agent",
      role: "sub",
      type: "specialist",
      runtimeProvider: "codex_local",
      status: "available"
    },
    db
  );

  return { workspace, firstAgent, secondAgent };
}

function createSilentAgentReply(input: RunWithConversationInput, rawText: string) {
  const now = new Date().toISOString();

  return {
    agent: null,
    status: "available" as const,
    conversationId: input.conversationId!,
    messages: [
      {
        id: `silent-${input.agentId}`,
        workspaceId: input.workspaceId,
        conversationId: input.conversationId!,
        senderType: "agent" as const,
        senderId: input.agentId,
        messageType: "text" as const,
        content: { text: rawText },
        createdAt: now,
        status: "completed" as const,
        mentionAgentIds: null,
        dispatchRunId: null,
        dispatchStepId: null,
        replyToMessageId: null,
        updatedAt: null,
        metadata: null
      }
    ],
    runLog: {
      id: `run-${input.agentId}`,
      workspaceId: input.workspaceId,
      agentId: input.agentId,
      conversationId: input.conversationId!,
      provider: "codex_local" as const,
      cwd: tempDir!,
      status: "exited" as const,
      stdout: rawText,
      createdAt: now
    },
    runResult: {
      status: rawText.includes('"status":"failed"') ? "failed" as const : "completed" as const,
      finalMessage: rawText
    }
  };
}

afterEach(() => {
  closeDatabase();
  vi.clearAllMocks();

  if (tempDir) {
    fs.rmSync(tempDir, { recursive: true, force: true });
    tempDir = null;
  }
});

describe("handleGroupUserMessage explicit @ dispatch", () => {
  it("locks the candidate pool to explicitly mentioned agents", async () => {
    const db = initializeTempDatabase();
    const { workspace, firstAgent, secondAgent } = createTestWorkspace(db);
    const { conversation } = createGroupConversation(
      {
        workspaceId: workspace.id,
        title: "Dispatch Room",
        memberAgentIds: [firstAgent.id, secondAgent.id]
      },
      db
    );
    addAgentMembers(
      {
        groupConversationId: conversation.id,
        agentIds: [firstAgent.id, secondAgent.id]
      },
      db
    );

    const { runGroupOrchestratorDecision, runGroupCapabilityMatchJudge } = await import(
      "./orchestratorRuntimeService"
    );
    vi.mocked(runGroupOrchestratorDecision).mockResolvedValueOnce({
      rawOutput: "",
      decision: {
        intent: "dispatch_agents",
        responseText: "按显式 @ 候选池分派。",
        acceptanceCriteria: [
          {
            id: "criterion-1",
            description: "完成显式 @ 任务",
            type: "analysis",
            required: true,
            status: "pending"
          }
        ],
        plan: {
          executionMode: "dag",
          steps: [],
          subTasks: [
            {
              id: "task-1",
              title: "只允许被 @ Agent 执行",
              objective: "分析实现方案",
              acceptanceCriteria: ["criterion-1"],
              requiredSkillQueries: ["backend architecture"],
              requiredTools: ["read_file"],
              taskType: "analysis",
              dependsOn: [],
              riskLevel: "low",
              expectedOutputType: "analysis"
            }
          ]
        }
      }
    });
    vi.mocked(runGroupCapabilityMatchJudge).mockImplementationOnce(async (input) => {
      expect(input.candidates.map((candidate) => candidate.agentId)).toEqual([
        firstAgent.id
      ]);
      return [
        {
          agentId: firstAgent.id,
          taskId: "task-1",
          capabilityMatch: 0.4,
          confidence: 0.9,
          matchedSkills: [
            {
              skillName: "general analysis",
              relevance: 0.4,
              reason: "显式候选池内的可用 Agent"
            }
          ],
          missingSkills: ["backend architecture"],
          reason: "低分但用户显式指定候选池。"
        }
      ];
    });

    const { runAgentWithConversation } = await import("./agentRunWithConversationService");
    vi.mocked(runAgentWithConversation).mockImplementationOnce(async (input) => {
      expect(input.agentId).toBe(firstAgent.id);
      return createSilentAgentReply(
        input,
        JSON.stringify({
          status: "completed",
          summary: "显式 @ Agent 已执行。",
          completedCriteria: ["criterion-1"],
          unresolvedCriteria: [],
          filesRead: [],
          assumptions: [],
          risks: []
        })
      );
    });

    const result = await handleGroupUserMessage(
      conversation.id,
      "请指定 Agent 分析实现方案",
      [firstAgent.id],
      db
    );

    expect(result.dispatchRun.mode).toBe("mention");
    expect(result.dispatchSteps).toHaveLength(1);
    expect(result.dispatchSteps[0].agentId).toBe(firstAgent.id);
    expect(runAgentWithConversation).toHaveBeenCalledTimes(1);
    expect(runGroupCapabilityMatchJudge).toHaveBeenCalledTimes(1);
    expect(
      result.allMessages?.find((message) => message.messageType === "dispatch_plan")?.metadata
    ).toMatchObject({
      assignments: [
        {
          agentId: firstAgent.id,
          score: {
            capabilityMatch: 0.4
          }
        }
      ]
    });
  });

  it("blocks explicit @ dispatch when the mentioned agent fails hard filtering", async () => {
    const db = initializeTempDatabase();
    const { workspace, firstAgent } = createTestWorkspace(db);
    const noDiffAgent = createAgent(
      {
        workspaceId: workspace.id,
        name: "No Diff Agent",
        role: "sub",
        type: "specialist",
        runtimeProvider: "codex_local",
        tools: { writeDiff: false },
        status: "available"
      },
      db
    );
    const { conversation } = createGroupConversation(
      {
        workspaceId: workspace.id,
        title: "Dispatch Room",
        memberAgentIds: [firstAgent.id, noDiffAgent.id]
      },
      db
    );
    addAgentMembers(
      {
        groupConversationId: conversation.id,
        agentIds: [firstAgent.id, noDiffAgent.id]
      },
      db
    );

    const { runGroupOrchestratorDecision, runGroupCapabilityMatchJudge } = await import(
      "./orchestratorRuntimeService"
    );
    vi.mocked(runGroupOrchestratorDecision).mockResolvedValueOnce({
      rawOutput: "",
      decision: {
        intent: "dispatch_agents",
        responseText: "准备生成 diff。",
        acceptanceCriteria: [
          {
            id: "criterion-1",
            description: "生成 DiffProposal",
            type: "code_change",
            required: true,
            status: "pending"
          }
        ],
        plan: {
          executionMode: "dag",
          steps: [],
          subTasks: [
            {
              id: "task-1",
              title: "修改代码",
              objective: "生成 DiffProposal",
              acceptanceCriteria: ["criterion-1"],
              requiredSkillQueries: ["code change"],
              requiredTools: ["read_file", "write_diff"],
              taskType: "code_change",
              targetFiles: ["src/App.tsx"],
              dependsOn: [],
              riskLevel: "medium",
              expectedOutputType: "diff_proposal"
            }
          ]
        }
      }
    });

    const { runAgentWithConversation } = await import("./agentRunWithConversationService");
    const result = await handleGroupUserMessage(
      conversation.id,
      "请生成代码修改",
      [noDiffAgent.id],
      db
    );

    expect(result.dispatchRun.mode).toBe("mention");
    expect(result.dispatchRun.status).toBe("failed");
    expect(result.dispatchSteps).toHaveLength(0);
    expect(runAgentWithConversation).not.toHaveBeenCalled();
    expect(runGroupCapabilityMatchJudge).not.toHaveBeenCalled();
    expect(
      result.allMessages?.some((message) =>
        JSON.stringify(message.content).includes("不会 fallback")
      )
    ).toBe(true);
  });
});

describe("dispatchGroupTasks", () => {
  it("passes a scoped SubAgentTaskInput instead of unrelated group history", async () => {
    const db = initializeTempDatabase();
    const { workspace, firstAgent } = createTestWorkspace(db);
    const { conversation } = createGroupConversation(
      {
        workspaceId: workspace.id,
        title: "Dispatch Room",
        memberAgentIds: [firstAgent.id]
      },
      db
    );
    addAgentMembers(
      {
        groupConversationId: conversation.id,
        agentIds: [firstAgent.id]
      },
      db
    );
    createMessage(
      {
        workspaceId: conversation.workspaceId,
        conversationId: conversation.id,
        senderType: "user",
        senderId: "local-user",
        messageType: "text",
        content: { text: "SECRET_IRRELEVANT_GROUP_HISTORY" }
      },
      db
    );
    const userMessage = createMessage(
      {
        workspaceId: conversation.workspaceId,
        conversationId: conversation.id,
        senderType: "user",
        senderId: "local-user",
        messageType: "text",
        content: { text: "请检查 src/App.tsx 的按钮状态" }
      },
      db
    );
    const { runAgentWithConversation } = await import("./agentRunWithConversationService");

    vi.mocked(runAgentWithConversation).mockImplementationOnce(async (input) => {
      expect(input.resume).toBe(false);
      expect(input.message).toContain("SubAgentTaskInput JSON");
      expect(input.message).toContain("请检查 src/App.tsx 的按钮状态");
      expect(input.message).toContain("只检查按钮状态");
      expect(input.message).not.toContain("SECRET_IRRELEVANT_GROUP_HISTORY");

      return createSilentAgentReply(
        input,
        JSON.stringify({
          status: "completed",
          summary: "已完成按钮状态检查。",
          completedCriteria: ["criterion-1"],
          unresolvedCriteria: [],
          filesRead: ["src/App.tsx"],
          assumptions: [],
          risks: []
        })
      );
    });

    const result = await dispatchGroupTasks(
      {
        conversationId: conversation.id,
        userMessageId: userMessage.id,
        assignments: [
          {
            agentId: firstAgent.id,
            task: "只检查按钮状态",
            reason: "测试上下文裁剪",
            order: 0
          }
        ]
      },
      db
    );

    expect(runAgentWithConversation).toHaveBeenCalledTimes(1);
    const snapshot = result.dispatchSteps[0].inputContextSnapshot;
    expect(snapshot).toMatchObject({
      schemaVersion: 1,
      dispatchRunId: result.dispatchRun.id,
      dispatchStepId: result.dispatchSteps[0].id,
      parentMessageId: userMessage.id,
      userGoal: "请检查 src/App.tsx 的按钮状态",
      assignedInstruction: "只检查按钮状态",
      expectedOutput: { format: "sub_agent_result_json" }
    });
    expect(snapshot?.relevantContext.selectedMessages).toEqual([
      expect.objectContaining({
        id: userMessage.id,
        text: "请检查 src/App.tsx 的按钮状态",
        reason: "本轮用户原始需求"
      })
    ]);
    expect(JSON.stringify(snapshot)).not.toContain("SECRET_IRRELEVANT_GROUP_HISTORY");
  });

  it("runs group sub-agents in a fresh step conversation instead of an old private chat", async () => {
    const db = initializeTempDatabase();
    const { workspace, firstAgent } = createTestWorkspace(db);
    const oldPrivateConversation = createConversation(
      {
        workspaceId: workspace.id,
        workspaceContextId: null,
        agentId: firstAgent.id,
        title: "Old private chat",
        mode: "single",
        provider: firstAgent.runtimeProvider
      },
      db
    );
    createMessage(
      {
        workspaceId: workspace.id,
        conversationId: oldPrivateConversation.id,
        senderType: "user",
        senderId: "local-user",
        messageType: "text",
        content: { text: "SECRET_PRIVATE_CONTEXT_SHOULD_NOT_RESUME" }
      },
      db
    );
    const { conversation } = createGroupConversation(
      {
        workspaceId: workspace.id,
        title: "Dispatch Room",
        memberAgentIds: [firstAgent.id]
      },
      db
    );
    addAgentMembers(
      {
        groupConversationId: conversation.id,
        agentIds: [firstAgent.id]
      },
      db
    );
    const userMessage = createMessage(
      {
        workspaceId: conversation.workspaceId,
        conversationId: conversation.id,
        senderType: "user",
        senderId: "local-user",
        messageType: "text",
        content: { text: "请检查按钮状态" }
      },
      db
    );
    const { runAgentWithConversation } = await import("./agentRunWithConversationService");

    vi.mocked(runAgentWithConversation).mockImplementationOnce(async (input) => {
      expect(input.conversationId).toBeTruthy();
      expect(input.conversationId).not.toBe(oldPrivateConversation.id);
      expect(input.resume).toBe(false);
      expect(input.message).not.toContain("SECRET_PRIVATE_CONTEXT_SHOULD_NOT_RESUME");

      return createSilentAgentReply(
        input,
        JSON.stringify({
          status: "completed",
          summary: "按钮状态检查已完成。",
          completedCriteria: ["criterion-1"],
          unresolvedCriteria: [],
          filesRead: [],
          assumptions: [],
          risks: []
        })
      );
    });

    const result = await dispatchGroupTasks(
      {
        conversationId: conversation.id,
        userMessageId: userMessage.id,
        assignments: [
          {
            agentId: firstAgent.id,
            task: "检查按钮状态",
            reason: "测试隔离会话",
            order: 0
          }
        ]
      },
      db
    );

    expect(runAgentWithConversation).toHaveBeenCalledTimes(1);
    expect(result.dispatchRun.status).toBe("completed");
  });

  it("does not pass failed or partial sub-agent outputs into dependent steps", async () => {
    const db = initializeTempDatabase();
    const { workspace, firstAgent, secondAgent } = createTestWorkspace(db);
    const { conversation } = createGroupConversation(
      {
        workspaceId: workspace.id,
        title: "Dispatch Room",
        memberAgentIds: [firstAgent.id, secondAgent.id]
      },
      db
    );
    addAgentMembers(
      {
        groupConversationId: conversation.id,
        agentIds: [firstAgent.id, secondAgent.id]
      },
      db
    );

    const { runGroupOrchestratorDecision, runGroupCapabilityMatchJudge } = await import(
      "./orchestratorRuntimeService"
    );
    vi.mocked(runGroupOrchestratorDecision).mockResolvedValueOnce({
      rawOutput: "",
      decision: {
        intent: "dispatch_agents",
        responseText: "按依赖顺序分派。",
        acceptanceCriteria: [
          {
            id: "criterion-1",
            description: "完成第一步",
            type: "analysis",
            required: true,
            status: "pending"
          },
          {
            id: "criterion-2",
            description: "完成第二步",
            type: "analysis",
            required: true,
            status: "pending"
          }
        ],
        plan: {
          executionMode: "dag",
          steps: [],
          subTasks: [
            {
              id: "task-1",
              title: "收集数据",
              objective: "收集竞品数据",
              acceptanceCriteria: ["criterion-1"],
              requiredSkillQueries: ["research"],
              requiredTools: ["read_file"],
              taskType: "analysis",
              dependsOn: [],
              riskLevel: "low",
              expectedOutputType: "analysis"
            },
            {
              id: "task-2",
              title: "撰写报告",
              objective: "基于合格数据撰写报告",
              acceptanceCriteria: ["criterion-2"],
              requiredSkillQueries: ["report writing"],
              requiredTools: ["read_file"],
              taskType: "analysis",
              dependsOn: ["task-1"],
              riskLevel: "low",
              expectedOutputType: "analysis"
            }
          ]
        }
      }
    });
    vi.mocked(runGroupCapabilityMatchJudge).mockImplementation(async (input) => {
      const firstScore = input.subTask.id === "task-1" ? 0.95 : 0.2;
      const secondScore = input.subTask.id === "task-2" ? 0.95 : 0.2;
      return [
        {
          agentId: firstAgent.id,
          taskId: input.subTask.id,
          capabilityMatch: firstScore,
          confidence: 0.9,
          matchedSkills: [],
          missingSkills: [],
          reason: "测试评分"
        },
        {
          agentId: secondAgent.id,
          taskId: input.subTask.id,
          capabilityMatch: secondScore,
          confidence: 0.9,
          matchedSkills: [],
          missingSkills: [],
          reason: "测试评分"
        }
      ];
    });

    const { runAgentWithConversation } = await import("./agentRunWithConversationService");
    vi.mocked(runAgentWithConversation).mockImplementation(async (input) => {
      if (input.agentId === secondAgent.id) {
        expect(input.message).not.toContain("SECRET_BAD_PARTIAL_OUTPUT");
      }
      const rawText =
        input.agentId === firstAgent.id
          ? JSON.stringify({
              status: "partial",
              summary: "SECRET_BAD_PARTIAL_OUTPUT",
              completedCriteria: [],
              unresolvedCriteria: ["criterion-1"],
              filesRead: [],
              assumptions: [],
              risks: ["模拟 partial"]
            })
          : JSON.stringify({
              status: "completed",
              summary: "第二步完成。",
              completedCriteria: ["criterion-2"],
              unresolvedCriteria: [],
              filesRead: [],
              assumptions: [],
              risks: []
            });

      return createSilentAgentReply(input, rawText);
    });

    const result = await handleGroupUserMessage(
      conversation.id,
      "请按依赖完成竞品分析",
      [],
      db
    );

    expect(runAgentWithConversation).toHaveBeenCalledWith(
      expect.objectContaining({
        agentId: secondAgent.id
      }),
      db,
      expect.any(Function)
    );
    expect(result.dispatchRun.status).toBe("partial_failed");
  });

  it("copies sub-agent HTML artifacts into the group conversation and attaches a preview", async () => {
    const db = initializeTempDatabase();
    const { workspace, firstAgent } = createTestWorkspace(db);
    const { conversation } = createGroupConversation(
      {
        workspaceId: workspace.id,
        title: "Dispatch Room",
        memberAgentIds: [firstAgent.id]
      },
      db
    );
    addAgentMembers(
      {
        groupConversationId: conversation.id,
        agentIds: [firstAgent.id]
      },
      db
    );
    const agentConversation = createConversation(
      {
        workspaceId: workspace.id,
        agentId: firstAgent.id,
        title: "Private Agent Chat",
        mode: "single",
        provider: firstAgent.runtimeProvider
      },
      db
    );
    const privateArtifact = createArtifact(
      {
        workspaceId: workspace.id,
        conversationId: agentConversation.id,
        agentId: firstAgent.id,
        type: "html",
        title: "竞品分析 PPT",
        content: [
          "<!doctype html><html><body>",
          "<section class='slide'><h1>竞品分析 PPT</h1><p>封面：LangChain / AutoGen / CrewAI 框架对比。</p></section>",
          "<section class='slide'><h2>目录</h2><p>框架定位、架构差异、能力矩阵、使用场景、选型建议。</p></section>",
          "<section class='slide'><h2>LangChain</h2><p>强调 LangGraph、工具生态、RAG 集成和生产级状态管理。</p></section>",
          "<section class='slide'><h2>AutoGen</h2><p>强调多 Agent 对话、代码执行、人工介入和 Microsoft 生态。</p></section>",
          "<section class='slide'><h2>CrewAI</h2><p>强调角色化协作、快速原型、业务任务编排和易读配置。</p></section>",
          "<section class='slide'><h2>结论</h2><p>复杂生产工作流优先 LangGraph，对话协作优先 AutoGen，角色化业务流优先 CrewAI。</p></section>",
          "</body></html>"
        ].join("\n"),
        language: "html"
      },
      db
    );
    const userMessage = createMessage(
      {
        workspaceId: conversation.workspaceId,
        conversationId: conversation.id,
        senderType: "user",
        senderId: "local-user",
        messageType: "text",
        content: { text: "请生成 PPT" }
      },
      db
    );
    const { runAgentWithConversation } = await import("./agentRunWithConversationService");

    vi.mocked(runAgentWithConversation).mockImplementationOnce(async (input) => {
      expect(input.artifactTarget).toMatchObject({
        workspaceId: conversation.workspaceId,
        conversationId: conversation.id,
        dispatchStepId: expect.any(String)
      });

      return createSilentAgentReply(
        input,
        JSON.stringify({
          status: "completed",
          summary: "HTML PPT 已生成。",
          completedCriteria: ["criterion-1"],
          unresolvedCriteria: [],
          artifactIds: [privateArtifact.id],
          outputs: [
            {
              type: "html",
              artifactId: privateArtifact.id,
              preview: "HTML PPT",
              isComplete: true
            }
          ],
          evidence: [
            {
              criterionId: "criterion-1",
              artifactId: privateArtifact.id,
              summary: "HTML 幻灯片覆盖了用户要求。"
            }
          ],
          filesRead: [],
          assumptions: [],
          risks: []
        })
      );
    });

    const result = await dispatchGroupTasks(
      {
        conversationId: conversation.id,
        userMessageId: userMessage.id,
        assignments: [
          {
            agentId: firstAgent.id,
            task: "生成 PPT",
            reason: "测试 HTML artifact 归属",
            order: 0
          }
        ]
      },
      db
    );

    const groupArtifacts = getArtifactsByConversation(conversation.id, db);
    const copiedHtmlArtifact = groupArtifacts.find(
      (artifact) => artifact.type === "html" && artifact.title === "竞品分析 PPT"
    );
    expect(copiedHtmlArtifact).toBeDefined();
    expect(copiedHtmlArtifact?.id).not.toBe(privateArtifact.id);
    expect(copiedHtmlArtifact?.conversationId).toBe(conversation.id);

    expect(result.dispatchSteps[0].subAgentResult).toMatchObject({
      artifactIds: [copiedHtmlArtifact!.id],
      outputs: [
        {
          type: "html",
          artifactId: copiedHtmlArtifact!.id
        }
      ],
      evidence: [
        {
          criterionId: "criterion-1",
          artifactId: copiedHtmlArtifact!.id
        }
      ]
    });

    const assignmentMessage = result.allMessages?.find(
      (message) => message.messageType === "agent_assignment"
    );
    expect(assignmentMessage?.metadata).toMatchObject({
      artifactIds: [copiedHtmlArtifact!.id],
      outputs: [
        {
          type: "html",
          artifactId: copiedHtmlArtifact!.id
        }
      ]
    });

    const messageArtifacts = getMessageArtifactsByConversation(conversation.id, db);
    expect(messageArtifacts).toHaveLength(1);
    expect(messageArtifacts[0]).toMatchObject({
      messageId: assignmentMessage?.id,
      type: "artifact_preview",
      payload: {
        artifactId: copiedHtmlArtifact!.id,
        artifactType: "html"
      }
    });
  });

  it("replaces synthetic step deliverable wrappers with real same-step HTML artifacts", async () => {
    const db = initializeTempDatabase();
    const { workspace, firstAgent } = createTestWorkspace(db);
    const { conversation } = createGroupConversation(
      {
        workspaceId: workspace.id,
        title: "Dispatch Room",
        memberAgentIds: [firstAgent.id]
      },
      db
    );
    addAgentMembers(
      {
        groupConversationId: conversation.id,
        agentIds: [firstAgent.id]
      },
      db
    );
    const userMessage = createMessage(
      {
        workspaceId: conversation.workspaceId,
        conversationId: conversation.id,
        senderType: "user",
        senderId: "local-user",
        messageType: "text",
        content: { text: "请制作产品介绍 HTML 页面" }
      },
      db
    );
    const { runAgentWithConversation } = await import("./agentRunWithConversationService");
    let htmlArtifactId = "";
    let extraHtmlArtifactId = "";
    let wrapperArtifactId = "";

    vi.mocked(runAgentWithConversation)
      .mockImplementationOnce(async (input) => {
        expect(input.artifactTarget).toMatchObject({
          workspaceId: conversation.workspaceId,
          conversationId: conversation.id,
          dispatchStepId: expect.any(String)
        });
        const htmlArtifact = createArtifact(
          {
            workspaceId: input.artifactTarget!.workspaceId,
            conversationId: input.artifactTarget!.conversationId,
            agentId: firstAgent.id,
            type: "html",
            title: "产品介绍 HTML 页面",
            content: [
              "<!doctype html><html><body><main>",
              "<h1>AgentHub 产品介绍</h1>",
              "<section><h2>核心价值</h2><p>面向 LangChain / AutoGen / CrewAI 使用者，提供多 Agent 协作、任务分派、产物预览和交付闭环。</p></section>",
              "<section><h2>能力模块</h2><p>包含数据搜集、分析对比、网页设计、报告生成、HTML 预览和工作空间产物管理。</p></section>",
              "<section><h2>使用场景</h2><p>适合竞品分析、产品研究、方案撰写、PPT 生成和多角色协同工作流。</p></section>",
              "</main></body></html>"
            ].join("\n"),
            language: "html"
          },
          db
        );
        htmlArtifactId = htmlArtifact.id;
        const extraHtmlArtifact = createArtifact(
          {
            workspaceId: input.artifactTarget!.workspaceId,
            conversationId: input.artifactTarget!.conversationId,
            agentId: firstAgent.id,
            type: "html",
            title: "未采用 HTML 草稿",
            content: [
              "<!doctype html><html><body><main>",
              "<h1>Draft</h1>",
              "<section><p>这是一个未采用的 HTML 草稿，用于测试同一步多个真实产物时优先选择包装文本中明确引用的产物。</p></section>",
              "<section><p>草稿内容长度足够，但不应成为最终官方产物。</p></section>",
              "</main></body></html>"
            ].join("\n"),
            language: "html"
          },
          db
        );
        extraHtmlArtifactId = extraHtmlArtifact.id;

        return createSilentAgentReply(
          input,
          `Artifact 已成功创建（ID: ${htmlArtifact.id}）。基于用户的产品上下文，我设计了一份完整的产品介绍落地页并已通过 previewArtifact 验证。`
        );
      })
      .mockImplementationOnce(async (input) => {
        expect(input.resume).toBe(true);
        const artifactId = input.message.match(/artifactId: ([\w-]+)/)?.[1];
        expect(artifactId).toBeDefined();
        expect(artifactId).not.toBe(htmlArtifactId);
        wrapperArtifactId = artifactId!;

        return createSilentAgentReply(
          input,
          JSON.stringify({
            status: "completed",
            summary: "产品介绍页面已生成。",
            completedCriteria: ["criterion-1"],
            unresolvedCriteria: [],
            artifactIds: [artifactId],
            outputs: [
              {
                type: "markdown",
                artifactId,
                preview: "Artifact 已成功创建。",
                isComplete: true
              }
            ],
            evidence: [
              {
                criterionId: "criterion-1",
                artifactId,
                summary: "包装产物记录了 HTML 页面创建完成。"
              }
            ],
            filesRead: [],
            assumptions: [],
            risks: []
          })
        );
      });

    const result = await dispatchGroupTasks(
      {
        conversationId: conversation.id,
        userMessageId: userMessage.id,
        assignments: [
          {
            agentId: firstAgent.id,
            task: "制作产品介绍 HTML 页面",
            reason: "测试包装产物替换",
            order: 0
          }
        ]
      },
      db
    );

    const artifacts = getArtifactsByConversation(conversation.id, db);
    expect(artifacts.map((artifact) => artifact.id)).toContain(htmlArtifactId);
    expect(artifacts.map((artifact) => artifact.id)).not.toContain(extraHtmlArtifactId);
    expect(artifacts.map((artifact) => artifact.id)).not.toContain(wrapperArtifactId);
    expect(artifacts).toHaveLength(1);
    expect(artifacts[0]).toMatchObject({
      id: htmlArtifactId,
      workspaceId: workspace.id,
      conversationId: conversation.id,
      agentId: firstAgent.id,
      type: "html",
      title: "产品介绍 HTML 页面"
    });

    expect(result.dispatchSteps[0].subAgentResult).toMatchObject({
      status: "completed",
      summary: "产品介绍 HTML 页面 已创建。",
      completedCriteria: ["criterion-1"],
      artifactIds: [htmlArtifactId],
      outputs: [
        {
          type: "html",
          artifactId: htmlArtifactId,
          isComplete: true
        }
      ],
      evidence: [
        {
          criterionId: "criterion-1",
          artifactId: htmlArtifactId
        }
      ]
    });

    const assignmentMessage = result.allMessages?.find(
      (message) => message.messageType === "agent_assignment"
    );
    expect(assignmentMessage?.metadata).toMatchObject({
      artifactIds: [htmlArtifactId],
      outputs: [
        {
          type: "html",
          artifactId: htmlArtifactId
        }
      ]
    });

    const messageArtifacts = getMessageArtifactsByConversation(conversation.id, db);
    expect(messageArtifacts).toHaveLength(1);
    expect(messageArtifacts[0]).toMatchObject({
      messageId: assignmentMessage?.id,
      type: "artifact_preview",
      payload: {
        artifactId: htmlArtifactId,
        artifactType: "html"
      }
    });
  });

  it("does not persist English runtime wrapper text when a real same-step HTML artifact exists", async () => {
    const db = initializeTempDatabase();
    const { workspace, firstAgent } = createTestWorkspace(db);
    const { conversation } = createGroupConversation(
      {
        workspaceId: workspace.id,
        title: "Dispatch Room",
        memberAgentIds: [firstAgent.id]
      },
      db
    );
    addAgentMembers(
      {
        groupConversationId: conversation.id,
        agentIds: [firstAgent.id]
      },
      db
    );
    const userMessage = createMessage(
      {
        workspaceId: conversation.workspaceId,
        conversationId: conversation.id,
        senderType: "user",
        senderId: "local-user",
        messageType: "text",
        content: { text: "请制作竞品分析 HTML 报告" }
      },
      db
    );
    const { runAgentWithConversation } = await import("./agentRunWithConversationService");
    let htmlArtifactId = "";

    vi.mocked(runAgentWithConversation).mockImplementationOnce(async (input) => {
      const htmlArtifact = createArtifact(
        {
          workspaceId: input.artifactTarget!.workspaceId,
          conversationId: input.artifactTarget!.conversationId,
          agentId: firstAgent.id,
          type: "html",
          title: "LangChain vs AutoGen vs CrewAI 竞品分析报告",
          content: [
            "<!doctype html><html><body><main>",
            "<h1>LangChain vs AutoGen vs CrewAI 竞品分析报告</h1>",
            "<section><h2>执行摘要</h2><p>围绕三大 AI Agent 框架进行定位、能力和场景对比。</p></section>",
            "<section><h2>能力矩阵</h2><p>覆盖架构、工具、记忆、编排、可观测性和生态成熟度。</p></section>",
            "<section><h2>选型建议</h2><p>生产复杂流程优先 LangGraph，对话协作优先 AutoGen，角色化业务流优先 CrewAI。</p></section>",
            "</main></body></html>"
          ].join("\n"),
          language: "html"
        },
        db
      );
      htmlArtifactId = htmlArtifact.id;

      return createSilentAgentReply(
        input,
        [
          "The user asked to build a deliverable in the chat; this round I am only asked to create the preview artifact.",
          "The tool has returned a created artifact ID for the HTML report preview. No further tool calls are required.",
          JSON.stringify({
            agentId: firstAgent.id,
            status: "success",
            artifactIds: [htmlArtifact.id],
            outputs: [
              {
                type: "html",
                artifactId: htmlArtifact.id
              }
            ],
            evidence: [
              {
                type: "create_artifact_response",
                artifactId: htmlArtifact.id,
                status: "created"
              }
            ]
          })
        ].join("\n\n")
      );
    });

    const result = await dispatchGroupTasks(
      {
        conversationId: conversation.id,
        userMessageId: userMessage.id,
        assignments: [
          {
            agentId: firstAgent.id,
            task: "制作竞品分析 HTML 报告",
            reason: "测试英文 runtime 包装文本过滤",
            order: 0
          }
        ]
      },
      db
    );

    const artifacts = getArtifactsByConversation(conversation.id, db);
    expect(artifacts).toHaveLength(1);
    expect(artifacts[0]).toMatchObject({
      id: htmlArtifactId,
      type: "html",
      title: "LangChain vs AutoGen vs CrewAI 竞品分析报告"
    });
    expect(artifacts[0].metadata).toMatchObject({
      official: true,
      dispatchRunId: result.dispatchRun.id
    });
    expect(result.dispatchSteps.map((step) => step.id)).toContain(
      artifacts[0].metadata?.dispatchStepId
    );

    const assignmentMessage = result.allMessages?.find(
      (message) => message.messageType === "agent_assignment"
    );
    const messageArtifacts = getMessageArtifactsByConversation(conversation.id, db);
    expect(messageArtifacts).toHaveLength(1);
    expect(messageArtifacts[0]).toMatchObject({
      messageId: assignmentMessage?.id,
      type: "artifact_preview",
      payload: {
        artifactId: htmlArtifactId,
        artifactType: "html"
      }
    });
  });

  it("repairs completed PPT results that only reference placeholder markdown artifacts", async () => {
    const db = initializeTempDatabase();
    const { workspace, firstAgent } = createTestWorkspace(db);
    const { conversation } = createGroupConversation(
      {
        workspaceId: workspace.id,
        title: "Dispatch Room",
        memberAgentIds: [firstAgent.id]
      },
      db
    );
    addAgentMembers(
      {
        groupConversationId: conversation.id,
        agentIds: [firstAgent.id]
      },
      db
    );
    const userMessage = createMessage(
      {
        workspaceId: conversation.workspaceId,
        conversationId: conversation.id,
        senderType: "user",
        senderId: "local-user",
        messageType: "text",
        content: { text: "请基于搜集信息撰写分析报告并生成 PPT" }
      },
      db
    );
    const { runAgentWithConversation } = await import("./agentRunWithConversationService");
    let pptArtifactId = "";

    vi.mocked(runAgentWithConversation)
      .mockImplementationOnce(async (input) =>
        createSilentAgentReply(input, "PPT 已创建。继续生成 PPT 预览信息和报告摘要。")
      )
      .mockImplementationOnce(async (input) => {
        expect(input.resume).toBe(true);
        expect(input.message).toContain("交付物无效");
        expect(input.message).toContain("必须实际创建一个非空、可预览的演示稿产物");
        const pptArtifact = createArtifact(
          {
            workspaceId: input.artifactTarget!.workspaceId,
            conversationId: input.artifactTarget!.conversationId,
            agentId: firstAgent.id,
            type: "html",
            title: "LangChain / AutoGen / CrewAI 竞品分析 PPT",
            content: [
              "<!doctype html><html><head><title>PPT</title></head><body>",
              "<section class='slide'><h1>竞品分析 PPT</h1><p>封面</p></section>",
              "<section class='slide'><h2>目录</h2><p>LangChain / AutoGen / CrewAI</p></section>",
              "<section class='slide'><h2>对比矩阵</h2><p>架构、工具、记忆、可观测性、生产成熟度。</p></section>",
              "<section class='slide'><h2>LangChain</h2><p>LangChain 与 LangGraph 适合复杂状态机、长流程工具调用和生产级 RAG。它的优势是生态广、可观测性强、checkpoint 机制成熟。</p></section>",
              "<section class='slide'><h2>AutoGen</h2><p>AutoGen 适合多角色对话、代码执行和人工介入场景。它的优势是对话协作自然，和 Microsoft / Azure 生态结合紧密。</p></section>",
              "<section class='slide'><h2>CrewAI</h2><p>CrewAI 适合快速搭建研究员、写手、评审等角色化团队。它的优势是抽象直接、业务方易理解、原型速度快。</p></section>",
              "<section class='slide'><h2>结论</h2><p>根据使用场景选择 LangGraph、AutoGen 或 CrewAI。</p></section>",
              "</body></html>"
            ].join("\n"),
            language: "html"
          },
          db
        );
        pptArtifactId = pptArtifact.id;

        return createSilentAgentReply(
          input,
          JSON.stringify({
            status: "completed",
            summary: "已重新生成真实 HTML PPT。",
            completedCriteria: ["criterion-1"],
            unresolvedCriteria: [],
            artifactIds: [pptArtifact.id],
            outputs: [
              {
                type: "html",
                artifactId: pptArtifact.id,
                preview: "竞品分析 PPT HTML 演示稿",
                isComplete: true
              }
            ],
            evidence: [
              {
                criterionId: "criterion-1",
                artifactId: pptArtifact.id,
                summary: "真实 HTML slide deck 已创建。"
              }
            ],
            filesRead: [],
            assumptions: [],
            risks: []
          })
        );
      });

    const result = await dispatchGroupTasks(
      {
        conversationId: conversation.id,
        userMessageId: userMessage.id,
        assignments: [
          {
            agentId: firstAgent.id,
            task: "撰写分析报告并生成 PPT",
            reason: "测试 PPT 占位产物修复",
            order: 0
          }
        ]
      },
      db
    );

    expect(runAgentWithConversation).toHaveBeenCalledTimes(2);
    const artifacts = getArtifactsByConversation(conversation.id, db);
    expect(artifacts.map((artifact) => artifact.id)).toContain(pptArtifactId);
    expect(artifacts).toHaveLength(1);
    expect(artifacts[0]).toMatchObject({
      id: pptArtifactId,
      type: "html",
      title: "LangChain / AutoGen / CrewAI 竞品分析 PPT"
    });

    expect(result.dispatchRun.status).toBe("completed");
    expect(result.dispatchSteps[0].subAgentResult).toMatchObject({
      status: "completed",
      summary: "已重新生成真实 HTML PPT。",
      completedCriteria: ["criterion-1"],
      artifactIds: [pptArtifactId],
      outputs: [
        {
          type: "html",
          artifactId: pptArtifactId,
          isComplete: true
        }
      ],
      evidence: [
        {
          criterionId: "criterion-1",
          artifactId: pptArtifactId
        }
      ]
    });

    const messageArtifacts = getMessageArtifactsByConversation(conversation.id, db);
    expect(messageArtifacts).toHaveLength(1);
    expect(messageArtifacts[0]).toMatchObject({
      type: "artifact_preview",
      payload: {
        artifactId: pptArtifactId,
        artifactType: "html"
      }
    });

    const events = getGroupRunEventsByConversation(conversation.id, db);
    expect(
      events.flatMap((event) =>
        event.type === "agent_progress" ? [event.payload.title] : []
      )
    ).toContain("交付物无效，正在重新生成");
  });

  it("removes superseded PPT artifacts when a redispatch creates a replacement for the same criterion", async () => {
    const db = initializeTempDatabase();
    const { workspace, firstAgent } = createTestWorkspace(db);
    const { conversation } = createGroupConversation(
      {
        workspaceId: workspace.id,
        title: "Dispatch Room",
        memberAgentIds: [firstAgent.id]
      },
      db
    );
    addAgentMembers(
      {
        groupConversationId: conversation.id,
        agentIds: [firstAgent.id]
      },
      db
    );
    const userMessage = createMessage(
      {
        workspaceId: conversation.workspaceId,
        conversationId: conversation.id,
        senderType: "user",
        senderId: "local-user",
        messageType: "text",
        content: { text: "请生成 8 页 HTML PPT" }
      },
      db
    );
    const { runAgentWithConversation } = await import("./agentRunWithConversationService");
    let oldArtifactId = "";
    let replacementArtifactId = "";

    vi.mocked(runAgentWithConversation)
      .mockImplementationOnce(async (input) => {
        const oldArtifact = createArtifact(
          {
            workspaceId: input.artifactTarget!.workspaceId,
            conversationId: input.artifactTarget!.conversationId,
            agentId: firstAgent.id,
            type: "html",
            title: "LangChain vs AutoGen vs CrewAI 竞品分析 — HTML Slide Deck",
            content: [
              "<!doctype html><html><body>",
              "<section class='slide'><h1>封面</h1><p>LangChain / AutoGen / CrewAI</p></section>",
              "<section class='slide'><h2>目录</h2><p>执行摘要、定位、结论。</p></section>",
              "<section class='slide'><h2>结论</h2><p>短版 PPT，页数不足，需要继续修复。</p></section>",
              "</body></html>"
            ].join("\n"),
            language: "html"
          },
          db
        );
        oldArtifactId = oldArtifact.id;

        return createSilentAgentReply(
          input,
          JSON.stringify({
            status: "partial",
            summary: "已生成初版 PPT，但页数不足。",
            completedCriteria: [],
            unresolvedCriteria: ["criterion-1"],
            artifactIds: [oldArtifact.id],
            outputs: [
              {
                type: "html",
                artifactId: oldArtifact.id,
                preview: "短版 HTML Slide Deck",
                isComplete: false
              }
            ],
            evidence: [
              {
                criterionId: "criterion-1",
                artifactId: oldArtifact.id,
                summary: "初版 HTML PPT 页数不足。"
              }
            ],
            filesRead: [],
            assumptions: [],
            risks: ["页数不足 8 页"],
            nextSuggestedTask: "基于初版重新生成完整 8 页 HTML PPT。"
          })
        );
      })
      .mockImplementationOnce(async (input) => {
        expect(input.resume).toBe(false);
        expect(input.message).toContain("修复上一轮未完成验收项");
        const replacement = createArtifact(
          {
            workspaceId: input.artifactTarget!.workspaceId,
            conversationId: input.artifactTarget!.conversationId,
            agentId: firstAgent.id,
            type: "html",
            title: "LangChain vs AutoGen vs CrewAI 竞品分析 PPT 完整版",
            content: [
              "<!doctype html><html><body>",
              "<section class='slide'><h1>封面</h1><p>LangChain / AutoGen / CrewAI</p></section>",
              "<section class='slide'><h2>目录</h2><p>执行摘要、定位、矩阵、优劣势、场景、建议、风险、结论。</p></section>",
              "<section class='slide'><h2>执行摘要</h2><p>完整版本覆盖三大框架。</p></section>",
              "<section class='slide'><h2>三框架定位</h2><p>LangChain、AutoGen、CrewAI 定位差异。</p></section>",
              "<section class='slide'><h2>能力矩阵</h2><p>工具、记忆、编排、可观测性。</p></section>",
              "<section class='slide'><h2>优劣势</h2><p>生态、协作、业务抽象。</p></section>",
              "<section class='slide'><h2>场景建议</h2><p>按复杂流程、对话协作、业务任务选择。</p></section>",
              "<section class='slide'><h2>风险与趋势</h2><p>版本演进、生态稳定性、治理成本。</p></section>",
              "</body></html>"
            ].join("\n"),
            language: "html"
          },
          db
        );
        replacementArtifactId = replacement.id;

        return createSilentAgentReply(
          input,
          JSON.stringify({
            status: "completed",
            summary: "已生成完整 8 页 HTML PPT。",
            completedCriteria: ["criterion-1"],
            unresolvedCriteria: [],
            artifactIds: [replacement.id],
            outputs: [
              {
                type: "html",
                artifactId: replacement.id,
                preview: "完整 8 页 HTML PPT",
                isComplete: true
              }
            ],
            evidence: [
              {
                criterionId: "criterion-1",
                artifactId: replacement.id,
                summary: "完整 HTML PPT 已覆盖 8 页结构。"
              }
            ],
            filesRead: [],
            assumptions: [],
            risks: []
          })
        );
      });

    const result = await dispatchGroupTasks(
      {
        conversationId: conversation.id,
        userMessageId: userMessage.id,
        assignments: [
          {
            agentId: firstAgent.id,
            task: "生成 8 页 HTML PPT",
            reason: "测试修复产物替换旧候选",
            order: 0
          }
        ]
      },
      db
    );

    expect(runAgentWithConversation).toHaveBeenCalledTimes(2);
    expect(result.dispatchSteps).toHaveLength(2);
    const artifacts = getArtifactsByConversation(conversation.id, db);
    expect(artifacts.map((artifact) => artifact.id)).not.toContain(oldArtifactId);
    expect(artifacts.map((artifact) => artifact.id)).toContain(replacementArtifactId);
    expect(artifacts).toHaveLength(1);
    expect(artifacts[0]).toMatchObject({
      id: replacementArtifactId,
      type: "html",
      title: "LangChain vs AutoGen vs CrewAI 竞品分析 PPT 完整版"
    });
  });

  it("repairs HTML slide decks that rely on unsupported button or keyboard navigation", async () => {
    const db = initializeTempDatabase();
    const { workspace, firstAgent } = createTestWorkspace(db);
    const { conversation } = createGroupConversation(
      {
        workspaceId: workspace.id,
        title: "Dispatch Room",
        memberAgentIds: [firstAgent.id]
      },
      db
    );
    addAgentMembers(
      {
        groupConversationId: conversation.id,
        agentIds: [firstAgent.id]
      },
      db
    );
    const userMessage = createMessage(
      {
        workspaceId: conversation.workspaceId,
        conversationId: conversation.id,
        senderType: "user",
        senderId: "local-user",
        messageType: "text",
        content: { text: "请生成一个 4 页 HTML PPT，只能上下滚动预览" }
      },
      db
    );
    const { runAgentWithConversation } = await import("./agentRunWithConversationService");
    let invalidArtifactId = "";
    let validArtifactId = "";

    vi.mocked(runAgentWithConversation)
      .mockImplementationOnce(async (input) => {
        const invalidArtifact = createArtifact(
          {
            workspaceId: input.artifactTarget!.workspaceId,
            conversationId: input.artifactTarget!.conversationId,
            agentId: firstAgent.id,
            type: "html",
            title: "交互式竞品分析 PPT",
            content: [
              "<!doctype html><html><head><title>PPT</title></head><body>",
              "<main class='deck'><section class='slide active'><h1>竞品分析 PPT</h1><p>封面：LangChain / AutoGen / CrewAI 多 Agent 框架对比。</p></section>",
              "<section class='slide'><h2>目录</h2><p>定位差异、能力矩阵、场景适配、选型建议与风险趋势。</p></section>",
              "<section class='slide'><h2>能力矩阵</h2><p>对比工具调用、状态管理、工作流编排、生态集成、可观测性和生产成熟度。</p></section>",
              "<section class='slide'><h2>结论</h2><p>生产复杂流程优先 LangGraph，对话协作优先 AutoGen，角色化业务任务优先 CrewAI。</p></section></main>",
              "<button class='next-button' onclick='nextSlide()'>下一页</button>",
              "<script>document.addEventListener('keydown', (event) => { if (event.key === 'ArrowRight') nextSlide(); if (event.key === 'ArrowLeft') prevSlide(); }); function nextSlide(){} function prevSlide(){}</script>",
              "</body></html>"
            ].join("\n"),
            language: "html"
          },
          db
        );
        invalidArtifactId = invalidArtifact.id;

        return createSilentAgentReply(
          input,
          JSON.stringify({
            status: "completed",
            summary: "已生成可翻页 HTML PPT。",
            completedCriteria: ["criterion-1"],
            unresolvedCriteria: [],
            artifactIds: [invalidArtifact.id],
            outputs: [
              {
                type: "html",
                artifactId: invalidArtifact.id,
                preview: "交互式 HTML PPT",
                isComplete: true
              }
            ],
            evidence: [
              {
                criterionId: "criterion-1",
                artifactId: invalidArtifact.id,
                summary: "HTML PPT 已创建。"
              }
            ],
            filesRead: [],
            assumptions: [],
            risks: []
          })
        );
      })
      .mockImplementationOnce(async (input) => {
        expect(input.resume).toBe(true);
        expect(input.message).toContain("平台不支持的左右/按钮/键盘翻页控件");
        expect(input.message).toContain("上下滚动");
        expect(input.message).toContain("禁止 JavaScript 翻页");
        const validArtifact = createArtifact(
          {
            workspaceId: input.artifactTarget!.workspaceId,
            conversationId: input.artifactTarget!.conversationId,
            agentId: firstAgent.id,
            type: "html",
            title: "纵向滚动竞品分析 PPT",
            content: [
              "<!doctype html><html><head><title>PPT</title></head><body>",
              "<section class='slide'><h1>竞品分析 PPT</h1><p>封面：LangChain / AutoGen / CrewAI 三大框架对比，说明报告目标、范围和结论先行。</p></section>",
              "<section class='slide'><h2>目录</h2><p>本演示稿依次覆盖执行摘要、框架定位、能力矩阵、优劣势、场景适配、选型建议和风险趋势。</p></section>",
              "<section class='slide'><h2>能力矩阵</h2><p>从工具调用、状态管理、工作流编排、多 Agent 协作、知识检索、可观测性、部署治理和生态成熟度进行横向比较。</p></section>",
              "<section class='slide'><h2>结论</h2><p>复杂生产工作流优先 LangGraph / LangChain，对话式协作优先 AutoGen，业务角色化团队任务优先 CrewAI。</p></section>",
              "</body></html>"
            ].join("\n"),
            language: "html"
          },
          db
        );
        validArtifactId = validArtifact.id;

        return createSilentAgentReply(
          input,
          JSON.stringify({
            status: "completed",
            summary: "已重新生成纵向滚动 HTML PPT。",
            completedCriteria: ["criterion-1"],
            unresolvedCriteria: [],
            artifactIds: [validArtifact.id],
            outputs: [
              {
                type: "html",
                artifactId: validArtifact.id,
                preview: "纵向滚动 HTML PPT",
                isComplete: true
              }
            ],
            evidence: [
              {
                criterionId: "criterion-1",
                artifactId: validArtifact.id,
                summary: "HTML slide deck 按页纵向堆叠，可上下滚动预览。"
              }
            ],
            filesRead: [],
            assumptions: [],
            risks: []
          })
        );
      });

    const result = await dispatchGroupTasks(
      {
        conversationId: conversation.id,
        userMessageId: userMessage.id,
        assignments: [
          {
            agentId: firstAgent.id,
            task: "生成一个 4 页 HTML PPT",
            reason: "测试不支持左右翻页的 HTML 演示稿修复",
            order: 0
          }
        ]
      },
      db
    );

    expect(runAgentWithConversation).toHaveBeenCalledTimes(2);
    const artifacts = getArtifactsByConversation(conversation.id, db);
    expect(artifacts.map((artifact) => artifact.id)).not.toContain(invalidArtifactId);
    expect(artifacts).toHaveLength(1);
    expect(artifacts[0]).toMatchObject({
      id: validArtifactId,
      type: "html",
      title: "纵向滚动竞品分析 PPT"
    });
    expect(result.dispatchSteps[0].subAgentResult).toMatchObject({
      status: "completed",
      artifactIds: [validArtifactId],
      outputs: [
        {
          type: "html",
          artifactId: validArtifactId,
          isComplete: true
        }
      ]
    });

    const messageArtifacts = getMessageArtifactsByConversation(conversation.id, db);
    expect(messageArtifacts).toHaveLength(1);
    expect(messageArtifacts[0]).toMatchObject({
      type: "artifact_preview",
      payload: {
        artifactId: validArtifactId,
        artifactType: "html"
      }
    });
  });

  it("repairs incomplete Markdown reports in the same dispatch step without adding DAG tasks", async () => {
    const db = initializeTempDatabase();
    const { workspace, firstAgent } = createTestWorkspace(db);
    const { conversation } = createGroupConversation(
      {
        workspaceId: workspace.id,
        title: "Dispatch Room",
        memberAgentIds: [firstAgent.id]
      },
      db
    );
    addAgentMembers(
      {
        groupConversationId: conversation.id,
        agentIds: [firstAgent.id]
      },
      db
    );
    const userMessage = createMessage(
      {
        workspaceId: conversation.workspaceId,
        conversationId: conversation.id,
        senderType: "user",
        senderId: "local-user",
        messageType: "text",
        content: {
          text: "请生成 Markdown 竞品分析报告，必须包含执行摘要、定位差异、功能矩阵、优劣势分析、场景适配、选型建议、风险与趋势。"
        }
      },
      db
    );
    const { runAgentWithConversation } = await import("./agentRunWithConversationService");
    let invalidArtifactId = "";
    let validArtifactId = "";

    vi.mocked(runAgentWithConversation)
      .mockImplementationOnce(async (input) => {
        const invalidArtifact = createArtifact(
          {
            workspaceId: input.artifactTarget!.workspaceId,
            conversationId: input.artifactTarget!.conversationId,
            agentId: firstAgent.id,
            type: "markdown",
            title: "竞品分析报告残稿",
            content: [
              "# 竞品分析报告",
              "",
              "## 执行摘要",
              "LangChain、AutoGen、CrewAI 各有侧重。",
              "",
              "## 选型建议",
              "复杂流程选 LangChain，对话协作选 AutoGen，角色任务选 CrewAI。"
            ].join("\n"),
            language: "markdown"
          },
          db
        );
        invalidArtifactId = invalidArtifact.id;

        return createSilentAgentReply(
          input,
          JSON.stringify({
            status: "completed",
            summary: "已生成 Markdown 竞品分析报告。",
            completedCriteria: ["criterion-1"],
            unresolvedCriteria: [],
            artifactIds: [invalidArtifact.id],
            outputs: [
              {
                type: "markdown",
                artifactId: invalidArtifact.id,
                preview: "竞品分析报告残稿",
                isComplete: true
              }
            ],
            evidence: [
              {
                criterionId: "criterion-1",
                artifactId: invalidArtifact.id,
                summary: "Markdown 报告已创建。"
              }
            ],
            filesRead: [],
            assumptions: [],
            risks: []
          })
        );
      })
      .mockImplementationOnce(async (input) => {
        expect(input.resume).toBe(true);
        expect(input.message).toContain("Markdown 报告/摘要");
        expect(input.message).toContain("type=markdown");
        expect(input.message).toContain("执行摘要");
        const sectionBody = "LangChain 适合复杂状态机、工具调用、RAG 与生产级可观测性；AutoGen 适合多角色对话、代码执行和人工介入；CrewAI 适合角色化业务流程、快速原型和任务编排。";
        const fullReport = [
          "# LangChain vs AutoGen vs CrewAI 竞品分析报告",
          "",
          "## 执行摘要",
          `${sectionBody} `.repeat(3),
          "",
          "## 定位差异",
          `${sectionBody} `.repeat(3),
          "",
          "## 功能矩阵",
          "| 维度 | LangChain | AutoGen | CrewAI |",
          "| --- | --- | --- | --- |",
          "| 编排 | LangGraph 状态图 | 异步消息协作 | Crews 与 Flows |",
          `${sectionBody} `.repeat(2),
          "",
          "## 优劣势分析",
          `${sectionBody} `.repeat(3),
          "",
          "## 场景适配",
          `${sectionBody} `.repeat(3),
          "",
          "## 选型建议",
          `${sectionBody} `.repeat(3),
          "",
          "## 风险与趋势",
          `${sectionBody} `.repeat(3)
        ].join("\n");
        const validArtifact = createArtifact(
          {
            workspaceId: input.artifactTarget!.workspaceId,
            conversationId: input.artifactTarget!.conversationId,
            agentId: firstAgent.id,
            type: "markdown",
            title: "完整竞品分析报告",
            content: fullReport,
            language: "markdown"
          },
          db
        );
        validArtifactId = validArtifact.id;

        return createSilentAgentReply(
          input,
          JSON.stringify({
            status: "completed",
            summary: "已重新生成完整 Markdown 竞品分析报告。",
            completedCriteria: ["criterion-1"],
            unresolvedCriteria: [],
            artifactIds: [validArtifact.id],
            outputs: [
              {
                type: "markdown",
                artifactId: validArtifact.id,
                preview: "完整竞品分析报告",
                isComplete: true
              }
            ],
            evidence: [
              {
                criterionId: "criterion-1",
                artifactId: validArtifact.id,
                summary: "报告包含七个必需章节且内容完整。"
              }
            ],
            filesRead: [],
            assumptions: [],
            risks: []
          })
        );
      });

    const result = await dispatchGroupTasks(
      {
        conversationId: conversation.id,
        userMessageId: userMessage.id,
        assignments: [
          {
            agentId: firstAgent.id,
            task: "生成 Markdown 竞品分析报告，必须包含执行摘要、定位差异、功能矩阵、优劣势分析、场景适配、选型建议、风险与趋势。",
            reason: "测试 Markdown 报告原地修复",
            order: 0
          }
        ]
      },
      db
    );

    expect(runAgentWithConversation).toHaveBeenCalledTimes(2);
    expect(result.dispatchSteps).toHaveLength(1);
    expect(result.dispatchRun.status).toBe("completed");
    const artifacts = getArtifactsByConversation(conversation.id, db);
    expect(artifacts.map((artifact) => artifact.id)).not.toContain(invalidArtifactId);
    expect(artifacts).toHaveLength(1);
    expect(artifacts[0]).toMatchObject({
      id: validArtifactId,
      type: "markdown",
      title: "完整竞品分析报告"
    });
    expect(result.dispatchSteps[0].subAgentResult).toMatchObject({
      status: "completed",
      artifactIds: [validArtifactId],
      completedCriteria: ["criterion-1"]
    });
  });

  it("keeps a Markdown report out of the PPT bucket even when the global request also asks for PPT", async () => {
    const db = initializeTempDatabase();
    const { workspace, firstAgent } = createTestWorkspace(db);
    const { conversation } = createGroupConversation(
      {
        workspaceId: workspace.id,
        title: "Dispatch Room",
        memberAgentIds: [firstAgent.id]
      },
      db
    );
    addAgentMembers(
      {
        groupConversationId: conversation.id,
        agentIds: [firstAgent.id]
      },
      db
    );
    const userMessage = createMessage(
      {
        workspaceId: conversation.workspaceId,
        conversationId: conversation.id,
        senderType: "user",
        senderId: "local-user",
        messageType: "text",
        content: {
          text: "请生成 Markdown 竞品分析报告，并另外生成 HTML PPT 演示稿。"
        }
      },
      db
    );
    const { runAgentWithConversation } = await import("./agentRunWithConversationService");
    let reportArtifactId = "";

    vi.mocked(runAgentWithConversation).mockImplementationOnce(async (input) => {
      const sectionBody = "LangChain 适合复杂状态机、工具调用、RAG 与生产级可观测性；AutoGen 适合多角色对话、代码执行和人工介入；CrewAI 适合角色化业务流程、快速原型和任务编排。";
      const fullReport = [
        "# LangChain vs AutoGen vs CrewAI 竞品分析报告",
        "",
        "## 执行摘要",
        `${sectionBody} `.repeat(3),
        "",
        "## 定位差异",
        `${sectionBody} `.repeat(3),
        "",
        "## 功能矩阵",
        "| 维度 | LangChain | AutoGen | CrewAI |",
        "| --- | --- | --- | --- |",
        "| 编排 | LangGraph 状态图 | 异步消息协作 | Crews 与 Flows |",
        `${sectionBody} `.repeat(2),
        "",
        "## 优劣势分析",
        `${sectionBody} `.repeat(3),
        "",
        "## 场景适配",
        `${sectionBody} `.repeat(3),
        "",
        "## 选型建议",
        `${sectionBody} `.repeat(3),
        "",
        "## 风险与趋势",
        `${sectionBody} `.repeat(3)
      ].join("\n");
      const reportArtifact = createArtifact(
        {
          workspaceId: input.artifactTarget!.workspaceId,
          conversationId: input.artifactTarget!.conversationId,
          agentId: firstAgent.id,
          type: "markdown",
          title: "LangChain vs AutoGen vs CrewAI 竞品分析 PPT",
          content: fullReport,
          language: "markdown"
        },
        db
      );
      reportArtifactId = reportArtifact.id;

      return createSilentAgentReply(
        input,
        JSON.stringify({
          status: "completed",
          summary: "已生成 Markdown 竞品分析 PPT。",
          completedCriteria: ["criterion-1"],
          unresolvedCriteria: [],
          artifactIds: [reportArtifact.id],
          outputs: [
            {
              type: "markdown",
              artifactId: reportArtifact.id,
              preview: "LangChain vs AutoGen vs CrewAI 竞品分析 PPT",
              isComplete: true
            }
          ],
          evidence: [
            {
              criterionId: "criterion-1",
              artifactId: reportArtifact.id,
              summary: "Markdown 竞品分析 PPT 覆盖七个章节。"
            }
          ],
          filesRead: [],
          assumptions: [],
          risks: []
        })
      );
    });

    const result = await dispatchGroupTasks(
      {
        conversationId: conversation.id,
        userMessageId: userMessage.id,
        assignments: [
          {
            agentId: firstAgent.id,
            task: "生成 Markdown 竞品分析报告，必须包含执行摘要、定位差异、功能矩阵、优劣势分析、场景适配、选型建议、风险与趋势。",
            reason: "测试报告与 PPT 全局请求隔离",
            order: 0
          }
        ]
      },
      db
    );

    expect(runAgentWithConversation).toHaveBeenCalledTimes(1);
    expect(result.dispatchRun.status).toBe("completed");
    const artifacts = getArtifactsByConversation(conversation.id, db);
    expect(artifacts).toHaveLength(1);
    expect(artifacts[0]).toMatchObject({
      id: reportArtifactId,
      type: "markdown",
      title: "LangChain vs AutoGen vs CrewAI 竞品分析报告"
    });
    expect(result.dispatchSteps[0].subAgentResult).toMatchObject({
      status: "completed",
      artifactIds: [reportArtifactId],
      outputs: [
        {
          type: "markdown",
          artifactId: reportArtifactId
        }
      ]
    });
    expect(result.dispatchSteps[0].subAgentResult?.summary).not.toMatch(/PPT|slide/i);
    expect(result.dispatchSteps[0].subAgentResult?.outputs?.[0]?.preview).not.toMatch(/PPT|slide/i);
    expect(result.dispatchSteps[0].subAgentResult?.evidence?.[0]?.summary).not.toMatch(/PPT|slide/i);
  });

  it("persists group run events and continues after a sub-agent failure", async () => {
    const db = initializeTempDatabase();
    const { workspace, firstAgent, secondAgent } = createTestWorkspace(db);
    const { conversation } = createGroupConversation(
      {
        workspaceId: workspace.id,
        title: "Dispatch Room",
        memberAgentIds: [firstAgent.id, secondAgent.id]
      },
      db
    );
    addAgentMembers(
      {
        groupConversationId: conversation.id,
        agentIds: [firstAgent.id, secondAgent.id]
      },
      db
    );
    const userMessage = createMessage(
      {
        workspaceId: conversation.workspaceId,
        conversationId: conversation.id,
        senderType: "user",
        senderId: "local-user",
        messageType: "text",
        content: { text: "请两个 Agent 协作完成任务" }
      },
      db
    );
    const { runAgentWithConversation } = await import("./agentRunWithConversationService");
    vi.mocked(runAgentWithConversation).mockImplementation(async (input) => {
      const rawText =
        input.agentId === firstAgent.id
          ? JSON.stringify({
              status: "failed",
              summary: "第一步失败",
              completedCriteria: [],
              unresolvedCriteria: ["criterion-1"],
              filesRead: [],
              assumptions: [],
              risks: ["模拟失败"]
            })
          : JSON.stringify({
              status: "completed",
              summary: "第二步完成",
              completedCriteria: ["criterion-1"],
              unresolvedCriteria: [],
              filesRead: [],
              assumptions: [],
              risks: []
            });

      return createSilentAgentReply(input, rawText);
    });

    const result = await dispatchGroupTasks(
      {
        conversationId: conversation.id,
        userMessageId: userMessage.id,
        assignments: [
          {
            agentId: firstAgent.id,
            task: "先尝试执行",
            reason: "测试失败继续",
            order: 0
          },
          {
            agentId: secondAgent.id,
            task: "继续执行",
            reason: "测试后续执行",
            order: 1
          }
        ]
      },
      db
    );

    expect(runAgentWithConversation).toHaveBeenCalledTimes(2);
    expect(result.dispatchRun.status).toBe("partial_failed");
    expect(result.dispatchSteps.map((step) => step.status)).toEqual([
      "failed",
      "completed"
    ]);

    const events = getGroupRunEventsByConversation(conversation.id, db);
    expect(events.map((event) => event.type)).toEqual(
      expect.arrayContaining([
        "plan_created",
        "agent_started",
        "agent_progress",
        "agent_failed",
        "agent_completed",
        "summary_started",
        "summary_completed"
      ])
    );
    expect(events[0].type).toBe("plan_created");
    expect(events.at(-1)?.type).toBe("summary_completed");
    expect(
      events.flatMap((event) =>
        event.type === "agent_progress" ? [event.payload.title] : []
      )
    ).toEqual(expect.arrayContaining([
      "正在准备任务上下文",
      "正在运行子 Agent",
      "正在解析 SubAgentResult",
      "执行失败",
      "已完成"
    ]));
    expect(events.find((event) => event.type === "plan_created")?.payload).toMatchObject({
      assignments: [
        { agentId: firstAgent.id, instruction: "先尝试执行" },
        { agentId: secondAgent.id, instruction: "继续执行" }
      ]
    });

    const summaryMessage = result.allMessages?.find(
      (message) => message.messageType === "orchestrator_summary"
    );
    expect(summaryMessage?.metadata).toMatchObject({
      dispatchRunId: result.dispatchRun.id,
      status: "partial_failed"
    });
    expect(summaryMessage?.metadata).not.toHaveProperty("subAgentResults");
  });

  it("continues a truncated sub-agent result in the same dispatch step", async () => {
    const db = initializeTempDatabase();
    const { workspace, firstAgent } = createTestWorkspace(db);
    const { conversation } = createGroupConversation(
      {
        workspaceId: workspace.id,
        title: "Dispatch Room",
        memberAgentIds: [firstAgent.id]
      },
      db
    );
    addAgentMembers(
      {
        groupConversationId: conversation.id,
        agentIds: [firstAgent.id]
      },
      db
    );
    const userMessage = createMessage(
      {
        workspaceId: conversation.workspaceId,
        conversationId: conversation.id,
        senderType: "user",
        senderId: "local-user",
        messageType: "text",
        content: { text: "请生成一份很长的分析报告" }
      },
      db
    );
    const { runAgentWithConversation } = await import("./agentRunWithConversationService");
    const firstChunk =
      "{\"status\":\"completed\",\"summary\":\"长结果\",\"completedCriteria\":[\"criterion-1\"],\"unresolvedCriteria\":[],\"filesRead\":[],\"assumptions\":[],\"risks\":[]";
    const secondChunk = "}";

    vi.mocked(runAgentWithConversation)
      .mockImplementationOnce(async (input) => {
        expect(input.resume).toBe(false);
        return {
          ...createSilentAgentReply(input, firstChunk),
          status: "error" as const,
          runResult: {
            status: "failed" as const,
            finalMessage: firstChunk,
            error: "Model output was truncated before completion (length)."
          }
        };
      })
      .mockImplementationOnce(async (input) => {
        expect(input.resume).toBe(true);
        expect(input.dispatchStepId).toBeDefined();
        expect(input.message).toContain("继续补齐上一轮");
        return createSilentAgentReply(input, secondChunk);
      });

    const result = await dispatchGroupTasks(
      {
        conversationId: conversation.id,
        userMessageId: userMessage.id,
        assignments: [
          {
            agentId: firstAgent.id,
            task: "生成长分析",
            reason: "测试截断续写",
            order: 0
          }
        ]
      },
      db
    );

    expect(runAgentWithConversation).toHaveBeenCalledTimes(2);
    expect(result.dispatchRun.status).toBe("completed");
    expect(result.dispatchSteps).toHaveLength(1);
    expect(result.dispatchSteps[0].status).toBe("completed");
    expect(result.dispatchSteps[0].subAgentResult).toMatchObject({
      status: "completed",
      summary: "长结果",
      completedCriteria: ["criterion-1"],
      metadata: {
        continuationAttempts: 1,
        recoveredFromTruncation: true
      }
    });

    const events = getGroupRunEventsByConversation(conversation.id, db);
    expect(
      events.flatMap((event) =>
        event.type === "agent_progress" ? [event.payload.title] : []
      )
    ).toContain("正在继续补齐输出");
  });

  it("does not store short process-only non-JSON output as a deliverable artifact", async () => {
    const db = initializeTempDatabase();
    const { workspace, firstAgent } = createTestWorkspace(db);
    const { conversation } = createGroupConversation(
      {
        workspaceId: workspace.id,
        title: "Dispatch Room",
        memberAgentIds: [firstAgent.id]
      },
      db
    );
    addAgentMembers(
      {
        groupConversationId: conversation.id,
        agentIds: [firstAgent.id]
      },
      db
    );
    const userMessage = createMessage(
      {
        workspaceId: conversation.workspaceId,
        conversationId: conversation.id,
        senderType: "user",
        senderId: "local-user",
        messageType: "text",
        content: { text: "请搜集 LangChain、AutoGen、CrewAI 的公开信息摘要" }
      },
      db
    );
    const { runAgentWithConversation } = await import("./agentRunWithConversationService");

    vi.mocked(runAgentWithConversation).mockImplementation(async (input) =>
      createSilentAgentReply(
        input,
        "Let me get more info on AutoGen and CrewAI specifically."
      )
    );

    const result = await dispatchGroupTasks(
      {
        conversationId: conversation.id,
        userMessageId: userMessage.id,
        assignments: [
          {
            agentId: firstAgent.id,
            task: "搜集公开信息摘要",
            reason: "测试过程文本不落库",
            order: 0
          }
        ]
      },
      db
    );

    expect(runAgentWithConversation).toHaveBeenCalled();
    expect(getArtifactsByConversation(conversation.id, db)).toHaveLength(0);
    expect(result.dispatchRun.status).toBe("failed");
    expect(result.dispatchSteps[0].subAgentResult?.parseError).toBeDefined();
  });

  it("stores non-JSON sub-agent output as an artifact and repairs the manifest in the same step", async () => {
    const db = initializeTempDatabase();
    const { workspace, firstAgent } = createTestWorkspace(db);
    const { conversation } = createGroupConversation(
      {
        workspaceId: workspace.id,
        title: "Dispatch Room",
        memberAgentIds: [firstAgent.id]
      },
      db
    );
    addAgentMembers(
      {
        groupConversationId: conversation.id,
        agentIds: [firstAgent.id]
      },
      db
    );
    const userMessage = createMessage(
      {
        workspaceId: conversation.workspaceId,
        conversationId: conversation.id,
        senderType: "user",
        senderId: "local-user",
        messageType: "text",
        content: { text: "请输出一份 Markdown 分析报告" }
      },
      db
    );
    const markdownReport = [
      "# 分析报告",
      "",
      "这一段是子 Agent 已经完成的长正文。",
      "",
      "- 覆盖验收项 criterion-1"
    ].join("\n");
    const { runAgentWithConversation } = await import("./agentRunWithConversationService");

    vi.mocked(runAgentWithConversation)
      .mockImplementationOnce(async (input) => {
        expect(input.resume).toBe(false);
        return createSilentAgentReply(input, markdownReport);
      })
      .mockImplementationOnce(async (input) => {
        expect(input.resume).toBe(true);
        expect(input.dispatchStepId).toBeDefined();
        expect(input.message).toContain("上一轮输出已作为 Markdown 产物保存");
        const artifactId = input.message.match(/artifactId: ([\w-]+)/)?.[1];
        expect(artifactId).toBeDefined();

        return createSilentAgentReply(
          input,
          JSON.stringify({
            status: "completed",
            summary: "Markdown 分析报告已保存为产物。",
            completedCriteria: ["criterion-1"],
            unresolvedCriteria: [],
            artifactIds: [artifactId],
            outputs: [
              {
                type: "markdown",
                artifactId,
                preview: "分析报告",
                isComplete: true
              }
            ],
            evidence: [
              {
                criterionId: "criterion-1",
                artifactId,
                summary: "产物内容覆盖了用户要求的 Markdown 分析报告。"
              }
            ],
            filesRead: [],
            assumptions: [],
            risks: []
          })
        );
      });

    const result = await dispatchGroupTasks(
      {
        conversationId: conversation.id,
        userMessageId: userMessage.id,
        assignments: [
          {
            agentId: firstAgent.id,
            task: "生成 Markdown 分析报告",
            reason: "测试非 JSON 输出清单修复",
            order: 0
          }
        ]
      },
      db
    );

    const artifacts = getArtifactsByConversation(conversation.id, db);

    expect(runAgentWithConversation).toHaveBeenCalledTimes(2);
    expect(artifacts).toHaveLength(1);
    expect(artifacts[0]).toMatchObject({
      workspaceId: workspace.id,
      conversationId: conversation.id,
      agentId: firstAgent.id,
      type: "markdown",
      content: markdownReport
    });
    expect(result.dispatchRun.status).toBe("completed");
    expect(result.dispatchSteps[0].status).toBe("completed");
    expect(result.dispatchSteps[0].subAgentResult).toMatchObject({
      status: "completed",
      summary: "Markdown 分析报告已保存为产物。",
      completedCriteria: ["criterion-1"],
      artifactIds: [artifacts[0].id],
      outputs: [
        {
          type: "markdown",
          artifactId: artifacts[0].id,
          preview: "分析报告",
          isComplete: true
        }
      ],
      evidence: [
        {
          criterionId: "criterion-1",
          artifactId: artifacts[0].id,
          summary: "产物内容覆盖了用户要求的 Markdown 分析报告。"
        }
      ]
    });

    const assignmentMessage = result.allMessages?.find(
      (message) => message.messageType === "agent_assignment"
    );
    expect(assignmentMessage?.metadata).toMatchObject({
      artifactIds: [artifacts[0].id],
      outputs: [
        {
          type: "markdown",
          artifactId: artifacts[0].id
        }
      ]
    });

    const events = getGroupRunEventsByConversation(conversation.id, db);
    expect(
      events.flatMap((event) =>
        event.type === "agent_progress" ? [event.payload.title] : []
      )
    ).toContain("已保存长输出产物，正在修复结果清单");
  });

  it("moves an oversized JSON deliverable into an artifact", async () => {
    const db = initializeTempDatabase();
    const { workspace, firstAgent } = createTestWorkspace(db);
    const { conversation } = createGroupConversation(
      {
        workspaceId: workspace.id,
        title: "Dispatch Room",
        memberAgentIds: [firstAgent.id]
      },
      db
    );
    addAgentMembers(
      {
        groupConversationId: conversation.id,
        agentIds: [firstAgent.id]
      },
      db
    );
    const userMessage = createMessage(
      {
        workspaceId: conversation.workspaceId,
        conversationId: conversation.id,
        senderType: "user",
        senderId: "local-user",
        messageType: "text",
        content: { text: "请生成一份超长分析" }
      },
      db
    );
    const longDeliverable = `# 长分析\n\n${"详细内容。".repeat(400)}`;
    const { runAgentWithConversation } = await import("./agentRunWithConversationService");

    vi.mocked(runAgentWithConversation).mockImplementationOnce(async (input) =>
      createSilentAgentReply(
        input,
        JSON.stringify({
          status: "completed",
          summary: "超长分析已完成。",
          deliverable: longDeliverable,
          completedCriteria: ["criterion-1"],
          unresolvedCriteria: [],
          filesRead: [],
          assumptions: [],
          risks: []
        })
      )
    );

    const result = await dispatchGroupTasks(
      {
        conversationId: conversation.id,
        userMessageId: userMessage.id,
        assignments: [
          {
            agentId: firstAgent.id,
            task: "生成超长分析",
            reason: "测试长 deliverable 转产物",
            order: 0
          }
        ]
      },
      db
    );

    const artifacts = getArtifactsByConversation(conversation.id, db);

    expect(runAgentWithConversation).toHaveBeenCalledTimes(1);
    expect(artifacts).toHaveLength(1);
    expect(artifacts[0]).toMatchObject({
      workspaceId: workspace.id,
      conversationId: conversation.id,
      agentId: firstAgent.id,
      type: "markdown",
      content: longDeliverable
    });
    expect(result.dispatchRun.status).toBe("completed");
    expect(result.dispatchSteps[0].subAgentResult).toMatchObject({
      status: "completed",
      summary: "超长分析已完成。",
      deliverable: "超长分析已完成。",
      artifactIds: [artifacts[0].id],
      outputs: [
        {
          type: "markdown",
          artifactId: artifacts[0].id,
          isComplete: true
        }
      ]
    });
  });
});
