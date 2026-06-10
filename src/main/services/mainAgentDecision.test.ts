import { describe, expect, it } from "vitest";
import { parseMainAgentDecision } from "./mainAgentDecision";

describe("parseMainAgentDecision", () => {
  it("parses strict JSON for direct_answer", () => {
    const result = parseMainAgentDecision('{"intent":"direct_answer","responseText":"你好"}');
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.decision.intent).toBe("direct_answer");
    if (result.decision.intent === "direct_answer") {
      expect(result.decision.responseText).toBe("你好");
    }
  });

  it("falls back to direct_answer with the raw Markdown body when no JSON is present", () => {
    const markdown = "## 标题\n\n这是一段 **Markdown** 回答。\n\n- a\n- b";
    const result = parseMainAgentDecision(markdown);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.decision.intent).toBe("direct_answer");
    if (result.decision.intent === "direct_answer") {
      expect(result.decision.responseText).toBe(markdown);
    }
  });

  it("strips ```json fences before falling back", () => {
    const result = parseMainAgentDecision("```json\n{\"foo\":\"bar\"}\n```");
    // The inside parses but is not a valid decision (no intent field), so
    // the parser falls back to the full raw text as a direct_answer.
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.decision.intent).toBe("direct_answer");
  });

  it("returns ok:false only for empty output", () => {
    expect(parseMainAgentDecision("").ok).toBe(false);
    expect(parseMainAgentDecision("   \n\n  ").ok).toBe(false);
  });

  it("preserves dispatch_agents when JSON plan is well-formed", () => {
    const json = JSON.stringify({
      intent: "dispatch_agents",
      responseText: "我先让 A 处理。",
      acceptanceCriteria: [
        { id: "c1", description: "完成 X", type: "code_change", required: true }
      ],
      plan: {
        executionMode: "sequential",
        steps: [
          {
            id: "s1",
            agentId: "agent-a",
            instruction: "做 X",
            expectedOutput: "diff_proposal"
          }
        ]
      }
    });
    const result = parseMainAgentDecision(json);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.decision.intent).toBe("dispatch_agents");
  });

  it("preserves DAG subTask dependencies when they reference earlier tasks", () => {
    const json = JSON.stringify({
      intent: "dispatch_agents",
      responseText: "按 DAG 分派。",
      acceptanceCriteria: [
        { id: "c1", description: "完成设计", type: "analysis", required: true },
        { id: "c2", description: "完成实现", type: "code_change", required: true }
      ],
      plan: {
        executionMode: "dag",
        steps: [],
        subTasks: [
          {
            id: "design",
            title: "设计方案",
            objective: "先给出实现方案",
            acceptanceCriteria: ["c1"],
            requiredSkillQueries: ["design"],
            requiredTools: ["read_file"],
            taskType: "design",
            dependsOn: [],
            riskLevel: "low",
            expectedOutputType: "design"
          },
          {
            id: "implement",
            title: "实现修改",
            objective: "基于设计方案实现",
            acceptanceCriteria: ["c2"],
            requiredSkillQueries: ["implementation"],
            requiredTools: ["read_file", "write_diff"],
            taskType: "code_change",
            dependsOn: ["design"],
            riskLevel: "medium",
            expectedOutputType: "diff_proposal"
          }
        ]
      }
    });

    const result = parseMainAgentDecision(json);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.decision.intent).toBe("dispatch_agents");
    if (result.decision.intent !== "dispatch_agents") return;
    expect(result.decision.plan.subTasks?.[1].dependsOn).toEqual(["design"]);
  });

  it("falls back to direct_answer when subTask dependencies are invalid", () => {
    const json = JSON.stringify({
      intent: "dispatch_agents",
      responseText: "尝试分派。",
      plan: {
        executionMode: "dag",
        steps: [],
        subTasks: [
          {
            id: "implement",
            title: "实现修改",
            objective: "不能依赖后续任务",
            acceptanceCriteria: [],
            requiredSkillQueries: [],
            requiredTools: ["read_file", "write_diff"],
            taskType: "code_change",
            dependsOn: ["review"],
            riskLevel: "medium",
            expectedOutputType: "diff_proposal"
          },
          {
            id: "review",
            title: "评审修改",
            objective: "评审实现",
            acceptanceCriteria: [],
            requiredSkillQueries: [],
            requiredTools: ["read_file"],
            taskType: "review",
            dependsOn: [],
            riskLevel: "low",
            expectedOutputType: "analysis"
          }
        ]
      }
    });

    const result = parseMainAgentDecision(json);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.decision.intent).toBe("direct_answer");
  });

  it("falls back to direct_answer when dispatch_agents plan is missing", () => {
    const json = JSON.stringify({
      intent: "dispatch_agents",
      responseText: "我会分派。"
    });
    const result = parseMainAgentDecision(json);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.decision.intent).toBe("direct_answer");
  });

  it("falls back to direct_answer when the intent is unknown", () => {
    const result = parseMainAgentDecision('{"intent":"do_something_else","responseText":"x"}');
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.decision.intent).toBe("direct_answer");
  });
});
