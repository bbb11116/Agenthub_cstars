import type BetterSqlite3 from "better-sqlite3";
import { MAX_DISPATCH_STEPS } from "../../shared/groupChat";
import { AGENT_EXECUTION_LIMITS } from "../../shared/agentExecution";

type SqliteDatabase = BetterSqlite3.Database;

function ensureDiffProposalNewContentColumn(db: SqliteDatabase): void {
  const columns = db.prepare("PRAGMA table_info(diff_proposals)").all() as Array<{
    name: string;
  }>;

  if (columns.some((column) => column.name === "new_content")) {
    return;
  }

  db.exec("ALTER TABLE diff_proposals ADD COLUMN new_content TEXT NOT NULL DEFAULT '';");
}

function ensureConversationGroupColumns(db: SqliteDatabase): void {
  const columns = db.prepare("PRAGMA table_info(conversations)").all() as Array<{ name: string }>;
  const existing = new Set(columns.map((c) => c.name));

  if (!existing.has("type")) {
    db.exec("ALTER TABLE conversations ADD COLUMN type TEXT NOT NULL DEFAULT 'direct';");
  }

  if (!existing.has("description")) {
    db.exec("ALTER TABLE conversations ADD COLUMN description TEXT NOT NULL DEFAULT '';");
  }

  if (!existing.has("owner_user_id")) {
    db.exec("ALTER TABLE conversations ADD COLUMN owner_user_id TEXT NOT NULL DEFAULT 'local-user';");
  }

  if (!existing.has("main_agent_id")) {
    db.exec("ALTER TABLE conversations ADD COLUMN main_agent_id TEXT;");
  }

  if (!existing.has("auto_dispatch_enabled")) {
    db.exec("ALTER TABLE conversations ADD COLUMN auto_dispatch_enabled INTEGER NOT NULL DEFAULT 0;");
  }
}

function ensureMessageGroupColumns(db: SqliteDatabase): void {
  const columns = db.prepare("PRAGMA table_info(messages)").all() as Array<{ name: string }>;
  const existing = new Set(columns.map((c) => c.name));

  if (!existing.has("status")) {
    db.exec("ALTER TABLE messages ADD COLUMN status TEXT NOT NULL DEFAULT 'completed';");
  }

  if (!existing.has("mention_agent_ids")) {
    db.exec("ALTER TABLE messages ADD COLUMN mention_agent_ids TEXT;");
  }

  if (!existing.has("dispatch_run_id")) {
    db.exec("ALTER TABLE messages ADD COLUMN dispatch_run_id TEXT;");
  }

  if (!existing.has("dispatch_step_id")) {
    db.exec("ALTER TABLE messages ADD COLUMN dispatch_step_id TEXT;");
  }

  if (!existing.has("reply_to_message_id")) {
    db.exec("ALTER TABLE messages ADD COLUMN reply_to_message_id TEXT;");
  }

  if (!existing.has("updated_at")) {
    db.exec("ALTER TABLE messages ADD COLUMN updated_at TEXT;");
  }
}

function ensureDiffProposalGroupColumns(db: SqliteDatabase): void {
  const columns = db.prepare("PRAGMA table_info(diff_proposals)").all() as Array<{ name: string }>;
  const existing = new Set(columns.map((c) => c.name));

  if (!existing.has("dispatch_run_id")) {
    db.exec("ALTER TABLE diff_proposals ADD COLUMN dispatch_run_id TEXT;");
  }

  if (!existing.has("dispatch_step_id")) {
    db.exec("ALTER TABLE diff_proposals ADD COLUMN dispatch_step_id TEXT;");
  }

  if (!existing.has("message_id")) {
    db.exec("ALTER TABLE diff_proposals ADD COLUMN message_id TEXT;");
  }
}

function ensureAgentRuntimeProviderColumn(db: SqliteDatabase): void {
  const columns = db.prepare("PRAGMA table_info(agents)").all() as Array<{
    name: string;
  }>;

  if (columns.some((column) => column.name === "runtime_provider")) {
    return;
  }

  db.exec("ALTER TABLE agents ADD COLUMN runtime_provider TEXT NOT NULL DEFAULT 'mock';");
  db.prepare(
    "UPDATE agents SET status = 'unavailable', updated_at = ? WHERE status <> 'disabled';"
  ).run(new Date().toISOString());
}

function ensureMessageMetadataColumn(db: SqliteDatabase): void {
  const columns = db.prepare("PRAGMA table_info(messages)").all() as Array<{ name: string }>;
  const existing = new Set(columns.map((c) => c.name));

  if (!existing.has("metadata")) {
    db.exec("ALTER TABLE messages ADD COLUMN metadata TEXT;");
  }
}

function ensureConversationProviderColumn(db: SqliteDatabase): void {
  const columns = db.prepare("PRAGMA table_info(conversations)").all() as Array<{ name: string }>;
  const existing = new Set(columns.map((c) => c.name));

  if (!existing.has("provider")) {
    db.exec("ALTER TABLE conversations ADD COLUMN provider TEXT;");
  }
}

function ensureAgentClaudeCodeConfigColumn(db: SqliteDatabase): void {
  const columns = db.prepare("PRAGMA table_info(agents)").all() as Array<{
    name: string;
  }>;

  if (columns.some((column) => column.name === "claude_code_config")) {
    return;
  }

  db.exec("ALTER TABLE agents ADD COLUMN claude_code_config TEXT;");
}

function ensureAgentTypeColumn(db: SqliteDatabase): void {
  const columns = db.prepare("PRAGMA table_info(agents)").all() as Array<{
    name: string;
  }>;

  if (columns.some((column) => column.name === "type")) {
    return;
  }

  db.exec("ALTER TABLE agents ADD COLUMN type TEXT NOT NULL DEFAULT 'specialist';");
  // Migrate existing main agents to orchestrator type
  db.prepare("UPDATE agents SET type = 'orchestrator' WHERE role = 'main'").run();
}

function ensureAgentDescriptionColumn(db: SqliteDatabase): void {
  const columns = db.prepare("PRAGMA table_info(agents)").all() as Array<{
    name: string;
  }>;

  if (columns.some((column) => column.name === "description")) {
    return;
  }

  db.exec("ALTER TABLE agents ADD COLUMN description TEXT;");
}

function ensureLegacyDraftDescriptionColumn(db: SqliteDatabase): void {
  const columns = db.prepare("PRAGMA table_info(agent_drafts)").all() as Array<{
    name: string;
  }>;

  if (columns.some((column) => column.name === "description")) {
    return;
  }

  db.exec("ALTER TABLE agent_drafts ADD COLUMN description TEXT NOT NULL DEFAULT '';");
}

function ensureAgentModelColumns(db: SqliteDatabase): void {
  const columns = db.prepare("PRAGMA table_info(agents)").all() as Array<{ name: string }>;
  const existing = new Set(columns.map((c) => c.name));

  if (!existing.has("model_provider_id")) {
    db.exec("ALTER TABLE agents ADD COLUMN model_provider_id TEXT;");
  }

  if (!existing.has("model")) {
    db.exec("ALTER TABLE agents ADD COLUMN model TEXT;");
  }
}

function ensureAgentSkillIdsColumn(db: SqliteDatabase): void {
  const columns = db.prepare("PRAGMA table_info(agents)").all() as Array<{ name: string }>;
  const existing = new Set(columns.map((c) => c.name));

  if (!existing.has("skill_ids")) {
    db.exec("ALTER TABLE agents ADD COLUMN skill_ids TEXT NOT NULL DEFAULT '[]';");
  }
}

function ensureDispatchExecutionColumns(db: SqliteDatabase): void {
  const runColumns = db.prepare("PRAGMA table_info(dispatch_runs)").all() as Array<{ name: string }>;
  const existingRunColumns = new Set(runColumns.map((column) => column.name));

  if (!existingRunColumns.has("round_index")) {
    db.exec("ALTER TABLE dispatch_runs ADD COLUMN round_index INTEGER NOT NULL DEFAULT 0;");
  }
  if (!existingRunColumns.has("acceptance_criteria")) {
    db.exec("ALTER TABLE dispatch_runs ADD COLUMN acceptance_criteria TEXT NOT NULL DEFAULT '[]';");
  }
  if (!existingRunColumns.has("orchestrator_review")) {
    db.exec("ALTER TABLE dispatch_runs ADD COLUMN orchestrator_review TEXT;");
  }

  const stepColumns = db.prepare("PRAGMA table_info(dispatch_steps)").all() as Array<{ name: string }>;
  const existingStepColumns = new Set(stepColumns.map((column) => column.name));

  if (!existingStepColumns.has("round_index")) {
    db.exec("ALTER TABLE dispatch_steps ADD COLUMN round_index INTEGER NOT NULL DEFAULT 0;");
  }
  if (!existingStepColumns.has("assignment_id")) {
    db.exec("ALTER TABLE dispatch_steps ADD COLUMN assignment_id TEXT;");
  }
  if (!existingStepColumns.has("target_criteria")) {
    db.exec("ALTER TABLE dispatch_steps ADD COLUMN target_criteria TEXT NOT NULL DEFAULT '[]';");
  }
  if (!existingStepColumns.has("subagent_result")) {
    db.exec("ALTER TABLE dispatch_steps ADD COLUMN subagent_result TEXT;");
  }
  if (!existingStepColumns.has("max_iterations")) {
    db.exec(
      `ALTER TABLE dispatch_steps ADD COLUMN max_iterations INTEGER NOT NULL DEFAULT ${AGENT_EXECUTION_LIMITS.groupSubagentMaxIterations};`
    );
  }
}

function ensureMessageContentMarkdownColumn(db: SqliteDatabase): void {
  const columns = db.prepare("PRAGMA table_info(messages)").all() as Array<{ name: string }>;
  const existing = new Set(columns.map((column) => column.name));

  if (!existing.has("content_markdown")) {
    db.exec("ALTER TABLE messages ADD COLUMN content_markdown TEXT NOT NULL DEFAULT '';");
  }
}

function ensureMessageThinkingMarkdownColumn(db: SqliteDatabase): void {
  const columns = db.prepare("PRAGMA table_info(messages)").all() as Array<{ name: string }>;
  const existing = new Set(columns.map((column) => column.name));

  if (!existing.has("thinking_markdown")) {
    db.exec(
      "ALTER TABLE messages ADD COLUMN thinking_markdown TEXT NOT NULL DEFAULT '';"
    );
  }
}

function ensureAgentRunEventsTable(db: SqliteDatabase): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS agent_run_events (
      id TEXT PRIMARY KEY,
      run_id TEXT NOT NULL,
      conversation_id TEXT NOT NULL,
      seq INTEGER NOT NULL,
      type TEXT NOT NULL,
      payload_json TEXT NOT NULL,
      created_at TEXT NOT NULL,
      FOREIGN KEY (conversation_id) REFERENCES conversations(id) ON DELETE CASCADE
    );

    CREATE UNIQUE INDEX IF NOT EXISTS idx_agent_run_events_seq
      ON agent_run_events(run_id, seq);
    CREATE INDEX IF NOT EXISTS idx_agent_run_events_conversation
      ON agent_run_events(conversation_id);
  `);
}

function ensureGroupRunEventsTable(db: SqliteDatabase): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS group_run_events (
      id TEXT PRIMARY KEY,
      group_run_id TEXT NOT NULL,
      conversation_id TEXT NOT NULL,
      seq INTEGER NOT NULL,
      type TEXT NOT NULL,
      payload_json TEXT NOT NULL,
      created_at TEXT NOT NULL,
      FOREIGN KEY (group_run_id) REFERENCES dispatch_runs(id) ON DELETE CASCADE,
      FOREIGN KEY (conversation_id) REFERENCES conversations(id) ON DELETE CASCADE
    );

    CREATE UNIQUE INDEX IF NOT EXISTS idx_group_run_events_seq
      ON group_run_events(group_run_id, seq);
    CREATE INDEX IF NOT EXISTS idx_group_run_events_conversation
      ON group_run_events(conversation_id, created_at);
  `);
}

function ensureMessageArtifactsTable(db: SqliteDatabase): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS message_artifacts (
      id TEXT PRIMARY KEY,
      message_id TEXT NOT NULL,
      conversation_id TEXT NOT NULL,
      type TEXT NOT NULL,
      payload_json TEXT NOT NULL,
      created_at TEXT NOT NULL,
      FOREIGN KEY (message_id) REFERENCES messages(id) ON DELETE CASCADE,
      FOREIGN KEY (conversation_id) REFERENCES conversations(id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_message_artifacts_message
      ON message_artifacts(message_id);
    CREATE INDEX IF NOT EXISTS idx_message_artifacts_conversation
      ON message_artifacts(conversation_id);
    CREATE INDEX IF NOT EXISTS idx_message_artifacts_type
      ON message_artifacts(type);
  `);
}

function ensureConversationRunsTable(db: SqliteDatabase): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS conversation_runs (
      id TEXT PRIMARY KEY,
      conversation_id TEXT NOT NULL,
      agent_id TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'running',
      started_at TEXT NOT NULL,
      ended_at TEXT,
      error_message TEXT,
      FOREIGN KEY (conversation_id) REFERENCES conversations(id) ON DELETE CASCADE,
      FOREIGN KEY (agent_id) REFERENCES agents(id) ON DELETE CASCADE
    );

    CREATE UNIQUE INDEX IF NOT EXISTS idx_conversation_runs_active
      ON conversation_runs(conversation_id)
      WHERE status = 'running';
    CREATE INDEX IF NOT EXISTS idx_conversation_runs_conversation
      ON conversation_runs(conversation_id);
    CREATE INDEX IF NOT EXISTS idx_conversation_runs_status
      ON conversation_runs(status);
  `);
}

function ensureProviderSessionUpsertIndex(db: SqliteDatabase): void {
  // The original DDL did not declare a UNIQUE on the v1 (non-scoped) table.
  // Without a unique key, the SELECT-then-INSERT path can race and raise
  // "UNIQUE constraint failed" on the second message in the same
  // conversation. We add a unique index here (idempotently) and use
  // ON CONFLICT(... ) DO UPDATE in createProviderSessionV1. The v2 table
  // keeps its existing model — multiple sessions per (conversation,
  // provider, root_path) are allowed because they are distinguished by
  // agent_id / workspace_context_id / execution_scope.
  db.exec(`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_prov_sessions_unique
      ON conversation_provider_sessions(conversation_id, provider, root_path);
  `);
}

function ensureAgentRunExecutionColumns(db: SqliteDatabase): void {
  const columns = db.prepare("PRAGMA table_info(agent_runs)").all() as Array<{ name: string }>;
  const existing = new Set(columns.map((column) => column.name));

  if (!existing.has("mode")) {
    db.exec("ALTER TABLE agent_runs ADD COLUMN mode TEXT NOT NULL DEFAULT 'single_chat';");
  }
  if (!existing.has("max_iterations")) {
    db.exec(
      `ALTER TABLE agent_runs ADD COLUMN max_iterations INTEGER NOT NULL DEFAULT ${AGENT_EXECUTION_LIMITS.singleChatMaxIterations};`
    );
  }
  if (!existing.has("iterations_used")) {
    db.exec("ALTER TABLE agent_runs ADD COLUMN iterations_used INTEGER;");
  }
  if (!existing.has("workspace_context_id")) {
    db.exec("ALTER TABLE agent_runs ADD COLUMN workspace_context_id TEXT;");
  }
  if (!existing.has("execution_scope")) {
    db.exec("ALTER TABLE agent_runs ADD COLUMN execution_scope TEXT;");
  }
  if (!existing.has("dispatch_step_id")) {
    db.exec("ALTER TABLE agent_runs ADD COLUMN dispatch_step_id TEXT;");
  }
  if (!existing.has("raw_output")) {
    db.exec("ALTER TABLE agent_runs ADD COLUMN raw_output TEXT;");
  }
}

function ensureAgentWorkspaceContextColumns(db: SqliteDatabase): void {
  const columns = db.prepare("PRAGMA table_info(agents)").all() as Array<{ name: string }>;
  const existing = new Set(columns.map((column) => column.name));

  if (!existing.has("default_workspace_context_id")) {
    db.exec("ALTER TABLE agents ADD COLUMN default_workspace_context_id TEXT;");
  }
  if (!existing.has("avatar")) {
    db.exec("ALTER TABLE agents ADD COLUMN avatar TEXT;");
  }
}

function ensureConversationWorkspaceContextColumns(db: SqliteDatabase): void {
  const columns = db.prepare("PRAGMA table_info(conversations)").all() as Array<{ name: string }>;
  const existing = new Set(columns.map((column) => column.name));

  if (!existing.has("workspace_context_id")) {
    db.exec("ALTER TABLE conversations ADD COLUMN workspace_context_id TEXT;");
  }
  if (!existing.has("avatar")) {
    db.exec("ALTER TABLE conversations ADD COLUMN avatar TEXT;");
  }
  if (!existing.has("status")) {
    db.exec("ALTER TABLE conversations ADD COLUMN status TEXT NOT NULL DEFAULT 'active';");
  }
  if (!existing.has("last_message_at")) {
    db.exec("ALTER TABLE conversations ADD COLUMN last_message_at TEXT;");
  }
}

export function initializeSchema(db: SqliteDatabase): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS workspaces (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      root_path TEXT NOT NULL,
      main_agent_id TEXT,
      git_enabled INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS workspace_contexts (
      id TEXT PRIMARY KEY,
      owner_type TEXT NOT NULL,
      owner_id TEXT NOT NULL,
      root_path TEXT NOT NULL,
      git_enabled INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_workspace_contexts_owner
      ON workspace_contexts(owner_type, owner_id);
    CREATE INDEX IF NOT EXISTS idx_workspace_contexts_root_path
      ON workspace_contexts(root_path);

    CREATE TABLE IF NOT EXISTS agents (
      id TEXT PRIMARY KEY,
      workspace_id TEXT NOT NULL,
      default_workspace_context_id TEXT,
      avatar TEXT,
      name TEXT NOT NULL,
      description TEXT,
      role TEXT NOT NULL,
      runtime_provider TEXT NOT NULL,
      system_prompt TEXT NOT NULL,
      capabilities TEXT NOT NULL,
      skill_ids TEXT NOT NULL DEFAULT '[]',
      tools TEXT NOT NULL,
      file_scope TEXT NOT NULL,
      status TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS conversations (
      id TEXT PRIMARY KEY,
      workspace_id TEXT NOT NULL,
      workspace_context_id TEXT,
      agent_id TEXT NOT NULL,
      avatar TEXT,
      status TEXT NOT NULL DEFAULT 'active',
      last_message_at TEXT,
      title TEXT NOT NULL,
      mode TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE,
      FOREIGN KEY (agent_id) REFERENCES agents(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS messages (
      id TEXT PRIMARY KEY,
      workspace_id TEXT NOT NULL,
      conversation_id TEXT NOT NULL,
      sender_type TEXT NOT NULL,
      sender_id TEXT NOT NULL,
      message_type TEXT NOT NULL,
      content TEXT NOT NULL,
      created_at TEXT NOT NULL,
      FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE,
      FOREIGN KEY (conversation_id) REFERENCES conversations(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS diff_proposals (
      id TEXT PRIMARY KEY,
      workspace_id TEXT NOT NULL,
      agent_id TEXT NOT NULL,
      conversation_id TEXT NOT NULL,
      file_path TEXT NOT NULL,
      old_content_hash TEXT NOT NULL,
      new_content_hash TEXT NOT NULL,
      diff_content TEXT NOT NULL,
      new_content TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL,
      created_at TEXT NOT NULL,
      applied_at TEXT,
      FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE,
      FOREIGN KEY (agent_id) REFERENCES agents(id) ON DELETE CASCADE,
      FOREIGN KEY (conversation_id) REFERENCES conversations(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS artifacts (
      id TEXT PRIMARY KEY,
      workspace_id TEXT NOT NULL,
      agent_id TEXT NOT NULL,
      conversation_id TEXT NOT NULL,
      name TEXT NOT NULL,
      artifact_type TEXT NOT NULL,
      file_path TEXT,
      content TEXT NOT NULL,
      metadata TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE,
      FOREIGN KEY (agent_id) REFERENCES agents(id) ON DELETE CASCADE,
      FOREIGN KEY (conversation_id) REFERENCES conversations(id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_agents_workspace_id ON agents(workspace_id);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_agents_one_main_per_workspace
      ON agents(workspace_id)
      WHERE role = 'main';
    CREATE INDEX IF NOT EXISTS idx_conversations_agent_id ON conversations(agent_id);
    CREATE INDEX IF NOT EXISTS idx_conversations_workspace_id ON conversations(workspace_id);
    CREATE INDEX IF NOT EXISTS idx_messages_conversation_id ON messages(conversation_id);
    CREATE INDEX IF NOT EXISTS idx_diff_proposals_workspace_id ON diff_proposals(workspace_id);
    CREATE INDEX IF NOT EXISTS idx_diff_proposals_conversation_id ON diff_proposals(conversation_id);
    CREATE INDEX IF NOT EXISTS idx_artifacts_workspace_id ON artifacts(workspace_id);
    CREATE INDEX IF NOT EXISTS idx_artifacts_conversation_id ON artifacts(conversation_id);

    CREATE TABLE IF NOT EXISTS conversation_compact_summaries (
      id TEXT PRIMARY KEY,
      conversation_id TEXT NOT NULL,
      covered_message_start_id TEXT NOT NULL,
      covered_message_end_id TEXT NOT NULL,
      summary TEXT NOT NULL,
      summary_tokens INTEGER,
      raw_tokens_before_compact INTEGER,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      FOREIGN KEY (conversation_id) REFERENCES conversations(id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_conv_compact_summaries_conversation
      ON conversation_compact_summaries(conversation_id);

    CREATE TABLE IF NOT EXISTS agent_drafts (
      id TEXT PRIMARY KEY,
      workspace_id TEXT NOT NULL,
      conversation_id TEXT NOT NULL,
      created_by_agent_id TEXT NOT NULL,
      name TEXT NOT NULL,
      runtime_provider TEXT NOT NULL,
      recommended_system_prompt TEXT NOT NULL,
      capabilities TEXT NOT NULL,
      tools TEXT NOT NULL,
      file_scope TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      raw_user_request TEXT NOT NULL,
      raw_model_output TEXT NOT NULL,
      reason TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE,
      FOREIGN KEY (conversation_id) REFERENCES conversations(id) ON DELETE CASCADE,
      FOREIGN KEY (created_by_agent_id) REFERENCES agents(id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_agent_drafts_workspace_id ON agent_drafts(workspace_id);
    CREATE INDEX IF NOT EXISTS idx_agent_drafts_conversation_id ON agent_drafts(conversation_id);
    CREATE INDEX IF NOT EXISTS idx_agent_drafts_status ON agent_drafts(status);

    CREATE TABLE IF NOT EXISTS conversation_members (
      id TEXT PRIMARY KEY,
      conversation_id TEXT NOT NULL,
      member_type TEXT NOT NULL,
      member_id TEXT NOT NULL,
      role TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'active',
      joined_at TEXT NOT NULL,
      FOREIGN KEY (conversation_id) REFERENCES conversations(id) ON DELETE CASCADE,
      UNIQUE(conversation_id, member_type, member_id)
    );

    CREATE INDEX IF NOT EXISTS idx_conv_members_conversation ON conversation_members(conversation_id);

    CREATE TABLE IF NOT EXISTS dispatch_runs (
      id TEXT PRIMARY KEY,
      conversation_id TEXT NOT NULL,
      trigger_message_id TEXT NOT NULL,
      mode TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'planning',
      max_steps INTEGER NOT NULL DEFAULT ${MAX_DISPATCH_STEPS},
      round_index INTEGER NOT NULL DEFAULT 0,
      acceptance_criteria TEXT NOT NULL DEFAULT '[]',
      orchestrator_review TEXT,
      final_summary_enabled INTEGER NOT NULL DEFAULT 1,
      diff_review_required INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL,
      finished_at TEXT,
      FOREIGN KEY (conversation_id) REFERENCES conversations(id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_dispatch_runs_conversation ON dispatch_runs(conversation_id);

    CREATE TABLE IF NOT EXISTS dispatch_steps (
      id TEXT PRIMARY KEY,
      dispatch_run_id TEXT NOT NULL,
      step_index INTEGER NOT NULL,
      agent_id TEXT NOT NULL,
      instruction TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      round_index INTEGER NOT NULL DEFAULT 0,
      assignment_id TEXT,
      target_criteria TEXT NOT NULL DEFAULT '[]',
      subagent_result TEXT,
      max_iterations INTEGER NOT NULL DEFAULT ${AGENT_EXECUTION_LIMITS.groupSubagentMaxIterations},
      input_context_snapshot TEXT,
      output_message_id TEXT,
      error_message TEXT,
      started_at TEXT,
      finished_at TEXT,
      FOREIGN KEY (dispatch_run_id) REFERENCES dispatch_runs(id) ON DELETE CASCADE,
      FOREIGN KEY (agent_id) REFERENCES agents(id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_dispatch_steps_run ON dispatch_steps(dispatch_run_id);

    CREATE TABLE IF NOT EXISTS conversation_provider_sessions (
      id TEXT PRIMARY KEY,
      conversation_id TEXT NOT NULL,
      workspace_id TEXT NOT NULL,
      agent_id TEXT NOT NULL,
      provider TEXT NOT NULL,
      provider_session_id TEXT NOT NULL,
      root_path TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'active',
      failure_reason TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      FOREIGN KEY (conversation_id) REFERENCES conversations(id) ON DELETE CASCADE,
      FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE,
      FOREIGN KEY (agent_id) REFERENCES agents(id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_prov_sessions_conversation ON conversation_provider_sessions(conversation_id);
    CREATE INDEX IF NOT EXISTS idx_prov_sessions_status ON conversation_provider_sessions(status);

    CREATE TABLE IF NOT EXISTS conversation_provider_sessions_v2 (
      id TEXT PRIMARY KEY,
      conversation_id TEXT NOT NULL,
      workspace_id TEXT NOT NULL,
      agent_id TEXT,
      provider TEXT NOT NULL,
      provider_session_id TEXT NOT NULL,
      workspace_context_id TEXT,
      root_path TEXT NOT NULL,
      execution_scope TEXT,
      status TEXT NOT NULL DEFAULT 'active',
      failure_reason TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      FOREIGN KEY (conversation_id) REFERENCES conversations(id) ON DELETE CASCADE,
      FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE,
      FOREIGN KEY (agent_id) REFERENCES agents(id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_prov_sessions_v2_conversation
      ON conversation_provider_sessions_v2(conversation_id);
    CREATE INDEX IF NOT EXISTS idx_prov_sessions_v2_status
      ON conversation_provider_sessions_v2(status);
    CREATE INDEX IF NOT EXISTS idx_prov_sessions_v2_scope
      ON conversation_provider_sessions_v2(
        conversation_id, agent_id, provider, workspace_context_id, root_path, execution_scope
      );

    CREATE TABLE IF NOT EXISTS agent_runs (
      id TEXT PRIMARY KEY,
      conversation_id TEXT NOT NULL,
      workspace_id TEXT NOT NULL,
      agent_id TEXT NOT NULL,
      provider TEXT NOT NULL,
      provider_session_id TEXT,
      root_path TEXT NOT NULL,
      system_prompt_snapshot TEXT NOT NULL,
      tool_permissions_snapshot TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'running',
      mode TEXT NOT NULL DEFAULT 'single_chat',
      workspace_context_id TEXT,
      execution_scope TEXT,
      dispatch_step_id TEXT,
      max_iterations INTEGER NOT NULL DEFAULT ${AGENT_EXECUTION_LIMITS.singleChatMaxIterations},
      iterations_used INTEGER,
      raw_output TEXT,
      started_at TEXT NOT NULL,
      ended_at TEXT,
      error_message TEXT,
      used_fallback INTEGER NOT NULL DEFAULT 0,
      FOREIGN KEY (conversation_id) REFERENCES conversations(id) ON DELETE CASCADE,
      FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE,
      FOREIGN KEY (agent_id) REFERENCES agents(id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_agent_runs_conversation ON agent_runs(conversation_id);
    CREATE INDEX IF NOT EXISTS idx_agent_runs_status ON agent_runs(status);

    CREATE TABLE IF NOT EXISTS agent_project_experiences (
      id TEXT PRIMARY KEY,
      agent_id TEXT NOT NULL,
      group_conversation_id TEXT NOT NULL,
      group_name TEXT NOT NULL,
      summary TEXT NOT NULL,
      responsibilities_json TEXT NOT NULL DEFAULT '[]',
      key_decisions_json TEXT NOT NULL DEFAULT '[]',
      files_touched_json TEXT NOT NULL DEFAULT '[]',
      diff_summaries_json TEXT NOT NULL DEFAULT '[]',
      unresolved_issues_json TEXT NOT NULL DEFAULT '[]',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      FOREIGN KEY (agent_id) REFERENCES agents(id) ON DELETE CASCADE,
      FOREIGN KEY (group_conversation_id) REFERENCES conversations(id) ON DELETE CASCADE
    );

    CREATE UNIQUE INDEX IF NOT EXISTS idx_agent_project_experiences_agent_group
      ON agent_project_experiences(agent_id, group_conversation_id);
    CREATE INDEX IF NOT EXISTS idx_agent_project_experiences_group
      ON agent_project_experiences(group_conversation_id);
  `);

  ensureAgentRuntimeProviderColumn(db);
  ensureDiffProposalNewContentColumn(db);
  ensureConversationGroupColumns(db);
  ensureMessageGroupColumns(db);
  ensureDiffProposalGroupColumns(db);
  ensureConversationProviderColumn(db);
  ensureMessageMetadataColumn(db);
  ensureAgentClaudeCodeConfigColumn(db);
  ensureAgentTypeColumn(db);
  ensureAgentDescriptionColumn(db);
  ensureAgentSkillIdsColumn(db);
  // Keep old databases readable without exposing the retired draft workflow.
  ensureLegacyDraftDescriptionColumn(db);
  ensureAgentModelColumns(db);
  ensureDispatchExecutionColumns(db);
  ensureAgentRunExecutionColumns(db);
  ensureAgentWorkspaceContextColumns(db);
  ensureConversationWorkspaceContextColumns(db);

  // Unified agent run event protocol (additive).
  ensureMessageContentMarkdownColumn(db);
  ensureMessageThinkingMarkdownColumn(db);
  ensureAgentRunEventsTable(db);
  ensureGroupRunEventsTable(db);
  ensureMessageArtifactsTable(db);
  ensureConversationRunsTable(db);
  ensureProviderSessionUpsertIndex(db);
}
