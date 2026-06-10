import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { closeDatabase, initializeDatabase } from "../db";
import { getAgentsByWorkspace } from "../db/repositories/agentRepo";
import { getConversationsByAgent } from "../db/repositories/conversationRepo";
import { getMessagesByConversation } from "../db/repositories/messageRepo";
import { MANUAL_SUB_AGENT_CREATION_GUIDANCE_TEXT } from "./mainAgentDecision";
import { listMessagesByConversation } from "./messageService";
import { runMainAgent } from "./orchestratorRuntimeService";
import { createWorkspaceFromFolder } from "./workspaceService";

let tempDir: string | null = null;

function createTempRoot(): string {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "agenthub-agent-creation-"));
  return tempDir;
}

afterEach(() => {
  closeDatabase();

  if (tempDir) {
    fs.rmSync(tempDir, { recursive: true, force: true });
    tempDir = null;
  }
});

describe("manual sub Agent creation guidance", () => {
  it("adds the manual creation guide when a Main Agent conversation is created", async () => {
    const rootPath = createTempRoot();
    initializeDatabase({ dbPath: path.join(rootPath, "agenthub.db") });
    const { workspace } = await createWorkspaceFromFolder({
      rootPath,
      mainAgentRuntimeProvider: "mock"
    });
    const mainAgent = getAgentsByWorkspace(workspace.id)[0];
    const conversation = getConversationsByAgent(mainAgent.id)[0];
    const messages = listMessagesByConversation(conversation.id);

    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatchObject({
      workspaceId: workspace.id,
      conversationId: conversation.id,
      senderType: "system",
      senderId: "main-agent-guide",
      messageType: "text"
    });
    expect((messages[0].content as { text: string }).text).toContain("左上角加号");
  });

  it("refreshes an existing Main Agent guide that still describes conversational creation", async () => {
    const rootPath = createTempRoot();
    const db = initializeDatabase({ dbPath: path.join(rootPath, "agenthub.db") });
    const { workspace, mainAgent, mainConversation } = await createWorkspaceFromFolder({
      rootPath,
      mainAgentRuntimeProvider: "mock"
    });

    db.prepare(
      "UPDATE messages SET content = ? WHERE conversation_id = ? AND sender_id = 'main-agent-guide'"
    ).run(
      JSON.stringify({ text: "描述你想创建的 Agent，我会生成配置草案。" }),
      mainConversation.id
    );

    const messages = listMessagesByConversation(mainConversation.id, db);

    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatchObject({
      senderType: "system",
      senderId: "main-agent-guide"
    });
    expect((messages[0].content as { text: string }).text).toContain("左上角加号");
    expect(getAgentsByWorkspace(workspace.id, db)[0].id).toBe(mainAgent.id);
  });

  it("redirects Main Agent chat creation requests without generating a draft card", async () => {
    const rootPath = createTempRoot();
    const db = initializeDatabase({ dbPath: path.join(rootPath, "agenthub.db") });
    const { workspace, mainAgent, mainConversation } = await createWorkspaceFromFolder({
      rootPath,
      mainAgentRuntimeProvider: "mock"
    });

    const output = await runMainAgent(
      {
        workspaceId: workspace.id,
        conversationId: mainConversation.id,
        userMessage: "创建一个前端 Agent"
      },
      db
    );

    expect(output.agent?.id).toBe(mainAgent.id);
    expect(output.messages).toHaveLength(2);
    expect(output.messages[1]).toMatchObject({
      senderType: "agent",
      messageType: "text",
      content: {
        text: MANUAL_SUB_AGENT_CREATION_GUIDANCE_TEXT
      }
    });
    expect(
      getMessagesByConversation(mainConversation.id, db).some(
        (message) => message.messageType === "agent_config_card"
      )
    ).toBe(false);
    expect(
      (db.prepare("SELECT COUNT(*) AS count FROM agent_drafts").get() as { count: number }).count
    ).toBe(0);
  });
});
