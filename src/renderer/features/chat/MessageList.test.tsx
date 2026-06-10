import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { AgentRunEvent } from "../../../shared/agentRunEvent";
import type { GroupRunEvent } from "../../../shared/groupChat";
import { GroupRunPlanPanel } from "./GroupRunTimeline";
import { MessageList, type ChatMessage } from "./MessageList";

const dispatchPlanMessage: ChatMessage = {
  id: "message-plan-1",
  workspaceId: "workspace-1",
  conversationId: "conversation-1",
  senderType: "agent",
  senderId: "main-agent-1",
  messageType: "dispatch_plan",
  content: { text: "分派计划" },
  metadata: {
    dispatchRunId: "run-1",
    assignments: [
      {
        stepId: "step-frontend",
        stepIndex: 0,
        roundIndex: 0,
        agentId: "agent-frontend",
        agentName: "Frontend Agent",
        instruction: "Inspect UI state handling.",
        targetCriteria: ["criterion-frontend"]
      },
      {
        stepId: "step-backend",
        stepIndex: 1,
        roundIndex: 0,
        agentId: "agent-backend",
        agentName: "Backend Agent",
        instruction: "Check adapter wiring.",
        targetCriteria: ["criterion-backend"]
      }
    ],
    agentNames: {
      "agent-frontend": "Frontend Agent",
      "agent-backend": "Backend Agent"
    }
  },
  createdAt: "2026-06-01T00:00:00.000Z"
};

const planCreatedEvent: GroupRunEvent = {
  id: "event-plan",
  groupRunId: "run-1",
  conversationId: "conversation-1",
  seq: 1,
  type: "plan_created",
  createdAt: "2026-06-01T00:00:00.000Z",
  payload: {
    mode: "auto_dispatch",
    roundIndex: 0,
    assignments: [
      {
        stepId: "step-frontend",
        stepIndex: 0,
        roundIndex: 0,
        assignmentId: "assignment-frontend",
        agentId: "agent-frontend",
        agentName: "Frontend Agent",
        instruction: "Inspect UI state handling.",
        targetCriteria: ["criterion-frontend"]
      },
      {
        stepId: "step-backend",
        stepIndex: 1,
        roundIndex: 0,
        assignmentId: "assignment-backend",
        agentId: "agent-backend",
        agentName: "Backend Agent",
        instruction: "Check adapter wiring.",
        targetCriteria: ["criterion-backend"]
      }
    ]
  }
};

function renderMessageList(events: GroupRunEvent[]): string {
  return renderToStaticMarkup(
    <MessageList
      emptyMessage="empty"
      emptyTitle="群聊"
      error={null}
      groupRunEvents={events}
      groupRunWorkspaceId="workspace-1"
      messages={[dispatchPlanMessage]}
      status="ready"
    />
  );
}

const directUserMessage: ChatMessage = {
  id: "message-user-1",
  workspaceId: "workspace-1",
  conversationId: "conversation-direct-1",
  senderType: "user",
  senderId: "local-user",
  messageType: "text",
  content: { text: "Plan a trip." },
  createdAt: "2026-06-01T00:00:00.000Z"
};

const directAssistantMessage: ChatMessage = {
  id: "message-assistant-1",
  workspaceId: "workspace-1",
  conversationId: "conversation-direct-1",
  senderType: "agent",
  senderId: "agent-1",
  messageType: "text",
  content: { text: "Working on it." },
  createdAt: "2026-06-01T00:00:10.000Z"
};

function renderDirectMessageList(events: AgentRunEvent[]): string {
  return renderToStaticMarkup(
    <MessageList
      activeAgentName="Travel Agent"
      agentRunEvents={events}
      emptyMessage="empty"
      emptyTitle="单聊"
      error={null}
      messages={[directUserMessage, directAssistantMessage]}
      status="ready"
    />
  );
}

describe("MessageList group run step process", () => {
  it("renders auto-dispatch plan as a DAG scheduling panel with the active node", () => {
    const markup = renderToStaticMarkup(
      <GroupRunPlanPanel
        events={[
          {
            id: "event-dag-plan",
            groupRunId: "run-dag",
            conversationId: "conversation-1",
            seq: 1,
            type: "plan_created",
            createdAt: "2026-06-01T00:00:00.000Z",
            payload: {
              mode: "auto_dispatch",
              roundIndex: 0,
              assignments: [
                {
                  stepId: "step-design",
                  stepIndex: 0,
                  roundIndex: 0,
                  assignmentId: "task-design",
                  agentId: "agent-design",
                  agentName: "Design Agent",
                  instruction: "设计接口契约。",
                  targetCriteria: ["接口契约清晰"],
                  dependsOn: [],
                  taskTitle: "设计接口",
                  expectedOutputType: "design",
                  riskLevel: "low"
                },
                {
                  stepId: "step-api",
                  stepIndex: 1,
                  roundIndex: 0,
                  assignmentId: "task-api",
                  agentId: "agent-api",
                  agentName: "Backend Agent",
                  instruction: "按接口契约实现 API。",
                  targetCriteria: ["API 通过测试"],
                  dependsOn: ["task-design"],
                  taskTitle: "实现 API",
                  expectedOutputType: "diff_proposal",
                  riskLevel: "medium"
                }
              ]
            }
          },
          {
            id: "event-design-complete",
            groupRunId: "run-dag",
            conversationId: "conversation-1",
            seq: 2,
            type: "agent_completed",
            createdAt: "2026-06-01T00:00:08.000Z",
            payload: {
              stepId: "step-design",
              stepIndex: 0,
              roundIndex: 0,
              agentId: "agent-design",
              agentName: "Design Agent",
              status: "completed",
              summary: "接口契约已完成。",
              detailAvailable: true
            }
          },
          {
            id: "event-api-start",
            groupRunId: "run-dag",
            conversationId: "conversation-1",
            seq: 3,
            type: "agent_started",
            createdAt: "2026-06-01T00:00:10.000Z",
            payload: {
              stepId: "step-api",
              stepIndex: 1,
              roundIndex: 0,
              agentId: "agent-api",
              agentName: "Backend Agent",
              status: "running"
            }
          }
        ]}
      />
    );

    expect(markup).toContain("DAG 调度状态");
    expect(markup).toContain("DAG 任务调度图");
    expect(markup).toContain("当前节点");
    expect(markup).toContain("实现 API");
    expect(markup).toContain("拓扑层</span><strong>2</strong>");
    expect(markup).toContain("依赖边</span><strong>1</strong>");
    expect(markup).toContain("group-run-dag-edge-active");
    expect(markup).toContain("group-run-dag-node-active");
  });

  it("renders sub-agent step process immediately after the dispatch plan bubble while running", () => {
    const markup = renderMessageList([
      planCreatedEvent,
      {
        id: "event-started",
        groupRunId: "run-1",
        conversationId: "conversation-1",
        seq: 2,
        type: "agent_started",
        createdAt: "2026-06-01T00:00:03.000Z",
        payload: {
          stepId: "step-frontend",
          stepIndex: 0,
          roundIndex: 0,
          agentId: "agent-frontend",
          agentName: "Frontend Agent",
          status: "running"
        }
      },
      {
        id: "event-progress",
        groupRunId: "run-1",
        conversationId: "conversation-1",
        seq: 3,
        type: "agent_progress",
        createdAt: "2026-06-01T00:00:04.000Z",
        payload: {
          stepId: "step-frontend",
          stepIndex: 0,
          roundIndex: 0,
          agentId: "agent-frontend",
          agentName: "Frontend Agent",
          status: "running",
          title: "正在读取相关组件",
          level: "info",
          phase: "context"
        }
      }
    ]);

    expect(markup).not.toContain("dispatch-plan-message");
    expect(markup).not.toContain("分派计划");
    expect(markup).toContain("已处理 ");
    expect(markup).toContain("Step 1: Frontend Agent");
    expect(markup).toContain("正在读取相关组件");
  });

  it("collapses completed runs to the processed duration and step count line", () => {
    const markup = renderMessageList([
      planCreatedEvent,
      {
        id: "event-progress",
        groupRunId: "run-1",
        conversationId: "conversation-1",
        seq: 2,
        type: "agent_progress",
        createdAt: "2026-06-01T00:00:04.000Z",
        payload: {
          stepId: "step-frontend",
          stepIndex: 0,
          roundIndex: 0,
          agentId: "agent-frontend",
          agentName: "Frontend Agent",
          status: "running",
          title: "正在读取相关组件",
          level: "info",
          phase: "context"
        }
      },
      {
        id: "event-completed-frontend",
        groupRunId: "run-1",
        conversationId: "conversation-1",
        seq: 3,
        type: "agent_completed",
        createdAt: "2026-06-01T00:00:10.000Z",
        payload: {
          stepId: "step-frontend",
          stepIndex: 0,
          roundIndex: 0,
          agentId: "agent-frontend",
          agentName: "Frontend Agent",
          status: "completed",
          summary: "Frontend report ready.",
          detailAvailable: true
        }
      },
      {
        id: "event-completed-backend",
        groupRunId: "run-1",
        conversationId: "conversation-1",
        seq: 4,
        type: "agent_completed",
        createdAt: "2026-06-01T00:00:12.000Z",
        payload: {
          stepId: "step-backend",
          stepIndex: 1,
          roundIndex: 0,
          agentId: "agent-backend",
          agentName: "Backend Agent",
          status: "completed",
          summary: "Backend report ready.",
          detailAvailable: true
        }
      },
      {
        id: "event-summary",
        groupRunId: "run-1",
        conversationId: "conversation-1",
        seq: 5,
        type: "summary_completed",
        createdAt: "2026-06-01T00:00:18.000Z",
        payload: {
          status: "completed",
          summaryMessageId: "summary-message-1",
          summary: "All done."
        }
      }
    ]);

    expect(markup).toContain("aria-expanded=\"false\"");
    expect(markup).toContain("已处理 18s / 2 个步骤");
    expect(markup).not.toContain("分派计划");
    expect(markup).not.toContain("Step 1: Frontend Agent");
    expect(markup).not.toContain("正在读取相关组件");
  });

  it("collapses retried sub-agents across redispatch rounds so the step count stops growing", () => {
    // Round 0 plan has two sub-agents; frontend fails, backend completes.
    // Round 1 redispatches only the failed frontend with a new stepId, an
    // offset stepIndex, and roundIndex 1. The frontend retry then completes.
    // The orchestrator allocates a fresh stepIndex for the retry (stepOffset
    // + index), so the retry's stepId/stepIndex/roundIndex differ from the
    // original on all three dedup axes. The post-dedup pass should keep the
    // latest attempt per agent and drop the original failed frontend step,
    // so the visible count stays at 2 instead of growing to 3.
    const markup = renderMessageList([
      planCreatedEvent,
      {
        id: "event-started-frontend",
        groupRunId: "run-1",
        conversationId: "conversation-1",
        seq: 2,
        type: "agent_started",
        createdAt: "2026-06-01T00:00:03.000Z",
        payload: {
          stepId: "step-frontend",
          stepIndex: 0,
          roundIndex: 0,
          agentId: "agent-frontend",
          agentName: "Frontend Agent",
          status: "running"
        }
      },
      {
        id: "event-failed-frontend",
        groupRunId: "run-1",
        conversationId: "conversation-1",
        seq: 3,
        type: "agent_failed",
        createdAt: "2026-06-01T00:00:10.000Z",
        payload: {
          stepId: "step-frontend",
          stepIndex: 0,
          roundIndex: 0,
          agentId: "agent-frontend",
          agentName: "Frontend Agent",
          status: "failed",
          summary: "Frontend failed",
          detailAvailable: true,
          errorMessage: "Frontend crashed"
        }
      },
      {
        id: "event-completed-backend",
        groupRunId: "run-1",
        conversationId: "conversation-1",
        seq: 4,
        type: "agent_completed",
        createdAt: "2026-06-01T00:00:12.000Z",
        payload: {
          stepId: "step-backend",
          stepIndex: 1,
          roundIndex: 0,
          agentId: "agent-backend",
          agentName: "Backend Agent",
          status: "completed",
          summary: "Backend report ready.",
          detailAvailable: true
        }
      },
      {
        id: "event-plan-round-1",
        groupRunId: "run-1",
        conversationId: "conversation-1",
        seq: 5,
        type: "plan_created",
        createdAt: "2026-06-01T00:00:15.000Z",
        payload: {
          mode: "auto_dispatch",
          roundIndex: 1,
          assignments: [
            {
              stepId: "step-frontend-retry",
              stepIndex: 2,
              roundIndex: 1,
              assignmentId: "assignment-frontend-retry",
              agentId: "agent-frontend",
              agentName: "Frontend Agent",
              instruction: "Retry frontend",
              targetCriteria: ["criterion-frontend"]
            }
          ]
        }
      },
      {
        id: "event-started-frontend-retry",
        groupRunId: "run-1",
        conversationId: "conversation-1",
        seq: 6,
        type: "agent_started",
        createdAt: "2026-06-01T00:00:18.000Z",
        payload: {
          stepId: "step-frontend-retry",
          stepIndex: 2,
          roundIndex: 1,
          agentId: "agent-frontend",
          agentName: "Frontend Agent",
          status: "running"
        }
      },
      {
        id: "event-completed-frontend-retry",
        groupRunId: "run-1",
        conversationId: "conversation-1",
        seq: 7,
        type: "agent_completed",
        createdAt: "2026-06-01T00:00:25.000Z",
        payload: {
          stepId: "step-frontend-retry",
          stepIndex: 2,
          roundIndex: 1,
          agentId: "agent-frontend",
          agentName: "Frontend Agent",
          status: "completed",
          summary: "Frontend retry report ready.",
          detailAvailable: true
        }
      }
    ]);

    // Summary line reports 2 steps (backend + frontend retry), not 3.
    // Duration text varies (m/s depending on the test's wall clock), so we
    // only assert the step count.
    expect(markup).toContain("/ 2 个步骤");

    // The original failed frontend step (stepIndex 0 → "Step 1") must be
    // replaced by the retry (stepIndex 2 → "Step 3").
    expect(markup).not.toContain("Step 1: Frontend Agent");
    expect(markup).toContain("Step 3: Frontend Agent");
    expect(markup).toContain("Step 2: Backend Agent");

    // "Frontend Agent" must appear in the markup exactly once (the retry
    // replaces the original, not the other way around).
    const frontendMatches = markup.match(/Frontend Agent/g) ?? [];
    expect(frontendMatches.length).toBe(1);

    // The retry's success status is reflected, not the original's failure.
    // STEP_STATUS_LABELS maps "completed" to "完成".
    const stepCards = markup.match(/Step \d+: Frontend Agent[\s\S]*?<\/article>/);
    expect(stepCards?.[0]).toContain("完成");
    expect(stepCards?.[0]).not.toContain("失败");
    expect(stepCards?.[0]).toContain("Frontend retry report ready.");
  });
});

describe("MessageList direct agent run step process", () => {
  it("renders the running Agent step process after the triggering user message", () => {
    const markup = renderDirectMessageList([
      {
        id: "direct-event-start",
        runId: "direct-run-1",
        conversationId: "conversation-direct-1",
        seq: 1,
        type: "run.started",
        createdAt: "2026-06-01T00:00:02.000Z"
      },
      {
        id: "direct-event-message-start",
        runId: "direct-run-1",
        conversationId: "conversation-direct-1",
        seq: 2,
        type: "message.started",
        createdAt: "2026-06-01T00:00:03.000Z",
        payload: { messageId: "message-assistant-1" }
      },
      {
        id: "direct-event-delta",
        runId: "direct-run-1",
        conversationId: "conversation-direct-1",
        seq: 3,
        type: "message.delta",
        createdAt: "2026-06-01T00:00:04.000Z",
        payload: { messageId: "message-assistant-1", delta: "Working" }
      }
    ]);

    expect(markup).toContain("已处理 ");
    expect(markup).toContain("Step 1: 准备上下文");
    expect(markup).toContain("Step 2: 生成回复");
    expect(markup).toContain("正在生成回复");
    expect(markup.indexOf("Plan a trip.")).toBeLessThan(markup.indexOf("已处理 "));
  });

  it("collapses completed direct runs to the processed duration and step count line", () => {
    const markup = renderDirectMessageList([
      {
        id: "direct-event-start",
        runId: "direct-run-1",
        conversationId: "conversation-direct-1",
        seq: 1,
        type: "run.started",
        createdAt: "2026-06-01T00:00:02.000Z"
      },
      {
        id: "direct-event-message-start",
        runId: "direct-run-1",
        conversationId: "conversation-direct-1",
        seq: 2,
        type: "message.started",
        createdAt: "2026-06-01T00:00:03.000Z",
        payload: { messageId: "message-assistant-1" }
      },
      {
        id: "direct-event-message-complete",
        runId: "direct-run-1",
        conversationId: "conversation-direct-1",
        seq: 3,
        type: "message.completed",
        createdAt: "2026-06-01T00:00:12.000Z",
        payload: { messageId: "message-assistant-1" }
      },
      {
        id: "direct-event-complete",
        runId: "direct-run-1",
        conversationId: "conversation-direct-1",
        seq: 4,
        type: "run.completed",
        createdAt: "2026-06-01T00:00:20.000Z",
        payload: { messageId: "message-assistant-1", status: "completed" }
      }
    ]);

    expect(markup).toContain("aria-expanded=\"false\"");
    expect(markup).toContain("已处理 18s / 2 个步骤");
    expect(markup).not.toContain("Step 1: 准备上下文");
    expect(markup).not.toContain("正在生成回复");
  });
});

describe("MessageList thinking indicator", () => {
  it("shows the typing dots when isSending and the last message is from the user", () => {
    const markup = renderToStaticMarkup(
      <MessageList
        activeAgentName="Travel Agent"
        emptyMessage="empty"
        emptyTitle="单聊"
        error={null}
        isSending
        messages={[directAssistantMessage, directUserMessage]}
        status="ready"
      />
    );

    expect(markup).toContain("thinking-indicator");
    expect(markup).toContain("thinking-bubble");
    expect(markup).toContain("Travel Agent 思考中");
  });

  it("hides the typing dots once an agent message has arrived, even if isSending is still true", () => {
    const markup = renderToStaticMarkup(
      <MessageList
        activeAgentName="Travel Agent"
        emptyMessage="empty"
        emptyTitle="单聊"
        error={null}
        isSending
        messages={[directUserMessage, directAssistantMessage]}
        status="ready"
      />
    );

    expect(markup).not.toContain("thinking-indicator");
    expect(markup).not.toContain("thinking-bubble");
  });

  it("hides the typing dots when isSending is false", () => {
    const markup = renderToStaticMarkup(
      <MessageList
        activeAgentName="Travel Agent"
        emptyMessage="empty"
        emptyTitle="单聊"
        error={null}
        messages={[directAssistantMessage, directUserMessage]}
        status="ready"
      />
    );

    expect(markup).not.toContain("thinking-indicator");
  });
});
