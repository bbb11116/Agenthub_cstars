import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { closeDatabase, initializeDatabase } from "../db";
import { getAgentsByWorkspace } from "../db/repositories/agentRepo";
import { getMessagesByConversation } from "../db/repositories/messageRepo";
import {
  buildManualSubAgentSystemPrompt,
  createSubAgentManually
} from "./agentService";
import { DEFAULT_MAIN_CONVERSATION_TITLE } from "./conversationService";
import { createWorkspaceFromFolder } from "./workspaceService";

let tempDir: string | null = null;

function createTempRoot(): string {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "agenthub-agent-service-"));
  return tempDir;
}

afterEach(() => {
  closeDatabase();

  if (tempDir) {
    fs.rmSync(tempDir, { recursive: true, force: true });
    tempDir = null;
  }
});

describe("agentService createSubAgentManually", () => {
  it("creates a trimmed Local Codex specialist with a default conversation and confirmation", async () => {
    const rootPath = createTempRoot();
    initializeDatabase({ dbPath: path.join(rootPath, "agenthub.db") });
    const { workspace } = await createWorkspaceFromFolder({
      rootPath,
      mainAgentRuntimeProvider: "mock"
    });

    const result = createSubAgentManually({
      workspaceId: workspace.id,
      provider: "codex_local",
      name: "  Frontend Agent  ",
      description: "  Own React UI implementation.  "
    });

    expect(result.agent).toMatchObject({
      workspaceId: workspace.id,
      name: "Frontend Agent",
      description: "Own React UI implementation.",
      role: "sub",
      type: "specialist",
      runtimeProvider: "codex_local",
      fileScope: [workspace.rootPath],
      systemPrompt: buildManualSubAgentSystemPrompt({
        name: "Frontend Agent",
        description: "Own React UI implementation.",
        workspaceRoot: workspace.rootPath
      }),
      status: "available"
    });
    expect(result.agent.tools.applyDiff).toBe(false);
    expect(result.conversation).toMatchObject({
      workspaceId: workspace.id,
      agentId: result.agent.id,
      title: DEFAULT_MAIN_CONVERSATION_TITLE,
      mode: "single"
    });
    expect(getMessagesByConversation(result.conversation.id)).toEqual([
      expect.objectContaining({
        senderType: "system",
        senderId: "agent-creation",
        messageType: "text",
        content: {
          text: "Sub Agent created manually: Frontend Agent"
        }
      })
    ]);
  });

  it("appends a suffix for duplicate manual names", async () => {
    const rootPath = createTempRoot();
    initializeDatabase({ dbPath: path.join(rootPath, "agenthub.db") });
    const { workspace } = await createWorkspaceFromFolder({
      rootPath,
      mainAgentRuntimeProvider: "mock"
    });
    const input = {
      workspaceId: workspace.id,
      provider: "codex_local" as const,
      name: "Frontend Agent",
      description: "Own React UI implementation."
    };

    expect(createSubAgentManually(input).agent.name).toBe("Frontend Agent");
    expect(createSubAgentManually(input).agent.name).toBe("Frontend Agent 2");
  });

  it("requires a name but saves a blank description as an empty string", async () => {
    const rootPath = createTempRoot();
    initializeDatabase({ dbPath: path.join(rootPath, "agenthub.db") });
    const { workspace } = await createWorkspaceFromFolder({
      rootPath,
      mainAgentRuntimeProvider: "mock"
    });

    expect(() =>
      createSubAgentManually({
        workspaceId: workspace.id,
        provider: "codex_local",
        name: " ",
        description: "Own React UI implementation."
      })
    ).toThrow(/name/);
    const result = createSubAgentManually({
      workspaceId: workspace.id,
      provider: "codex_local",
      name: "Frontend Agent",
      description: " "
    });
    expect(result.agent.description).toBe("");
    expect(result.agent.systemPrompt).not.toHaveLength(0);
    expect(getAgentsByWorkspace(workspace.id).filter((agent) => agent.role === "sub")).toHaveLength(1);
  });
});
