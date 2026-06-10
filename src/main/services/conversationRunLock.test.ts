import { beforeEach, describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import { initializeSchema } from "../db/schema";
import {
  acquireConversationRun,
  ConversationAlreadyRunningError,
  getInProcessActiveConversations
} from "./conversationRunLock";

function createTestDatabase() {
  const db = new Database(":memory:");
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  initializeSchema(db as unknown as Parameters<typeof initializeSchema>[0]);
  return db;
}

describe("conversationRunLock", () => {
  let db: ReturnType<typeof createTestDatabase>;
  let testCounter = 0;

  function newConversationId(): string {
    return `conv-${++testCounter}`;
  }

  beforeEach(() => {
    db = createTestDatabase();
    // Insert minimal workspaces/agents/conversations to satisfy FK constraints.
    db.prepare(
      `INSERT INTO workspaces (id, name, root_path, main_agent_id, git_enabled, created_at, updated_at)
       VALUES (?, ?, ?, NULL, 0, ?, ?)`
    ).run("ws-1", "ws", "/tmp", new Date().toISOString(), new Date().toISOString());
    db.prepare(
      `INSERT INTO agents (id, workspace_id, name, role, type, runtime_provider, system_prompt,
                           capabilities, tools, file_scope, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      "agent-1",
      "ws-1",
      "Agent",
      "sub",
      "specialist",
      "mock",
      "",
      "[]",
      "{}",
      "[]",
      "available",
      new Date().toISOString(),
      new Date().toISOString()
    );
  });

  function insertConversation(id: string): void {
    db.prepare(
      `INSERT INTO conversations (id, workspace_id, agent_id, title, mode, type, description,
                                  owner_user_id, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      id,
      "ws-1",
      "agent-1",
      "C",
      "single",
      "direct",
      "",
      "local-user",
      "active",
      new Date().toISOString(),
      new Date().toISOString()
    );
  }

  it("acquires and releases a run lock", () => {
    const cid = newConversationId();
    insertConversation(cid);
    const lock = acquireConversationRun({ conversationId: cid, agentId: "agent-1", db });
    expect(lock.runId).toBeTruthy();
    expect(lock.conversationId).toBe(cid);
    expect(getInProcessActiveConversations()).toContain(cid);
    lock.release("completed");
    expect(getInProcessActiveConversations()).not.toContain(cid);
  });

  it("throws ConversationAlreadyRunningError on a second concurrent acquire", () => {
    const cid = newConversationId();
    insertConversation(cid);
    const lock = acquireConversationRun({ conversationId: cid, agentId: "agent-1", db });
    try {
      expect(() =>
        acquireConversationRun({ conversationId: cid, agentId: "agent-1", db })
      ).toThrow(ConversationAlreadyRunningError);
    } finally {
      lock.release("completed");
    }
  });

  it("marks the run as failed on fail()", () => {
    const cid = newConversationId();
    insertConversation(cid);
    const lock = acquireConversationRun({ conversationId: cid, agentId: "agent-1", db });
    lock.fail("oops");
    const row = db
      .prepare("SELECT * FROM conversation_runs WHERE id = ?")
      .get(lock.runId) as { status: string; error_message: string };
    expect(row.status).toBe("failed");
    expect(row.error_message).toBe("oops");
  });

  it("release is idempotent", () => {
    const cid = newConversationId();
    insertConversation(cid);
    const lock = acquireConversationRun({ conversationId: cid, agentId: "agent-1", db });
    lock.release("completed");
    // Calling again should be a no-op, not throw.
    lock.release("completed");
  });
});
