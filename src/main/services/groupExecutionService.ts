import { randomUUID } from "node:crypto";
import { AGENT_EXECUTION_LIMITS, type AgentRunResult } from "../../shared/agentExecution";
import type {
  AcceptanceCriterion,
  AgentAssignment,
  OrchestratorReview,
  SubAgentEvidence,
  SubAgentOutputRef,
  SubAgentResult,
  SubAgentResultMetadata
} from "../../shared/groupChat";

type ParseSubAgentResultInput = {
  agentId: string;
  targetCriteria: string[];
  rawText: string;
  runResult?: AgentRunResult;
  runMetadata?: SubAgentResultMetadata;
};

type ReviewAcceptanceCriteriaInput = {
  criteria: AcceptanceCriterion[];
  results: SubAgentResult[];
  assignments: AgentAssignment[];
  roundIndex: number;
};

const MAX_INLINE_FALLBACK_DELIVERABLE_LENGTH = 1_500;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

function isOutputType(value: unknown): value is SubAgentOutputRef["type"] {
  return (
    value === "markdown" ||
    value === "text" ||
    value === "diff" ||
    value === "file" ||
    value === "json" ||
    value === "command_result"
  );
}

function parseOutputs(value: unknown): SubAgentOutputRef[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }

  const outputs = value
    .map((item): SubAgentOutputRef | null => {
      if (!isRecord(item) || !isOutputType(item.type)) {
        return null;
      }
      return {
        type: item.type,
        artifactId: typeof item.artifactId === "string" ? item.artifactId : undefined,
        diffProposalId:
          typeof item.diffProposalId === "string" ? item.diffProposalId : undefined,
        filePath: typeof item.filePath === "string" ? item.filePath : undefined,
        preview: typeof item.preview === "string" ? item.preview : undefined,
        isComplete: typeof item.isComplete === "boolean" ? item.isComplete : undefined
      };
    })
    .filter((item): item is SubAgentOutputRef => item !== null);

  return outputs.length > 0 ? outputs : undefined;
}

function parseEvidence(
  value: unknown,
  targetCriteria: string[]
): SubAgentEvidence[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }

  const evidence = value
    .map((item): SubAgentEvidence | null => {
      if (
        !isRecord(item) ||
        typeof item.criterionId !== "string" ||
        !targetCriteria.includes(item.criterionId) ||
        typeof item.summary !== "string"
      ) {
        return null;
      }

      return {
        criterionId: item.criterionId,
        artifactId: typeof item.artifactId === "string" ? item.artifactId : undefined,
        outputIndex: typeof item.outputIndex === "number" ? item.outputIndex : undefined,
        summary: item.summary
      };
    })
    .filter((item): item is SubAgentEvidence => item !== null);

  return evidence.length > 0 ? evidence : undefined;
}

function extractJson(text: string): unknown {
  const trimmed = text.trim();
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = fenced?.[1]?.trim() ?? trimmed;

  try {
    return JSON.parse(candidate);
  } catch {
    const firstBrace = candidate.indexOf("{");
    const lastBrace = candidate.lastIndexOf("}");
    if (firstBrace === -1 || lastBrace <= firstBrace) {
      throw new Error("SubAgentResult JSON object was not found.");
    }
    return JSON.parse(candidate.slice(firstBrace, lastBrace + 1));
  }
}

function inferCriterionType(
  userMessage: string
): AcceptanceCriterion["type"] {
  if (/测试|test|vitest|jest|验证/i.test(userMessage)) return "test";
  if (/ui|界面|页面|组件|样式/i.test(userMessage)) return "ui";
  if (/文档|readme|doc/i.test(userMessage)) return "doc";
  if (/代码|实现|修复|修改|新增|重构|bug|fix|feature/i.test(userMessage)) {
    return "code_change";
  }
  return "analysis";
}

export function buildDefaultAcceptanceCriteria(userMessage: string): AcceptanceCriterion[] {
  return [
    {
      id: "criterion-1",
      description: userMessage.trim() || "完成用户请求",
      type: inferCriterionType(userMessage),
      required: true,
      status: "pending"
    }
  ];
}

export function parseSubAgentResult({
  agentId,
  targetCriteria,
  rawText,
  runResult,
  runMetadata
}: ParseSubAgentResultInput): SubAgentResult {
  try {
    const parsed = extractJson(rawText);

    if (!isRecord(parsed)) {
      throw new Error("SubAgentResult must be a JSON object.");
    }

    const validStatuses: SubAgentResult["status"][] = [
      "completed",
      "partial",
      "failed",
      "no_changes_needed",
      "iteration_limit_reached"
    ];
    if (!validStatuses.includes(parsed.status as SubAgentResult["status"])) {
      throw new Error("SubAgentResult.status is invalid.");
    }
    if (typeof parsed.summary !== "string") {
      throw new Error("SubAgentResult.summary is required.");
    }
    if (!isStringArray(parsed.completedCriteria)) {
      throw new Error("SubAgentResult.completedCriteria must be a string array.");
    }
    if (!isStringArray(parsed.unresolvedCriteria)) {
      throw new Error("SubAgentResult.unresolvedCriteria must be a string array.");
    }
    if (!isStringArray(parsed.filesRead)) {
      throw new Error("SubAgentResult.filesRead must be a string array.");
    }
    if (!isStringArray(parsed.assumptions)) {
      throw new Error("SubAgentResult.assumptions must be a string array.");
    }
    if (!isStringArray(parsed.risks)) {
      throw new Error("SubAgentResult.risks must be a string array.");
    }

    const completedCriteria = parsed.completedCriteria.filter((id) =>
      targetCriteria.includes(id)
    );
    const unresolvedCriteria = parsed.unresolvedCriteria.filter((id) =>
      targetCriteria.includes(id)
    );
    const outputs = parseOutputs(parsed.outputs);
    const evidence = parseEvidence(parsed.evidence, targetCriteria);
    const artifactIds = isStringArray(parsed.artifactIds)
      ? parsed.artifactIds
      : outputs
          ?.map((output) => output.artifactId)
          .filter((id): id is string => typeof id === "string");

    let parsedStatus = parsed.status as SubAgentResult["status"];
    const runReportedFailure =
      runResult?.status === "failed" || runResult?.status === "verification_failed";
    if (
      parsedStatus === "completed" &&
      (runMetadata?.outputTruncated || runMetadata?.timeoutTriggered || runReportedFailure)
    ) {
      parsedStatus = "partial";
    }

    const successMetadata: SubAgentResultMetadata = {
      ...runMetadata,
      parseSucceeded: true,
      rawTextLength: rawText.length
    };

    return {
      agentId,
      status: parsedStatus,
      summary: parsed.summary,
      deliverable:
        typeof parsed.deliverable === "string" && parsed.deliverable.trim()
          ? parsed.deliverable
          : parsed.summary,
      outputs,
      evidence,
      artifactIds: artifactIds && artifactIds.length > 0 ? artifactIds : undefined,
      completedCriteria,
      unresolvedCriteria,
      filesRead: parsed.filesRead,
      filesChanged: isStringArray(parsed.filesChanged) ? parsed.filesChanged : undefined,
      diffProposalId:
        typeof parsed.diffProposalId === "string" ? parsed.diffProposalId : undefined,
      verification: isRecord(parsed.verification) &&
        isStringArray(parsed.verification.commandsRun) &&
        typeof parsed.verification.passed === "boolean"
        ? {
            commandsRun: parsed.verification.commandsRun,
            passed: parsed.verification.passed,
            outputSummary:
              typeof parsed.verification.outputSummary === "string"
                ? parsed.verification.outputSummary
                : undefined
          }
        : undefined,
      assumptions: parsed.assumptions,
      risks: parsed.risks,
      nextSuggestedTask:
        typeof parsed.nextSuggestedTask === "string"
          ? parsed.nextSuggestedTask
          : undefined,
      metadata: successMetadata,
      runResult
    };
  } catch (error) {
    const parseError = error instanceof Error ? error.message : "Unknown parse error.";
    const trimmedText = rawText.trim();

    if (!trimmedText) {
      const failureMetadata: SubAgentResultMetadata = {
        ...runMetadata,
        parseSucceeded: false,
        parseError,
        rawTextLength: 0
      };
      return {
        agentId,
        status: "failed",
        summary: "子 Agent 没有返回任何内容。",
        completedCriteria: [],
        unresolvedCriteria: [...targetCriteria],
        filesRead: [],
        assumptions: [],
        risks: [`结构化 SubAgentResult 解析失败: ${parseError}`],
        nextSuggestedTask: "重新分派该任务以获取实际内容。",
        parseError,
        metadata: failureMetadata,
        runResult
      };
    }

    const summaryPreview =
      trimmedText.length > 200 ? `${trimmedText.slice(0, 200)}...` : trimmedText;

    const fallbackStatus: SubAgentResult["status"] =
      runResult?.status === "iteration_limit_reached"
        ? "iteration_limit_reached"
        : runResult?.status === "failed" || runResult?.status === "verification_failed"
          ? "failed"
          : "partial";

    const fallbackMetadata: SubAgentResultMetadata = {
      ...runMetadata,
      parseSucceeded: false,
      parseError,
      rawTextLength: trimmedText.length,
      outputTruncated: runMetadata?.outputTruncated ?? true
    };

    return {
      agentId,
      status: fallbackStatus,
      summary: summaryPreview,
      deliverable: trimmedText,
      completedCriteria: [],
      unresolvedCriteria: [...targetCriteria],
      filesRead: [],
      assumptions: [],
      risks: [`结构化 SubAgentResult 解析失败: ${parseError}`],
      nextSuggestedTask: "仅针对未完成验收项继续执行，并返回合法 SubAgentResult JSON。",
      parseError,
      metadata: fallbackMetadata,
      runResult
    };
  }
}

export function createFallbackUserFacingSummary(
  review: OrchestratorReview,
  results: SubAgentResult[]
): string {
  const deliverables = results
    .filter((result) =>
      result.status === "completed" || result.status === "no_changes_needed"
    )
    .map((result) => {
      const artifactIds = result.artifactIds ?? [];
      const hasArtifacts = artifactIds.length > 0;
      const deliverable = result.deliverable?.trim();
      const displayText =
        deliverable &&
        !hasArtifacts &&
        deliverable.length <= MAX_INLINE_FALLBACK_DELIVERABLE_LENGTH
          ? deliverable
          : result.summary.trim();
      const artifactText =
        hasArtifacts
          ? `\n产物: ${artifactIds.join(", ")}`
          : "";
      return `${displayText}${artifactText}`;
    })
    .filter((text, index, all) => Boolean(text) && all.indexOf(text) === index);
  const body = deliverables.join("\n\n---\n\n");

  if (review.decision === "complete") {
    return body || "任务已完成。";
  }

  const statusText =
    review.decision === "need_user_input"
      ? "当前信息不足，需要补充信息后继续处理。"
      : review.decision === "partial"
        ? "任务已部分完成，仍有内容未能完成。"
        : "任务未能完成。";

  return body ? `${body}\n\n${statusText}` : statusText;
}

function createRepairAssignments(
  unresolvedCriteria: string[],
  assignments: AgentAssignment[],
  results: SubAgentResult[]
): AgentAssignment[] {
  const repairs: AgentAssignment[] = [];
  const seenAgentIds = new Set<string>();

  for (const assignment of assignments) {
    if (seenAgentIds.has(assignment.agentId)) continue;

    const targetCriteria = assignment.targetCriteria.filter((criterionId) =>
      unresolvedCriteria.includes(criterionId)
    );
    if (targetCriteria.length === 0) continue;

    const latestResult = [...results]
      .reverse()
      .find((result) => result.agentId === assignment.agentId);
    const repairInstruction = latestResult?.nextSuggestedTask?.trim();
    const repairedNodeId = assignment.subTask?.id ?? assignment.id;
    const dependsOn = [...new Set([
      ...(assignment.dependsOn ?? []),
      repairedNodeId
    ])];

    repairs.push({
      id: randomUUID(),
      agentId: assignment.agentId,
      instruction: [
        `修复上一轮未完成验收项: ${targetCriteria.join(", ")}`,
        repairInstruction || assignment.instruction,
        "不要重复处理已经满足的验收项。"
      ].join("\n"),
      targetCriteria,
      dependsOn,
      reason: "上一轮审核仍有未完成验收项。"
    });
    seenAgentIds.add(assignment.agentId);

    if (repairs.length >= AGENT_EXECUTION_LIMITS.groupMaxAgentsPerRound) {
      break;
    }
  }

  return repairs;
}

export function reviewAcceptanceCriteria({
  criteria,
  results,
  assignments,
  roundIndex
}: ReviewAcceptanceCriteriaInput): {
  criteria: AcceptanceCriterion[];
  review: OrchestratorReview;
} {
  const evidence: OrchestratorReview["evidence"] = [];
  const satisfied = new Set<string>();

  for (const result of results) {
    for (const criterionId of result.completedCriteria) {
      if (!criteria.some((criterion) => criterion.id === criterionId)) continue;
      const criterionEvidence = result.evidence?.find(
        (item) => item.criterionId === criterionId
      );
      satisfied.add(criterionId);
      evidence.push({
        criterionId,
        sourceAgentId: result.agentId,
        evidenceText: criterionEvidence?.summary ?? result.summary
      });
    }
  }

  const nextCriteria = criteria.map((criterion) => {
    if (satisfied.has(criterion.id)) {
      const criterionEvidence = evidence
        .filter((item) => item.criterionId === criterion.id)
        .map((item) => item.evidenceText)
        .join("\n");
      return {
        ...criterion,
        status: "satisfied" as const,
        evidence: criterionEvidence || criterion.evidence
      };
    }

    const failed = results.some(
      (result) =>
        result.status === "failed" &&
        result.unresolvedCriteria.includes(criterion.id)
    );
    return {
      ...criterion,
      status: failed ? "failed" as const : "unknown" as const
    };
  });

  const satisfiedCriteria = nextCriteria
    .filter((criterion) => criterion.status === "satisfied")
    .map((criterion) => criterion.id);
  const unresolvedCriteria = nextCriteria
    .filter((criterion) => criterion.required && criterion.status !== "satisfied")
    .map((criterion) => criterion.id);

  if (unresolvedCriteria.length === 0) {
    return {
      criteria: nextCriteria,
      review: {
        decision: "complete",
        satisfiedCriteria,
        unresolvedCriteria: [],
        evidence,
        nextAssignments: [],
        reason: "所有 required acceptance criteria 均已获得子 Agent 结构化证据。"
      }
    };
  }

  if (roundIndex >= AGENT_EXECUTION_LIMITS.groupMaxRedispatchRounds) {
    return {
      criteria: nextCriteria,
      review: {
        decision: satisfiedCriteria.length > 0 ? "partial" : "failed",
        satisfiedCriteria,
        unresolvedCriteria,
        evidence,
        nextAssignments: [],
        reason: `已达到最大重分派轮数 ${AGENT_EXECUTION_LIMITS.groupMaxRedispatchRounds}。`
      }
    };
  }

  const nextAssignments = createRepairAssignments(
    unresolvedCriteria,
    assignments,
    results
  );

  return {
    criteria: nextCriteria,
    review: {
      decision: nextAssignments.length > 0 ? "redispatch" : "need_user_input",
      satisfiedCriteria,
      unresolvedCriteria,
      evidence,
      nextAssignments,
      reason:
        nextAssignments.length > 0
          ? "仍有 required acceptance criteria 未满足，只针对未完成项生成修复分派。"
          : "仍有 required acceptance criteria 未满足，但无法生成有效修复分派。"
    }
  };
}
