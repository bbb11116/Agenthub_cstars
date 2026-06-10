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
import { createMessage } from "./messageService";
import { createGroupConversation, addAgentMembers } from "./groupChatService";
import { dispatchGroupTasks, handleGroupUserMessage } from "./dispatchService";

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
