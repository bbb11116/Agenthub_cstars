import { randomUUID } from "node:crypto";
import {
  getDatabase,
  parseJsonField,
  stringifyJsonField,
  type AgentHubDatabase
} from "../index";

export type AgentProjectExperience = {
  id: string;
  agentId: string;
  groupConversationId: string;
  groupName: string;
  summary: string;
  responsibilities: string[];
  keyDecisions: string[];
  filesTouched: string[];
  diffSummaries: string[];
  unresolvedIssues: string[];
  createdAt: string;
  updatedAt: string;
};

export type AgentProjectExperienceUpdate = Partial<
  Pick<
    AgentProjectExperience,
    | "groupName"
    | "summary"
    | "responsibilities"
    | "keyDecisions"
    | "filesTouched"
    | "diffSummaries"
    | "unresolvedIssues"
  >
>;

type AgentProjectExperienceRow = {
  id: string;
  agent_id: string;
  group_conversation_id: string;
  group_name: string;
  summary: string;
  responsibilities_json: string;
  key_decisions_json: string;
  files_touched_json: string;
  diff_summaries_json: string;
  unresolved_issues_json: string;
  created_at: string;
  updated_at: string;
};

function toExperience(row: AgentProjectExperienceRow): AgentProjectExperience {
  return {
    id: row.id,
    agentId: row.agent_id,
    groupConversationId: row.group_conversation_id,
    groupName: row.group_name,
    summary: row.summary,
    responsibilities: parseJsonField(row.responsibilities_json, [], "agent_project_experiences.responsibilities_json"),
    keyDecisions: parseJsonField(row.key_decisions_json, [], "agent_project_experiences.key_decisions_json"),
    filesTouched: parseJsonField(row.files_touched_json, [], "agent_project_experiences.files_touched_json"),
    diffSummaries: parseJsonField(row.diff_summaries_json, [], "agent_project_experiences.diff_summaries_json"),
    unresolvedIssues: parseJsonField(row.unresolved_issues_json, [], "agent_project_experiences.unresolved_issues_json"),
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

export function getExperience(
  agentId: string,
  groupConversationId: string,
  db: AgentHubDatabase = getDatabase()
): AgentProjectExperience | null {
  const row = db
    .prepare<[string, string], AgentProjectExperienceRow>(
      "SELECT * FROM agent_project_experiences WHERE agent_id = ? AND group_conversation_id = ?"
    )
    .get(agentId, groupConversationId);
  return row ? toExperience(row) : null;
}

export function getByAgent(
  agentId: string,
  db: AgentHubDatabase = getDatabase()
): AgentProjectExperience[] {
  return db
    .prepare<[string], AgentProjectExperienceRow>(
      "SELECT * FROM agent_project_experiences WHERE agent_id = ? ORDER BY updated_at DESC"
    )
    .all(agentId)
    .map(toExperience);
}

export function getByAgentExcludingGroup(
  agentId: string,
  groupConversationId: string,
  db: AgentHubDatabase = getDatabase()
): AgentProjectExperience[] {
  return db
    .prepare<[string, string], AgentProjectExperienceRow>(
      "SELECT * FROM agent_project_experiences WHERE agent_id = ? AND group_conversation_id <> ? ORDER BY updated_at DESC"
    )
    .all(agentId, groupConversationId)
    .map(toExperience);
}

export function listByGroup(
  groupConversationId: string,
  db: AgentHubDatabase = getDatabase()
): AgentProjectExperience[] {
  return db
    .prepare<[string], AgentProjectExperienceRow>(
      "SELECT * FROM agent_project_experiences WHERE group_conversation_id = ? ORDER BY updated_at DESC"
    )
    .all(groupConversationId)
    .map(toExperience);
}

export function upsertExperience(
  agentId: string,
  groupConversationId: string,
  update: AgentProjectExperienceUpdate,
  db: AgentHubDatabase = getDatabase()
): AgentProjectExperience {
  const current = getExperience(agentId, groupConversationId, db);
  const now = new Date().toISOString();
  const next: AgentProjectExperience = {
    id: current?.id ?? randomUUID(),
    agentId,
    groupConversationId,
    groupName: update.groupName ?? current?.groupName ?? "Group Chat",
    summary: update.summary ?? current?.summary ?? "",
    responsibilities: update.responsibilities ?? current?.responsibilities ?? [],
    keyDecisions: update.keyDecisions ?? current?.keyDecisions ?? [],
    filesTouched: update.filesTouched ?? current?.filesTouched ?? [],
    diffSummaries: update.diffSummaries ?? current?.diffSummaries ?? [],
    unresolvedIssues: update.unresolvedIssues ?? current?.unresolvedIssues ?? [],
    createdAt: current?.createdAt ?? now,
    updatedAt: now
  };

  db.prepare(`
    INSERT INTO agent_project_experiences (
      id, agent_id, group_conversation_id, group_name, summary,
      responsibilities_json, key_decisions_json, files_touched_json,
      diff_summaries_json, unresolved_issues_json, created_at, updated_at
    )
    VALUES (
      @id, @agentId, @groupConversationId, @groupName, @summary,
      @responsibilities, @keyDecisions, @filesTouched,
      @diffSummaries, @unresolvedIssues, @createdAt, @updatedAt
    )
    ON CONFLICT(agent_id, group_conversation_id) DO UPDATE SET
      group_name = excluded.group_name,
      summary = excluded.summary,
      responsibilities_json = excluded.responsibilities_json,
      key_decisions_json = excluded.key_decisions_json,
      files_touched_json = excluded.files_touched_json,
      diff_summaries_json = excluded.diff_summaries_json,
      unresolved_issues_json = excluded.unresolved_issues_json,
      updated_at = excluded.updated_at
  `).run({
    ...next,
    responsibilities: stringifyJsonField(next.responsibilities),
    keyDecisions: stringifyJsonField(next.keyDecisions),
    filesTouched: stringifyJsonField(next.filesTouched),
    diffSummaries: stringifyJsonField(next.diffSummaries),
    unresolvedIssues: stringifyJsonField(next.unresolvedIssues)
  });

  return next;
}
