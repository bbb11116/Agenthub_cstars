import { randomUUID } from "node:crypto";
import { getDatabase, type AgentHubDatabase } from "../index";

export type ConversationCompactSummary = {
  id: string;
  conversationId: string;
  coveredMessageStartId: string;
  coveredMessageEndId: string;
  summary: string;
  summaryTokens?: number;
  rawTokensBeforeCompact?: number;
  createdAt: string;
  updatedAt: string;
};

export type CreateConversationCompactSummaryInput = Omit<
  ConversationCompactSummary,
  "id" | "createdAt" | "updatedAt"
>;

type ConversationCompactSummaryRow = {
  id: string;
  conversation_id: string;
  covered_message_start_id: string;
  covered_message_end_id: string;
  summary: string;
  summary_tokens: number | null;
  raw_tokens_before_compact: number | null;
  created_at: string;
  updated_at: string;
};

function toConversationCompactSummary(
  row: ConversationCompactSummaryRow
): ConversationCompactSummary {
  return {
    id: row.id,
    conversationId: row.conversation_id,
    coveredMessageStartId: row.covered_message_start_id,
    coveredMessageEndId: row.covered_message_end_id,
    summary: row.summary,
    summaryTokens: row.summary_tokens ?? undefined,
    rawTokensBeforeCompact: row.raw_tokens_before_compact ?? undefined,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

export function createConversationCompactSummary(
  input: CreateConversationCompactSummaryInput,
  db: AgentHubDatabase = getDatabase()
): ConversationCompactSummary {
  const now = new Date().toISOString();
  const compactSummary: ConversationCompactSummary = {
    id: randomUUID(),
    ...input,
    createdAt: now,
    updatedAt: now
  };

  db.prepare(`
    INSERT INTO conversation_compact_summaries (
      id,
      conversation_id,
      covered_message_start_id,
      covered_message_end_id,
      summary,
      summary_tokens,
      raw_tokens_before_compact,
      created_at,
      updated_at
    )
    VALUES (
      @id,
      @conversationId,
      @coveredMessageStartId,
      @coveredMessageEndId,
      @summary,
      @summaryTokens,
      @rawTokensBeforeCompact,
      @createdAt,
      @updatedAt
    )
  `).run({
    ...compactSummary,
    summaryTokens: compactSummary.summaryTokens ?? null,
    rawTokensBeforeCompact: compactSummary.rawTokensBeforeCompact ?? null
  });

  return compactSummary;
}

export function getLatestConversationCompactSummary(
  conversationId: string,
  db: AgentHubDatabase = getDatabase()
): ConversationCompactSummary | null {
  const row = db
    .prepare<[string], ConversationCompactSummaryRow>(
      `SELECT *
       FROM conversation_compact_summaries
       WHERE conversation_id = ?
       ORDER BY created_at DESC, rowid DESC
       LIMIT 1`
    )
    .get(conversationId);

  return row ? toConversationCompactSummary(row) : null;
}

export function getConversationCompactSummaries(
  conversationId: string,
  db: AgentHubDatabase = getDatabase()
): ConversationCompactSummary[] {
  return db
    .prepare<[string], ConversationCompactSummaryRow>(
      `SELECT *
       FROM conversation_compact_summaries
       WHERE conversation_id = ?
       ORDER BY created_at ASC, rowid ASC`
    )
    .all(conversationId)
    .map(toConversationCompactSummary);
}
