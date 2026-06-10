import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { closeDatabase, initializeDatabase } from "./index";
import { createAgent, getAgentsByWorkspace } from "./repositories/agentRepo";
import {
  createArtifact,
  getArtifactsByConversation
} from "./repositories/artifactRepo";
import {
  createConversation,
  getConversationsByAgent
} from "./repositories/conversationRepo";
import {
  createConversationCompactSummary,
  getLatestConversationCompactSummary
} from "./repositories/conversationCompactSummaryRepo";
import {
  createDiffProposal,
  getDiffProposalsByConversation
} from "./repositories/diffRepo";
import {
  createDispatchRun,
  getDispatchRunById
} from "./repositories/dispatchRunRepo";
import { createMessage, getMessagesByConversation } from "./repositories/messageRepo";
import { createWorkspace, getWorkspaceById } from "./repositories/workspaceRepo";
import { MAX_DISPATCH_STEPS } from "../../shared/groupChat";

let tempDir: string | null = null;

function createTempDbPath(): string {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "agenthub-db-smoke-"));
  return path.join(tempDir, "agenthub.db");
}

afterEach(() => {
  closeDatabase();

  if (tempDir) {
    fs.rmSync(tempDir, { recursive: true, force: true });
    tempDir = null;
  }
});

describe("local SQLite repositories", () => {
  it("creates and reads core records after reopening the database", () => {
    const dbPath = createTempDbPath();
    let db = initializeDatabase({ dbPath });

    const workspace = createWorkspace(
      {
        name: "Smoke Workspace",
        rootPath: "/tmp/agenthub-smoke",
        gitEnabled: true
      },
      db
    );
    const agent = createAgent(
      {
        workspaceId: workspace.id,
        name: "Main Agent",
        role: "main",
        runtimeProvider: "mock",
        capabilities: ["chat", "diff"],
        fileScope: ["src"],
        tools: {
          applyDiff: false
        },
        status: "available"
      },
      db
    );
    const conversation = createConversation(
      {
        workspaceId: workspace.id,
        agentId: agent.id,
        title: "Smoke Conversation",
        mode: "single"
      },
      db
    );
    const message = createMessage(
      {
        workspaceId: workspace.id,
        conversationId: conversation.id,
        senderType: "user",
        senderId: "local-user",
        messageType: "text",
        content: { text: "hello database" }
      },
      db
    );
    const compactSummary = createConversationCompactSummary(
      {
        conversationId: conversation.id,
        coveredMessageStartId: message.id,
        coveredMessageEndId: message.id,
        summary: "# Conversation Compact Summary\n\n## User Goal\n\nKeep testing.",
        summaryTokens: 16,
        rawTokensBeforeCompact: 32
      },
      db
    );
    const diffProposal = createDiffProposal(
      {
        workspaceId: workspace.id,
        agentId: agent.id,
        conversationId: conversation.id,
        filePath: "src/example.ts",
        oldContentHash: "old-hash",
        newContentHash: "new-hash",
        diffContent: "--- a/src/example.ts\n+++ b/src/example.ts",
        newContent: "export const example = true;\n"
      },
      db
    );
    const artifact = createArtifact(
      {
        workspaceId: workspace.id,
        agentId: agent.id,
        conversationId: conversation.id,
        title: "Preview",
        type: "html",
        content: "<h1>Smoke preview</h1>",
        language: "html"
      },
      db
    );
    const dispatchRun = createDispatchRun(
      {
        conversationId: conversation.id,
        triggerMessageId: message.id,
        mode: "mention"
      },
      db
    );

    closeDatabase();
    db = initializeDatabase({ dbPath });

    expect(getWorkspaceById(workspace.id, db)).toEqual(workspace);
    expect(getAgentsByWorkspace(workspace.id, db)).toEqual([agent]);
    expect(getConversationsByAgent(agent.id, db)).toEqual([
      {
        ...conversation,
        lastMessageAt: message.createdAt,
        updatedAt: message.createdAt
      }
    ]);
    expect(getMessagesByConversation(conversation.id, db)).toEqual([
      {
        ...message,
        thinking: ""
      }
    ]);
    expect(getLatestConversationCompactSummary(conversation.id, db)).toEqual(compactSummary);
    expect(getDiffProposalsByConversation(conversation.id, db)).toEqual([diffProposal]);
    expect(getArtifactsByConversation(conversation.id, db)).toEqual([artifact]);
    expect(getDispatchRunById(dispatchRun.id, db)?.maxSteps).toBe(MAX_DISPATCH_STEPS);
  });

  it("adds the nullable Agent description column without breaking existing records", () => {
    const dbPath = createTempDbPath();
    const legacyDb = new Database(dbPath);

    legacyDb.exec(`
      CREATE TABLE workspaces (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        root_path TEXT NOT NULL,
        main_agent_id TEXT,
        git_enabled INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE agents (
        id TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL,
        name TEXT NOT NULL,
        role TEXT NOT NULL,
        type TEXT NOT NULL DEFAULT 'specialist',
        runtime_provider TEXT NOT NULL,
        system_prompt TEXT NOT NULL,
        capabilities TEXT NOT NULL,
        tools TEXT NOT NULL,
        file_scope TEXT NOT NULL,
        claude_code_config TEXT,
        model_provider_id TEXT,
        model TEXT,
        status TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      INSERT INTO workspaces (
        id, name, root_path, main_agent_id, git_enabled, created_at, updated_at
      ) VALUES (
        'workspace-1', 'Legacy Workspace', '/tmp/legacy-workspace', 'agent-1', 0, 'now', 'now'
      );
      INSERT INTO agents (
        id, workspace_id, name, role, type, runtime_provider, system_prompt,
        capabilities, tools, file_scope, status, created_at, updated_at
      ) VALUES (
        'agent-1', 'workspace-1', 'Legacy Main Agent', 'main', 'orchestrator',
        'mock', '', '[]', '{}', '[]', 'available', 'now', 'now'
      );
    `);
    legacyDb.close();

    const db = initializeDatabase({ dbPath });
    const descriptionColumn = (
      db.prepare("PRAGMA table_info(agents)").all() as Array<{
        name: string;
        notnull: number;
      }>
    ).find((column) => column.name === "description");

    expect(descriptionColumn).toMatchObject({
      name: "description",
      notnull: 0
    });
    expect(getAgentsByWorkspace("workspace-1", db)[0]).toMatchObject({
      id: "agent-1",
      name: "Legacy Main Agent"
    });
    expect(getAgentsByWorkspace("workspace-1", db)[0].description).toBeUndefined();
  });
});
