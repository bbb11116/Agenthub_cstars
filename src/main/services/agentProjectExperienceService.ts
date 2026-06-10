import type {
  AgentAssignment,
  OrchestratorReview,
  SubAgentResult
} from "../../shared/groupChat";
import { getDatabase, type AgentHubDatabase } from "../db";
import {
  getExperience,
  upsertExperience,
  type AgentProjectExperience,
  type AgentProjectExperienceUpdate
} from "../db/repositories/agentProjectExperienceRepo";
import { getConversationById } from "../db/repositories/conversationRepo";
import { loadMainAgentConfig } from "./configService";
import { callLLM } from "./llmRouter";
import { resolveExecutionWorkspaceForGroup } from "./workspaceContextResolver";

const MAX_SUMMARY_CHARACTERS = 6_000;
const MAX_ARRAY_ITEMS = 30;

type ExperienceDelta = {
  summaryDelta: string;
  responsibilities: string[];
  keyDecisions: string[];
  filesTouched: string[];
  diffSummaries: string[];
  unresolvedIssues: string[];
};

function uniqueRecent(items: string[]): string[] {
  return [...new Set(items.map((item) => item.trim()).filter(Boolean))].slice(-MAX_ARRAY_ITEMS);
}

function mergeSummary(previous: string, delta: string): string {
  const merged = [previous.trim(), delta.trim()].filter(Boolean).join("\n\n");
  return merged.length <= MAX_SUMMARY_CHARACTERS
    ? merged
    : merged.slice(merged.length - MAX_SUMMARY_CHARACTERS);
}

function deterministicDelta(
  assignment: AgentAssignment | undefined,
  result: SubAgentResult,
  review: OrchestratorReview
): ExperienceDelta {
  return {
    summaryDelta: [
      assignment ? `Assignment: ${assignment.instruction}` : "",
      `Result: ${result.summary}`,
      review.reason ? `Review: ${review.reason}` : ""
    ]
      .filter(Boolean)
      .join("\n"),
    responsibilities: assignment ? [assignment.instruction] : [],
    keyDecisions: result.assumptions,
    filesTouched: result.filesChanged ?? [],
    diffSummaries: result.diffProposalId ? [`DiffProposal: ${result.diffProposalId}`] : [],
    unresolvedIssues: [...result.unresolvedCriteria, ...result.risks]
  };
}

function normalizeDelta(value: unknown): ExperienceDelta | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  const record = value as Record<string, unknown>;
  const readStrings = (key: string): string[] =>
    Array.isArray(record[key])
      ? record[key].filter((item): item is string => typeof item === "string")
      : [];
  return {
    summaryDelta: typeof record.summaryDelta === "string" ? record.summaryDelta : "",
    responsibilities: readStrings("responsibilities"),
    keyDecisions: readStrings("keyDecisions"),
    filesTouched: readStrings("filesTouched"),
    diffSummaries: readStrings("diffSummaries"),
    unresolvedIssues: readStrings("unresolvedIssues")
  };
}

async function summarizeWithConfiguredLLM(input: {
  groupConversationId: string;
  userTask: string;
  assignment?: AgentAssignment;
  result: SubAgentResult;
  review: OrchestratorReview;
}, db: AgentHubDatabase): Promise<ExperienceDelta | null> {
  const resolved = resolveExecutionWorkspaceForGroup(input.groupConversationId, db);
  const config = loadMainAgentConfig(resolved.rootPath);
  const raw = await callLLM(
    config,
    [
      "Summarize one Agent's durable project experience.",
      "Return JSON only with keys summaryDelta, responsibilities, keyDecisions, filesTouched, diffSummaries, unresolvedIssues.",
      "Each array must contain strings. Keep only facts supported by the input."
    ].join("\n"),
    [
      {
        role: "user",
        content: JSON.stringify({
          userTask: input.userTask,
          assignment: input.assignment,
          result: input.result,
          orchestratorReview: input.review
        })
      }
    ]
  );
  const json = raw.match(/\{[\s\S]*\}/)?.[0];
  return json ? normalizeDelta(JSON.parse(json) as unknown) : null;
}

function mergeExperience(
  current: AgentProjectExperience | null,
  groupName: string,
  delta: ExperienceDelta
): AgentProjectExperienceUpdate {
  return {
    groupName,
    summary: mergeSummary(current?.summary ?? "", delta.summaryDelta),
    responsibilities: uniqueRecent([
      ...(current?.responsibilities ?? []),
      ...delta.responsibilities
    ]),
    keyDecisions: uniqueRecent([...(current?.keyDecisions ?? []), ...delta.keyDecisions]),
    filesTouched: uniqueRecent([...(current?.filesTouched ?? []), ...delta.filesTouched]),
    diffSummaries: uniqueRecent([...(current?.diffSummaries ?? []), ...delta.diffSummaries]),
    unresolvedIssues: uniqueRecent([
      ...(current?.unresolvedIssues ?? []),
      ...delta.unresolvedIssues
    ])
  };
}

export async function updateExperiencesAfterGroupDispatch(
  input: {
    groupConversationId: string;
    userTask: string;
    assignments: AgentAssignment[];
    results: SubAgentResult[];
    review: OrchestratorReview;
  },
  db: AgentHubDatabase = getDatabase()
): Promise<void> {
  const conversation = getConversationById(input.groupConversationId, db);
  if (!conversation || conversation.type !== "group") {
    return;
  }

  for (const result of input.results) {
    const assignment = input.assignments.find((item) => item.agentId === result.agentId);
    let delta: ExperienceDelta;
    try {
      delta =
        (await summarizeWithConfiguredLLM(
          {
            groupConversationId: conversation.id,
            userTask: input.userTask,
            assignment,
            result,
            review: input.review
          },
          db
        )) ?? deterministicDelta(assignment, result, input.review);
    } catch {
      delta = deterministicDelta(assignment, result, input.review);
    }

    const current = getExperience(result.agentId, conversation.id, db);
    upsertExperience(
      result.agentId,
      conversation.id,
      mergeExperience(current, conversation.title, delta),
      db
    );
  }
}
