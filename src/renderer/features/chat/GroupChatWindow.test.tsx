import { describe, expect, it } from "vitest";
import type { GroupRunEvent } from "../../../shared/groupChat";
import { mergeGroupRunEvents } from "./GroupChatWindow";

describe("mergeGroupRunEvents", () => {
  it("drops fallback plan events when the real run plan is available", () => {
    const fallbackPlan: GroupRunEvent = {
      id: "fallback-plan-message",
      groupRunId: "run-1",
      conversationId: "conversation-1",
      seq: 0,
      type: "plan_created",
      createdAt: "2026-06-01T00:00:00.000Z",
      payload: {
        mode: "auto_dispatch",
        roundIndex: 1,
        assignments: [
          {
            stepId: "run-1-step-0",
            stepIndex: 0,
            roundIndex: 1,
            assignmentId: "assignment-retry",
            agentId: "agent-ui",
            agentName: "UI Agent",
            instruction: "Fallback retry plan",
            targetCriteria: []
          }
        ]
      }
    };

    const realPlan: GroupRunEvent = {
      id: "real-plan",
      groupRunId: "run-1",
      conversationId: "conversation-1",
      seq: 5,
      type: "plan_created",
      createdAt: "2026-06-01T00:00:00.000Z",
      payload: {
        mode: "auto_dispatch",
        roundIndex: 1,
        assignments: [
          {
            stepId: "step-retry",
            stepIndex: 4,
            roundIndex: 1,
            assignmentId: "assignment-retry",
            agentId: "agent-ui",
            agentName: "UI Agent",
            instruction: "Real retry plan",
            targetCriteria: []
          }
        ]
      }
    };

    const realCompleted: GroupRunEvent = {
      id: "real-completed",
      groupRunId: "run-1",
      conversationId: "conversation-1",
      seq: 6,
      type: "agent_completed",
      createdAt: "2026-06-01T00:00:05.000Z",
      payload: {
        stepId: "step-retry",
        stepIndex: 4,
        roundIndex: 1,
        agentId: "agent-ui",
        agentName: "UI Agent",
        status: "partial",
        summary: "Retry finished partially.",
        detailAvailable: true
      }
    };

    const merged = mergeGroupRunEvents([fallbackPlan], [realPlan, realCompleted]);

    expect(merged.map((event) => event.id)).toEqual(["real-plan", "real-completed"]);
  });
});
