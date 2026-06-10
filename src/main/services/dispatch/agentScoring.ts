import type { Agent, AgentToolName } from "../../../shared/domain";
import type {
  AgentAssignment,
  AgentDispatchScore,
  CapabilityMatchResult,
  SubTask
} from "../../../shared/groupChat";
import { getEffectiveAgentCapabilities } from "../agentSkillCatalogService";

export type CandidateRejectionReason =
  | "not_available"
  | "not_group_member"
  | "not_in_explicit_pool"
  | "missing_required_tool"
  | "missing_write_diff";

export type CandidateFilterResult = {
  candidates: Agent[];
  rejected: Array<{
    agentId: string;
    reason: CandidateRejectionReason;
    detail: string;
  }>;
};

export type ScoreInputs = {
  capability: CapabilityMatchResult;
  toolMatch: number;
  contextRelevance: number;
  historicalReliability: number;
};

const TOOL_ALIASES: Record<string, AgentToolName> = {
  read_file: "readFile",
  readfile: "readFile",
  read: "readFile",
  write_diff: "writeDiff",
  writediff: "writeDiff",
  diff: "writeDiff",
  apply_diff: "applyDiff",
  applydiff: "applyDiff",
  preview_artifact: "previewArtifact",
  previewartifact: "previewArtifact",
  git_status: "gitStatus",
  gitstatus: "gitStatus",
  web_search: "webSearch",
  websearch: "webSearch",
  search: "webSearch",
  web_fetch: "webFetch",
  webfetch: "webFetch",
  fetch: "webFetch"
};

function clamp(value: number): number {
  if (!Number.isFinite(value)) {
    return 0;
  }
  return Math.max(0, Math.min(1, value));
}

function normalizeText(value: string): string {
  return value.toLowerCase().replace(/[_:-]/g, " ").replace(/\s+/g, " ").trim();
}

function tokenize(value: string): Set<string> {
  return new Set(
    normalizeText(value)
      .split(/[^a-z0-9\u4e00-\u9fff]+/i)
      .map((token) => token.trim())
      .filter((token) => token.length >= 2)
  );
}

export function normalizeToolName(tool: string): AgentToolName | null {
  const key = tool.trim();
  if (!key) {
    return null;
  }
  if (
    key === "readFile" ||
    key === "writeDiff" ||
    key === "applyDiff" ||
    key === "previewArtifact" ||
    key === "gitStatus" ||
    key === "webSearch" ||
    key === "webFetch"
  ) {
    return key;
  }
  return TOOL_ALIASES[key.toLowerCase()] ?? null;
}

export type RequiredToolResolution = {
  tools: AgentToolName[];
  droppedOriginalNames: string[];
};

export function requiredToolNames(subTask: SubTask): AgentToolName[] {
  return resolveRequiredToolNames(subTask).tools;
}

export function resolveRequiredToolNames(subTask: SubTask): RequiredToolResolution {
  const droppedOriginalNames: string[] = [];
  const names: AgentToolName[] = [];
  for (const raw of subTask.requiredTools) {
    const normalized = normalizeToolName(raw);
    if (normalized) {
      if (!names.includes(normalized)) {
        names.push(normalized);
      }
    } else {
      droppedOriginalNames.push(raw);
    }
  }
  if (subTask.expectedOutputType === "diff_proposal" && !names.includes("writeDiff")) {
    names.push("writeDiff");
  }
  return { tools: names, droppedOriginalNames };
}

export function filterDispatchCandidates(input: {
  agents: Agent[];
  groupMemberAgentIds: Set<string>;
  explicitAgentIds?: Set<string>;
  subTask: SubTask;
}): CandidateFilterResult {
  const candidates: Agent[] = [];
  const rejected: CandidateFilterResult["rejected"] = [];
  const requiredTools = requiredToolNames(input.subTask);

  for (const agent of input.agents) {
    if (!input.groupMemberAgentIds.has(agent.id)) {
      rejected.push({
        agentId: agent.id,
        reason: "not_group_member",
        detail: "Agent is not an active member of this group."
      });
      continue;
    }
    if (input.explicitAgentIds && !input.explicitAgentIds.has(agent.id)) {
      rejected.push({
        agentId: agent.id,
        reason: "not_in_explicit_pool",
        detail: "User explicitly locked the candidate pool to other Agent(s)."
      });
      continue;
    }
    if (
      agent.role !== "sub" ||
      agent.type !== "specialist" ||
      (agent.status !== "available" && agent.status !== "error")
    ) {
      rejected.push({
        agentId: agent.id,
        reason: "not_available",
        detail: "Agent is not an available specialist sub-agent."
      });
      continue;
    }
    const missingTool = requiredTools.find((tool) => !agent.tools[tool]);
    if (missingTool) {
      rejected.push({
        agentId: agent.id,
        reason:
          input.subTask.expectedOutputType === "diff_proposal" && missingTool === "writeDiff"
            ? "missing_write_diff"
            : "missing_required_tool",
        detail: `Agent lacks required tool: ${missingTool}.`
      });
      continue;
    }

    candidates.push(agent);
  }

  return { candidates, rejected };
}

export function calculateToolMatch(agent: Agent, subTask: SubTask): number {
  const requiredTools = requiredToolNames(subTask);
  const usefulTools = new Set<AgentToolName>(["readFile"]);
  for (const tool of requiredTools) {
    usefulTools.add(tool);
  }
  if (subTask.expectedOutputType === "diff_proposal") {
    usefulTools.add("writeDiff");
    usefulTools.add("gitStatus");
  }
  if (subTask.expectedOutputType === "analysis" || subTask.expectedOutputType === "design") {
    usefulTools.add("previewArtifact");
  }

  const useful = [...usefulTools];
  if (useful.length === 0) {
    return 0.7;
  }

  const enabled = useful.filter((tool) => agent.tools[tool]).length;
  const base = requiredTools.length === 0 ? 0.55 : 0.7;
  return clamp(base + (enabled / useful.length) * (1 - base));
}

export function fallbackCapabilityMatch(agent: Agent, subTask: SubTask): CapabilityMatchResult {
  const capabilities = getEffectiveAgentCapabilities(agent);
  const queryText = [
    subTask.title,
    subTask.objective,
    subTask.taskType,
    ...subTask.requiredSkillQueries
  ].join(" ");
  const queryTokens = tokenize(queryText);
  let bestOverlap = 0;
  const matchedSkills: CapabilityMatchResult["matchedSkills"] = [];

  for (const capability of capabilities) {
    const capabilityTokens = tokenize(capability);
    const overlap = [...queryTokens].filter((token) => capabilityTokens.has(token)).length;
    const denominator = Math.max(1, Math.min(queryTokens.size, capabilityTokens.size));
    const relevance = clamp(overlap / denominator);
    if (relevance > bestOverlap) {
      bestOverlap = relevance;
    }
    if (relevance >= 0.2 || normalizeText(capability).includes(normalizeText(subTask.taskType))) {
      matchedSkills.push({
        skillName: capability.split(":")[0]?.trim() || capability,
        relevance: Math.max(relevance, 0.35),
        reason: "Deterministic fallback matched task wording to capability text."
      });
    }
  }

  const capabilityMatch =
    matchedSkills.length > 0
      ? clamp(0.45 + Math.min(0.4, bestOverlap * 0.5) + Math.min(0.15, matchedSkills.length * 0.05))
      : 0.25;

  return {
    agentId: agent.id,
    taskId: subTask.id,
    capabilityMatch,
    confidence: 0.45,
    matchedSkills: matchedSkills.slice(0, 5),
    missingSkills:
      matchedSkills.length === 0 ? subTask.requiredSkillQueries.slice(0, 5) : [],
    reason: "LLM capability judge was unavailable; used deterministic capability text fallback."
  };
}

export function calculateDispatchScore(input: ScoreInputs): AgentDispatchScore {
  const finalScore = clamp(
    input.capability.capabilityMatch * 0.4 +
      input.toolMatch * 0.2 +
      input.contextRelevance * 0.2 +
      input.historicalReliability * 0.2
  );

  return {
    agentId: input.capability.agentId,
    taskId: input.capability.taskId,
    finalScore,
    capabilityMatch: clamp(input.capability.capabilityMatch),
    toolMatch: clamp(input.toolMatch),
    contextRelevance: clamp(input.contextRelevance),
    historicalReliability: clamp(input.historicalReliability),
    confidence: clamp(input.capability.confidence),
    matchedSkills: input.capability.matchedSkills,
    missingSkills: input.capability.missingSkills,
    reason: input.capability.reason
  };
}

function hasFileWriteConflict(a: AgentAssignment, b: AgentAssignment): boolean {
  const aTask = a.subTask;
  const bTask = b.subTask;
  if (!aTask || !bTask) {
    return false;
  }
  if (
    aTask.expectedOutputType !== "diff_proposal" ||
    bTask.expectedOutputType !== "diff_proposal"
  ) {
    return false;
  }
  const aFiles = new Set((aTask.targetFiles ?? []).map((file) => normalizeText(file)));
  if (aFiles.size === 0) {
    return false;
  }
  return (bTask.targetFiles ?? []).some((file) => aFiles.has(normalizeText(file)));
}

export function buildExecutionBatches(
  assignments: AgentAssignment[],
  initialCompletedTaskIds: Iterable<string> = []
): AgentAssignment[][] {
  const pending = [...assignments];
  const completedTaskIds = new Set(initialCompletedTaskIds);
  const batches: AgentAssignment[][] = [];

  while (pending.length > 0) {
    const ready = pending.filter((assignment) => {
      const dependencies = assignment.dependsOn ?? assignment.subTask?.dependsOn ?? [];
      return dependencies.every((dependencyId) => completedTaskIds.has(dependencyId));
    });

    if (ready.length === 0) {
      batches.push([pending.shift()!]);
      continue;
    }

    const batch: AgentAssignment[] = [];
    for (const assignment of ready) {
      if (batch.some((existing) => hasFileWriteConflict(existing, assignment))) {
        continue;
      }
      batch.push(assignment);
    }

    const selected = batch.length > 0 ? batch : [ready[0]];
    for (const assignment of selected) {
      const index = pending.findIndex((item) => item.id === assignment.id);
      if (index >= 0) {
        pending.splice(index, 1);
      }
      completedTaskIds.add(assignment.subTask?.id ?? assignment.id);
    }
    batches.push(selected);
  }

  return batches;
}
