import { beforeEach, describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import { initializeSchema } from "../schema";
import {
  upsertProviderSessionV1,
  getActiveProviderSession
} from "./providerSessionRepo";
import type { AgentHubDatabase } from "../index";

function createTestDatabase(): AgentHubDatabase {
  const db = new Database(":memory:");
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  initializeSchema(db as unknown as Parameters<typeof initializeSchema>[0]);
  return db as unknown as AgentHubDatabase;
}

describe("upsertProviderSessionV1", () => {
  let db: AgentHubDatabase;

  beforeEach(() => {
    db = createTestDatabase();
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
    db.prepare(
      `INSERT INTO conversations (id, workspace_id, agent_id, title, mode, type, description,
                                  owner_user_id, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      "conv-1",
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
  });

  it("inserts the first session without raising", () => {
    expect(() =>
      upsertProviderSessionV1(
        {
          conversationId: "conv-1",
          workspaceId: "ws-1",
          agentId: "agent-1",
          provider: "claude_code",
          providerSessionId: "session-A",
          rootPath: "/tmp"
        },
        db
      )
    ).not.toThrow();
  });

  it("upserts a second session with the same (conversation, provider, root_path) instead of raising UNIQUE", () => {
    upsertProviderSessionV1(
      {
        conversationId: "conv-1",
        workspaceId: "ws-1",
        agentId: "agent-1",
        provider: "claude_code",
        providerSessionId: "session-A",
        rootPath: "/tmp"
      },
      db
    );
    // Second message in the same conversation must not throw.
    expect(() =>
      upsertProviderSessionV1(
        {
          conversationId: "conv-1",
          workspaceId: "ws-1",
          agentId: "agent-1",
          provider: "claude_code",
          providerSessionId: "session-B",
          rootPath: "/tmp"
        },
        db
      )
    ).not.toThrow();

    const row = db
      .prepare(
        "SELECT provider_session_id FROM conversation_provider_sessions WHERE conversation_id = ?"
      )
      .get("conv-1") as { provider_session_id: string };
    expect(row.provider_session_id).toBe("session-B");
  });
});
