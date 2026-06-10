import type { AcceptanceCriterion, SubTask } from "../../shared/groupChat";

export const MANUAL_SUB_AGENT_CREATION_GUIDANCE_TEXT =
  "当前版本请点击左上角加号手动创建子 Agent。";

export function shouldRedirectManualSubAgentCreation(rawText: string): boolean {
  const normalizedText = rawText.trim().toLowerCase();

  return (
    /agent|智能体|代理|助手/.test(normalizedText) &&
    /创建|新增|添加|生成|配置|create|add|new|make|build|setup/.test(normalizedText)
  );
}

export type DispatchPlanStepInput = {
  id?: string;
  agentId: string;
  instruction: string;
  expectedOutput: "text" | "diff_proposal" | "review_report";
  targetCriteria?: string[];
  reason?: string;
};

export type MainAgentDecision =
  | {
      intent: "direct_answer";
      responseText: string;
    }
  | {
      intent: "ask_clarification";
      responseText: string;
    }
  | {
      intent: "dispatch_agents";
      responseText: string;
      acceptanceCriteria?: AcceptanceCriterion[];
      plan: {
        executionMode: "sequential" | "dag";
        steps: DispatchPlanStepInput[];
        subTasks?: SubTask[];
      };
    };

export type DecisionParseResult =
  | { ok: true; decision: MainAgentDecision }
  | { ok: false; error: string };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

function stripMarkdownFences(text: string): string {
  let cleaned = text.trim();
  cleaned = cleaned.replace(/^```(?:json)?\s*\n?/i, "");
  cleaned = cleaned.replace(/\n?```\s*$/i, "");
  return cleaned.trim();
}

function extractJson(text: string): string | null {
  const stripped = stripMarkdownFences(text);

  // Try parsing the whole thing first
  try {
    JSON.parse(stripped);
    return stripped;
  } catch {
    // fall through
  }

  // Find first { and last }
  const firstBrace = stripped.indexOf("{");
  const lastBrace = stripped.lastIndexOf("}");
  if (firstBrace === -1 || lastBrace === -1 || lastBrace <= firstBrace) {
    return null;
  }

  const candidate = stripped.slice(firstBrace, lastBrace + 1);
  try {
    JSON.parse(candidate);
    return candidate;
  } catch {
    return null;
  }
}

const VALID_EXPECTED_OUTPUTS = ["text", "diff_proposal", "review_report"] as const;

const VALID_SUBTASK_RISK_LEVELS = ["low", "medium", "high"] as const;
const VALID_SUBTASK_OUTPUT_TYPES = [
  "analysis",
  "design",
  "diff_proposal",
  "test_plan",
  "summary"
] as const;

function optionalStringArray(value: unknown): string[] | undefined {
  return isStringArray(value) ? value.map((item) => item.trim()).filter(Boolean) : undefined;
}

function hasCyclicDependencies(subTasks: SubTask[]): boolean {
  const byId = new Map(subTasks.map((task) => [task.id, task]));
  const visiting = new Set<string>();
  const visited = new Set<string>();

  const visit = (taskId: string): boolean => {
    if (visited.has(taskId)) {
      return false;
    }
    if (visiting.has(taskId)) {
      return true;
    }
    const task = byId.get(taskId);
    if (!task) {
      return true;
    }

    visiting.add(taskId);
    for (const dependencyId of task.dependsOn) {
      if (visit(dependencyId)) {
        return true;
      }
    }
    visiting.delete(taskId);
    visited.add(taskId);
    return false;
  };

  return subTasks.some((task) => visit(task.id));
}

function validateSubTasks(value: unknown): SubTask[] | undefined {
  if (!Array.isArray(value) || value.length === 0) {
    return undefined;
  }

  const subTasks: SubTask[] = [];
  const seenIds = new Set<string>();

  for (let i = 0; i < value.length; i++) {
    const item = value[i];
    if (!isRecord(item)) {
      return undefined;
    }

    const id = typeof item.id === "string" && item.id.trim() ? item.id.trim() : `task-${i + 1}`;
    if (seenIds.has(id)) {
      return undefined;
    }
    seenIds.add(id);

    if (typeof item.title !== "string" || item.title.trim().length === 0) {
      return undefined;
    }
    if (typeof item.objective !== "string" || item.objective.trim().length === 0) {
      return undefined;
    }

    const riskLevel = typeof item.riskLevel === "string" ? item.riskLevel : "low";
    if (!VALID_SUBTASK_RISK_LEVELS.includes(riskLevel as typeof VALID_SUBTASK_RISK_LEVELS[number])) {
      return undefined;
    }

    const expectedOutputType =
      typeof item.expectedOutputType === "string" ? item.expectedOutputType : "analysis";
    if (!VALID_SUBTASK_OUTPUT_TYPES.includes(expectedOutputType as typeof VALID_SUBTASK_OUTPUT_TYPES[number])) {
      return undefined;
    }

    if (!isStringArray(item.dependsOn)) {
      return undefined;
    }
    const dependsOn = optionalStringArray(item.dependsOn) ?? [];
    if (dependsOn.includes(id)) {
      return undefined;
    }
    subTasks.push({
      id,
      title: item.title.trim(),
      objective: item.objective.trim(),
      acceptanceCriteria: optionalStringArray(item.acceptanceCriteria) ?? [],
      requiredSkillQueries: optionalStringArray(item.requiredSkillQueries) ?? [],
      requiredTools: optionalStringArray(item.requiredTools) ?? [],
      taskType:
        typeof item.taskType === "string" && item.taskType.trim()
          ? item.taskType.trim()
          : "general",
      targetFiles: optionalStringArray(item.targetFiles),
      dependsOn,
      riskLevel: riskLevel as SubTask["riskLevel"],
      expectedOutputType: expectedOutputType as SubTask["expectedOutputType"]
    });
  }

  const ids = new Set(subTasks.map((task) => task.id));
  if (subTasks.some((task) => task.dependsOn.some((dependencyId) => !ids.has(dependencyId)))) {
    return undefined;
  }
  const indexById = new Map(subTasks.map((task, index) => [task.id, index]));
  if (
    subTasks.some((task, index) =>
      task.dependsOn.some((dependencyId) => (indexById.get(dependencyId) ?? Infinity) >= index)
    )
  ) {
    return undefined;
  }
  if (hasCyclicDependencies(subTasks)) {
    return undefined;
  }

  return subTasks;
}

function validateDispatchPlan(plan: unknown): { ok: true; plan: { executionMode: "sequential" | "dag"; steps: DispatchPlanStepInput[]; subTasks?: SubTask[] } } | { ok: false; error: string } {
  if (!isRecord(plan)) {
    return { ok: false, error: "Plan must be an object." };
  }

  const executionMode = plan.executionMode === "dag" ? "dag" : "sequential";
  const subTasks = validateSubTasks(plan.subTasks);

  if (!Array.isArray(plan.steps) && (!subTasks || subTasks.length === 0)) {
    return { ok: false, error: "Plan steps or subTasks must be a non-empty array." };
  }

  if (Array.isArray(plan.steps) && plan.steps.length === 0 && (!subTasks || subTasks.length === 0)) {
    return { ok: false, error: "Plan steps or subTasks must be a non-empty array." };
  }

  const steps: DispatchPlanStepInput[] = [];

  const rawSteps = Array.isArray(plan.steps) ? plan.steps : [];
  for (let i = 0; i < rawSteps.length; i++) {
    const step = rawSteps[i];
    if (!isRecord(step)) {
      return { ok: false, error: `Step ${i} must be an object.` };
    }
    if (typeof step.agentId !== "string" || step.agentId.trim().length === 0) {
      return { ok: false, error: `Step ${i} 'agentId' must be a non-empty string.` };
    }
    if (typeof step.instruction !== "string" || step.instruction.trim().length === 0) {
      return { ok: false, error: `Step ${i} 'instruction' must be a non-empty string.` };
    }
    const expectedOutput = typeof step.expectedOutput === "string" ? step.expectedOutput : "text";
    if (!VALID_EXPECTED_OUTPUTS.includes(expectedOutput as typeof VALID_EXPECTED_OUTPUTS[number])) {
      return { ok: false, error: `Step ${i} 'expectedOutput' must be one of: ${VALID_EXPECTED_OUTPUTS.join(", ")}.` };
    }
    steps.push({
      id: typeof step.id === "string" ? step.id.trim() : undefined,
      agentId: step.agentId.trim(),
      instruction: step.instruction.trim(),
      expectedOutput: expectedOutput as DispatchPlanStepInput["expectedOutput"],
      targetCriteria: isStringArray(step.targetCriteria) ? step.targetCriteria : undefined,
      reason: typeof step.reason === "string" ? step.reason.trim() : undefined
    });
  }

  return { ok: true, plan: { executionMode, steps, subTasks } };
}

function validateAcceptanceCriteria(
  value: unknown
): AcceptanceCriterion[] | undefined {
  if (!Array.isArray(value)) return undefined;

  const validTypes = ["code_change", "test", "ui", "doc", "analysis", "constraint"];
  const criteria: AcceptanceCriterion[] = [];

  for (const item of value) {
    if (
      !isRecord(item) ||
      typeof item.id !== "string" ||
      typeof item.description !== "string" ||
      !validTypes.includes(String(item.type)) ||
      typeof item.required !== "boolean"
    ) {
      return undefined;
    }

    criteria.push({
      id: item.id.trim(),
      description: item.description.trim(),
      type: item.type as AcceptanceCriterion["type"],
      required: item.required,
      status: "pending"
    });
  }

  return criteria;
}

export function parseMainAgentDecision(rawText: string): DecisionParseResult {
  const trimmed = rawText.trim();

  // Empty output: nothing to respond with. The caller can decide whether to
  // surface a "no response" message or fall back to a generic reply.
  if (trimmed.length === 0) {
    return {
      ok: false,
      error: "LLM output is empty."
    };
  }

  const jsonStr = extractJson(trimmed);

  // Markdown body fallback: if we cannot extract a decision JSON, treat the
  // raw text as a `direct_answer` response. The orchestrator system prompt
  // tells the LLM to reply in Markdown, so this is the expected path for
  // most user messages in both single chat and group chat. The renderer
  // will render the Markdown as-is. The caller (dispatchService) will
  // decide whether to dispatch sub-agents based on @-mentions and the
  // conversation mode, not on this LLM-emitted intent.
  if (!jsonStr) {
    return {
      ok: true,
      decision: { intent: "direct_answer", responseText: trimmed }
    };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonStr);
  } catch {
    // Malformed JSON: fall back to Markdown body. The previous behaviour
    // was to throw "JSON parse error", which broke group chat whenever the
    // LLM wrote any prose around its decision. The unified runtime policy
    // explicitly tells the LLM to reply in Markdown, so this fallback is
    // the expected default rather than a degenerate case.
    return {
      ok: true,
      decision: { intent: "direct_answer", responseText: trimmed }
    };
  }

  if (!isRecord(parsed)) {
    return { ok: true, decision: { intent: "direct_answer", responseText: trimmed } };
  }

  if (typeof parsed.intent !== "string") {
    return { ok: true, decision: { intent: "direct_answer", responseText: trimmed } };
  }

  if (typeof parsed.responseText !== "string") {
    parsed.responseText = trimmed;
  }

  const intent = parsed.intent;
  const responseText = typeof parsed.responseText === "string"
    ? parsed.responseText
    : trimmed;

  switch (intent) {
    case "direct_answer":
      return {
        ok: true,
        decision: { intent: "direct_answer", responseText }
      };

    case "ask_clarification":
      return {
        ok: true,
        decision: { intent: "ask_clarification", responseText }
      };

    case "dispatch_agents": {
      if (!("plan" in parsed) || !isRecord(parsed.plan)) {
        // Plan is missing/invalid: treat as a direct answer so the LLM's
        // reply still reaches the user. The dispatch service will fall
        // back to @-mention-based dispatch.
        return { ok: true, decision: { intent: "direct_answer", responseText } };
      }

      const planResult = validateDispatchPlan(parsed.plan);
      if (!planResult.ok) {
        return { ok: true, decision: { intent: "direct_answer", responseText } };
      }

      return {
        ok: true,
        decision: {
          intent: "dispatch_agents",
          responseText,
          acceptanceCriteria: validateAcceptanceCriteria(parsed.acceptanceCriteria),
          plan: planResult.plan
        }
      };
    }

    default:
      return {
        ok: true,
        decision: { intent: "direct_answer", responseText }
      };
  }
}
