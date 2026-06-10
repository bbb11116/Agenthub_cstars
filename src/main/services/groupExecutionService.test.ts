import { describe, expect, it } from "vitest";
import { AGENT_EXECUTION_LIMITS } from "../../shared/agentExecution";
import type { AcceptanceCriterion, AgentAssignment } from "../../shared/groupChat";
import {
  createFallbackUserFacingSummary,
  parseSubAgentResult,
  reviewAcceptanceCriteria
} from "./groupExecutionService";

const criteria: AcceptanceCriterion[] = [
  {
    id: "criterion-code",
    description: "生成代码修改提案",
    type: "code_change",
    required: true,
    status: "pending"
  },
  {
    id: "criterion-test",
    description: "运行测试",
    type: "test",
    required: true,
    status: "pending"
  }
];

const assignments: AgentAssignment[] = [
  {
    id: "assignment-1",
    agentId: "agent-1",
    instruction: "实现修改并运行测试",
    targetCriteria: ["criterion-code", "criterion-test"],
    reason: "负责代码"
  }
];

describe("groupExecutionService", () => {
  it("falls back to a partial result when SubAgentResult JSON is invalid", () => {
    const result = parseSubAgentResult({
      agentId: "agent-1",
      targetCriteria: ["criterion-code"],
      rawText: "普通自然语言回复"
    });

    expect(result).toMatchObject({
      agentId: "agent-1",
      status: "partial",
      completedCriteria: [],
      unresolvedCriteria: ["criterion-code"]
    });
    expect(result.parseError).toContain("JSON object was not found");
  });

  it("completes only when every required criterion has structured evidence", () => {
    const result = parseSubAgentResult({
      agentId: "agent-1",
      targetCriteria: ["criterion-code", "criterion-test"],
      rawText: JSON.stringify({
        status: "completed",
        summary: "实现并验证通过",
        deliverable: "已完成代码修改并通过测试。",
        completedCriteria: ["criterion-code", "criterion-test"],
        unresolvedCriteria: [],
        filesRead: ["src/App.tsx"],
        assumptions: [],
        risks: []
      })
    });

    const reviewed = reviewAcceptanceCriteria({
      criteria,
      results: [result],
      assignments,
      roundIndex: 0
    });

    expect(reviewed.review.decision).toBe("complete");
    expect(reviewed.review.satisfiedCriteria).toEqual([
      "criterion-code",
      "criterion-test"
    ]);
    expect(result.deliverable).toBe("已完成代码修改并通过测试。");
  });

  it("redispatches only unresolved criteria and stops at the configured limit", () => {
    const partialResult = parseSubAgentResult({
      agentId: "agent-1",
      targetCriteria: ["criterion-code", "criterion-test"],
      rawText: JSON.stringify({
        status: "partial",
        summary: "代码已处理，测试未运行",
        completedCriteria: ["criterion-code"],
        unresolvedCriteria: ["criterion-test"],
        filesRead: ["src/App.tsx"],
        assumptions: [],
        risks: ["测试环境缺失"],
        nextSuggestedTask: "只运行测试"
      })
    });

    const firstReview = reviewAcceptanceCriteria({
      criteria,
      results: [partialResult],
      assignments,
      roundIndex: 0
    });
    expect(firstReview.review.decision).toBe("redispatch");
    expect(firstReview.review.nextAssignments).toHaveLength(1);
    expect(firstReview.review.nextAssignments[0].targetCriteria).toEqual([
      "criterion-test"
    ]);
    expect(firstReview.review.nextAssignments[0].dependsOn).toEqual([
      "assignment-1"
    ]);

    const finalReview = reviewAcceptanceCriteria({
      criteria,
      results: [partialResult],
      assignments,
      roundIndex: AGENT_EXECUTION_LIMITS.groupMaxRedispatchRounds
    });
    expect(finalReview.review.decision).toBe("partial");
    expect(finalReview.review.nextAssignments).toEqual([]);
  });

  it("creates a user-facing fallback summary without internal audit details", () => {
    const summary = createFallbackUserFacingSummary(
      {
        decision: "complete",
        satisfiedCriteria: ["criterion-code"],
        unresolvedCriteria: [],
        evidence: [],
        nextAssignments: [],
        reason: "所有 required acceptance criteria 均已获得子 Agent 结构化证据。"
      },
      [
        {
          agentId: "agent-1",
          status: "completed",
          summary: "执行摘要",
          deliverable: "这是可以直接展示给用户的完整成果。",
          completedCriteria: ["criterion-code"],
          unresolvedCriteria: [],
          filesRead: [],
          assumptions: [],
          risks: []
        }
      ]
    );

    expect(summary).toBe("这是可以直接展示给用户的完整成果。");
    expect(summary).not.toContain("Acceptance Criteria");
    expect(summary).not.toContain("criterion-code");
  });

  it("keeps artifact-backed long deliverables out of fallback summaries", () => {
    const longDeliverable = "长正文".repeat(600);
    const summary = createFallbackUserFacingSummary(
      {
        decision: "complete",
        satisfiedCriteria: ["criterion-code"],
        unresolvedCriteria: [],
        evidence: [],
        nextAssignments: [],
        reason: "完成"
      },
      [
        {
          agentId: "agent-1",
          status: "completed",
          summary: "长正文已保存为产物。",
          deliverable: longDeliverable,
          artifactIds: ["artifact-1"],
          completedCriteria: ["criterion-code"],
          unresolvedCriteria: [],
          filesRead: [],
          assumptions: [],
          risks: []
        }
      ]
    );

    expect(summary).toBe("长正文已保存为产物。\n产物: artifact-1");
    expect(summary).not.toContain(longDeliverable);
  });
});
