import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { Message } from "../../../shared/domain";
import { MessageRenderer } from "./MessageRenderer";

describe("MessageRenderer", () => {
  it("renders historical Agent draft cards as an unsupported legacy fallback", () => {
    const message: Message = {
      id: "message-1",
      workspaceId: "workspace-1",
      conversationId: "conversation-1",
      senderType: "agent",
      senderId: "main-agent-1",
      messageType: "agent_config_card",
      content: {
        draftId: "draft-1",
        name: "Weather Agent",
        description: "Answers city weather questions.",
        runtimeProvider: "builtin_openai",
        systemPrompt: "Answer city weather questions.",
        capabilities: ["weather"],
        tools: {
          readFile: false,
          writeDiff: false,
          applyDiff: false,
          previewArtifact: false,
          gitStatus: false
        },
        fileScope: [],
        status: "draft"
      },
      createdAt: "2026-06-01T00:00:00.000Z"
    };

    const markup = renderToStaticMarkup(<MessageRenderer message={message} />);

    expect(markup).toContain("该旧版 Agent 创建卡片已不再支持。");
    expect(markup).not.toContain("Weather Agent");
    expect(markup).not.toContain("agent_config_card");
  });

  it("renders dispatch_plan messages with assignment metadata", () => {
    const message: Message = {
      id: "message-2",
      workspaceId: "workspace-1",
      conversationId: "conversation-1",
      senderType: "agent",
      senderId: "main-agent-1",
      messageType: "dispatch_plan",
      content: { text: "fallback plan" },
      metadata: {
        assignments: [
          {
            agentId: "agent-frontend",
            instruction: "Inspect UI state handling.",
            targetCriteria: ["criterion-1"]
          }
        ],
        agentNames: {
          "agent-frontend": "Frontend Agent"
        }
      },
      createdAt: "2026-06-01T00:00:00.000Z"
    };

    const markup = renderToStaticMarkup(<MessageRenderer message={message} />);

    expect(markup).toContain("分派计划");
    expect(markup).toContain("Frontend Agent");
    expect(markup).toContain("Inspect UI state handling.");
  });

  it("renders agent_assignment messages without expanding sub-agent internals", () => {
    const message: Message = {
      id: "message-3",
      workspaceId: "workspace-1",
      conversationId: "conversation-1",
      senderType: "agent",
      senderId: "agent-frontend",
      messageType: "agent_assignment",
      content: { text: "fallback result" },
      metadata: {
        agentName: "Frontend Agent",
        subAgentResult: {
          agentId: "agent-frontend",
          status: "completed",
          summary: "Found no UI regression.",
          deliverable: "Report ready.",
          completedCriteria: ["criterion-1"],
          unresolvedCriteria: [],
          filesRead: ["src/renderer/App.tsx"],
          filesChanged: [],
          assumptions: [],
          risks: []
        }
      },
      createdAt: "2026-06-01T00:00:00.000Z"
    };

    const markup = renderToStaticMarkup(<MessageRenderer message={message} />);

    expect(markup).toContain("子 Agent 执行结果");
    expect(markup).toContain("Found no UI regression.");
    expect(markup).toContain("查看详情");
    expect(markup).not.toContain("Files Read");
    expect(markup).not.toContain("src/renderer/App.tsx");
  });

  it("renders orchestrator_summary messages without expanding review metadata", () => {
    const message: Message = {
      id: "message-4",
      workspaceId: "workspace-1",
      conversationId: "conversation-1",
      senderType: "agent",
      senderId: "main-agent-1",
      messageType: "orchestrator_summary",
      content: { text: "All reports are complete." },
      metadata: {
        acceptanceCriteria: [
          {
            id: "criterion-1",
            description: "Collect frontend report.",
            type: "analysis",
            required: true,
            status: "satisfied"
          }
        ],
        orchestratorReview: {
          decision: "complete",
          satisfiedCriteria: ["criterion-1"],
          unresolvedCriteria: [],
          evidence: [],
          nextAssignments: [],
          reason: "All criteria were satisfied."
        },
        subAgentResults: [
          {
            agentId: "agent-frontend",
            status: "completed",
            summary: "Report ready.",
            completedCriteria: ["criterion-1"],
            unresolvedCriteria: [],
            filesRead: [],
            assumptions: [],
            risks: []
          }
        ]
      },
      createdAt: "2026-06-01T00:00:00.000Z"
    };

    const markup = renderToStaticMarkup(<MessageRenderer message={message} />);

    expect(markup).toContain("主 Agent 总结");
    expect(markup).toContain("All reports are complete.");
    expect(markup).not.toContain("All criteria were satisfied.");
    expect(markup).not.toContain("Collect frontend report.");
    expect(markup).not.toContain("Report ready.");
  });
});
