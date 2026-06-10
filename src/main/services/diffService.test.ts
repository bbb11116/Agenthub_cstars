import { afterEach, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { AgentToolPermissions } from "../../shared/domain";
import { closeDatabase, initializeDatabase, type AgentHubDatabase } from "../db";
import { createAgent } from "../db/repositories/agentRepo";
import { createConversation } from "../db/repositories/conversationRepo";
import { createMember } from "../db/repositories/conversationMemberRepo";
import { createDispatchRun } from "../db/repositories/dispatchRunRepo";
import { createDispatchStep } from "../db/repositories/dispatchStepRepo";
import { getDiffProposalsByConversation } from "../db/repositories/diffRepo";
import { createMessage, getMessagesByConversation } from "../db/repositories/messageRepo";
import { createWorkspace } from "../db/repositories/workspaceRepo";
import { applyDiff, createDiffProposal, rejectDiffProposal } from "./diffService";

let tempDir: string | null = null;

function createTempDbPath(): string {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "agenthub-diff-service-"));
  return path.join(tempDir, "agenthub.db");
}

function createFixture(
  db: AgentHubDatabase,
  tools?: Partial<AgentToolPermissions>
) {
  if (!tempDir) {
    throw new Error("Temp directory unavailable.");
  }

  const rootPath = path.join(tempDir, "workspace");
  const filePath = path.join(rootPath, "src", "App.tsx");
  const oldContent = "export function App() {\n  return <h1>Hello</h1>;\n}\n";

  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, oldContent, "utf8");

  const workspace = createWorkspace(
    {
      name: "Diff Workspace",
      rootPath,
      gitEnabled: false
    },
    db
  );
  const agent = createAgent(
    {
      workspaceId: workspace.id,
      name: "Code Agent",
      role: "sub",
      runtimeProvider: "mock",
      systemPrompt: "Propose code diffs.",
      capabilities: ["diff"],
      tools,
      fileScope: ["src"],
      status: "available"
    },
    db
  );
  const conversation = createConversation(
    {
      workspaceId: workspace.id,
      agentId: agent.id,
      title: "Code Review",
      mode: "single"
    },
    db
  );

  return {
    agent,
    conversation,
    filePath,
    oldContent,
    workspace
  };
}

function hasGit(): boolean {
  try {
    execFileSync("git", ["--version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

function initializeGitRepository(rootPath: string): void {
  execFileSync("git", ["init"], { cwd: rootPath, stdio: "ignore" });
  execFileSync("git", ["add", "."], { cwd: rootPath, stdio: "ignore" });
  execFileSync(
    "git",
    [
      "-c",
      "user.email=agenthub@example.test",
      "-c",
      "user.name=AgentHub Test",
      "commit",
      "-m",
      "initial"
    ],
    { cwd: rootPath, stdio: "ignore" }
  );
}

afterEach(() => {
  closeDatabase();

  if (tempDir) {
    fs.rmSync(tempDir, { recursive: true, force: true });
    tempDir = null;
  }
});

describe("diffService", () => {
  it("creates a pending proposal, stores a diff card message, and leaves the file untouched", async () => {
    const db = initializeDatabase({ dbPath: createTempDbPath() });
    const { agent, conversation, filePath, oldContent, workspace } = createFixture(db);
    const newContent = "export function App() {\n  return <h1>Hello AgentHub</h1>;\n}\n";

    const proposal = await createDiffProposal(
      {
        workspaceId: workspace.id,
        agentId: agent.id,
        conversationId: conversation.id,
        filePath: "src/App.tsx",
        newContent
      },
      db
    );

    expect(proposal.status).toBe("pending");
    expect(proposal.filePath).toBe("src/App.tsx");
    expect(proposal.oldContentHash).not.toBe(proposal.newContentHash);
    expect(proposal.diffContent).toContain("--- a/src/App.tsx");
    expect(proposal.diffContent).toContain("+++ b/src/App.tsx");
    expect(proposal.diffContent).toContain("+  return <h1>Hello AgentHub</h1>;");
    expect(fs.readFileSync(filePath, "utf8")).toBe(oldContent);
    expect(getDiffProposalsByConversation(conversation.id, db)).toEqual([proposal]);

    const messages = getMessagesByConversation(conversation.id, db);
    const diffCardMessage = messages.find((message) => message.messageType === "diff_card");

    expect(diffCardMessage?.senderId).toBe(agent.id);
    expect(diffCardMessage?.content).toMatchObject({
      diffProposalId: proposal.id,
      filePath: "src/App.tsx"
    });
  });

  it("creates a pptx proposal with HTML content and an html preview artifact", async () => {
    const db = initializeDatabase({ dbPath: createTempDbPath() });
    const { agent, conversation, workspace } = createFixture(db);
    const htmlContent = `<!DOCTYPE html>
<html>
<head><meta charset="utf-8"><style>body{font-family:sans-serif;}</style></head>
<body><h1>Test Presentation</h1><p>Slide content</p></body>
</html>`;

    const proposal = await createDiffProposal(
      {
        workspaceId: workspace.id,
        agentId: agent.id,
        conversationId: conversation.id,
        filePath: "report.pptx",
        newContent: htmlContent,
        isNewFile: true
      },
      db
    );

    expect(proposal.status).toBe("pending");
    expect(proposal.filePath).toBe("report.pptx");

    const messages = getMessagesByConversation(conversation.id, db);
    const diffCardMessage = messages.find((m) => m.messageType === "diff_card");
    expect(diffCardMessage).toBeDefined();
    expect(diffCardMessage?.content).toMatchObject({
      diffProposalId: proposal.id,
      filePath: "report.pptx"
    });

    // Verify preview artifact was created with type "html" (not "presentation")
    const previewArtifacts = messages
      .flatMap((m) => {
        const artifacts = db
          .prepare("SELECT * FROM message_artifacts WHERE message_id = ?")
          .all(m.id) as Array<{ type: string; payload_json: string }>;
        return artifacts.map((a) => ({ ...a, payload: JSON.parse(a.payload_json) }));
      })
      .filter((a) => a.type === "artifact_preview");

    expect(previewArtifacts.length).toBeGreaterThanOrEqual(1);
    const preview = previewArtifacts.find((a) => a.payload.filePath === "report.pptx");
    expect(preview).toBeDefined();
    expect(preview?.payload.artifactType).toBe("html");
  });

  it("applies a pending proposal after hash validation and creates a system message", async () => {
    const db = initializeDatabase({ dbPath: createTempDbPath() });
    const { agent, conversation, filePath, oldContent, workspace } = createFixture(db);
    const newContent = "export function App() {\n  return <h1>Applied</h1>;\n}\n";
    const proposal = await createDiffProposal(
      {
        workspaceId: workspace.id,
        agentId: agent.id,
        conversationId: conversation.id,
        filePath: "src/App.tsx",
        newContent
      },
      db
    );

    expect(fs.readFileSync(filePath, "utf8")).toBe(oldContent);

    const result = await applyDiff(
      {
        workspaceId: workspace.id,
        diffProposalId: proposal.id
      },
      db
    );

    expect(result.status).toBe("applied");
    expect(result.diffProposal?.status).toBe("applied");
    expect(fs.readFileSync(filePath, "utf8")).toBe(newContent);
    expect(getDiffProposalsByConversation(conversation.id, db)[0]).toMatchObject({
      id: proposal.id,
      status: "applied"
    });

    const messages = getMessagesByConversation(conversation.id, db);
    expect(messages).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          senderType: "system",
          senderId: "diff-apply",
          messageType: "text",
          content: {
            text: "Diff applied successfully"
          }
        })
      ])
    );
  });

  it("marks a proposal conflicted and does not overwrite user changes when the hash changed", async () => {
    const db = initializeDatabase({ dbPath: createTempDbPath() });
    const { agent, conversation, filePath, workspace } = createFixture(db);
    const proposedContent = "export function App() {\n  return <h1>Proposed</h1>;\n}\n";
    const userContent = "export function App() {\n  return <h1>User edit</h1>;\n}\n";
    const proposal = await createDiffProposal(
      {
        workspaceId: workspace.id,
        agentId: agent.id,
        conversationId: conversation.id,
        filePath: "src/App.tsx",
        newContent: proposedContent
      },
      db
    );

    fs.writeFileSync(filePath, userContent, "utf8");

    const result = await applyDiff(
      {
        workspaceId: workspace.id,
        diffProposalId: proposal.id
      },
      db
    );

    expect(result.status).toBe("conflicted");
    expect(result.diffProposal?.status).toBe("conflicted");
    expect(result.error).toBe("文件已被修改，请重新生成 Diff。");
    expect(fs.readFileSync(filePath, "utf8")).toBe(userContent);
  });

  it("rejects a pending proposal without writing the file", async () => {
    const db = initializeDatabase({ dbPath: createTempDbPath() });
    const { agent, conversation, filePath, oldContent, workspace } = createFixture(db);
    const proposal = await createDiffProposal(
      {
        workspaceId: workspace.id,
        agentId: agent.id,
        conversationId: conversation.id,
        filePath: "src/App.tsx",
        newContent: "export function App() {\n  return <h1>Rejected</h1>;\n}\n"
      },
      db
    );

    const rejectedProposal = rejectDiffProposal(
      {
        workspaceId: workspace.id,
        diffProposalId: proposal.id
      },
      db
    );

    expect(rejectedProposal.status).toBe("rejected");
    expect(fs.readFileSync(filePath, "utf8")).toBe(oldContent);
  });

  (hasGit() ? it : it.skip)(
    "returns refreshed Git status with the applied file marked modified",
    async () => {
      const db = initializeDatabase({ dbPath: createTempDbPath() });
      const { agent, conversation, filePath, workspace } = createFixture(db);
      const newContent = "export function App() {\n  return <h1>Git modified</h1>;\n}\n";

      initializeGitRepository(workspace.rootPath);

      const proposal = await createDiffProposal(
        {
          workspaceId: workspace.id,
          agentId: agent.id,
          conversationId: conversation.id,
          filePath: "src/App.tsx",
          newContent
        },
        db
      );
      const result = await applyDiff(
        {
          workspaceId: workspace.id,
          diffProposalId: proposal.id
        },
        db
      );

      expect(fs.readFileSync(filePath, "utf8")).toBe(newContent);
      expect(result.gitStatus?.files).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            path: "src/App.tsx",
            label: "modified"
          })
        ])
      );
    }
  );

  it("rejects paths outside the workspace", async () => {
    const db = initializeDatabase({ dbPath: createTempDbPath() });
    const { agent, conversation, workspace } = createFixture(db);

    await expect(
      createDiffProposal(
        {
          workspaceId: workspace.id,
          agentId: agent.id,
          conversationId: conversation.id,
          filePath: "../App.tsx",
          newContent: "changed"
        },
        db
      )
    ).rejects.toMatchObject({
      code: "PATH_OUTSIDE_WORKSPACE",
      message: "Security blocked:\nFile access outside workspace is not allowed."
    });
  });

  it("rejects agent diff proposals when writeDiff is not authorized", async () => {
    const db = initializeDatabase({ dbPath: createTempDbPath() });
    const { agent, conversation, workspace } = createFixture(db, {
      writeDiff: false
    });

    await expect(
      createDiffProposal(
        {
          workspaceId: workspace.id,
          agentId: agent.id,
          conversationId: conversation.id,
          filePath: "src/App.tsx",
          newContent: "export function App() {\n  return <h1>Denied</h1>;\n}\n"
        },
        db
      )
    ).rejects.toMatchObject({
      code: "TOOL_PERMISSION_DENIED",
      agentId: agent.id,
      tool: "writeDiff",
      message: "Tool permission denied:\nCode Agent is not allowed to use write_diff."
    });
  });

  it("rejects direct agent applyDiff requests while user apply still succeeds", async () => {
    const db = initializeDatabase({ dbPath: createTempDbPath() });
    const { agent, conversation, filePath, workspace } = createFixture(db);
    const newContent = "export function App() {\n  return <h1>User applied</h1>;\n}\n";
    const proposal = await createDiffProposal(
      {
        workspaceId: workspace.id,
        agentId: agent.id,
        conversationId: conversation.id,
        filePath: "src/App.tsx",
        newContent
      },
      db
    );

    const blockedResult = await applyDiff(
      {
        workspaceId: workspace.id,
        diffProposalId: proposal.id,
        agentId: agent.id
      },
      db
    );

    expect(blockedResult).toMatchObject({
      status: "failed",
      diffProposal: null,
      error: "Tool permission denied:\napplyDiff is reserved for explicit Diff UI actions. Agents must submit DiffProposal and wait for user confirmation."
    });

    const userResult = await applyDiff(
      {
        workspaceId: workspace.id,
        diffProposalId: proposal.id
      },
      db
    );

    expect(userResult.status).toBe("applied");
    expect(fs.readFileSync(filePath, "utf8")).toBe(newContent);
  });

  it("does not create proposals for unchanged content", async () => {
    const db = initializeDatabase({ dbPath: createTempDbPath() });
    const { agent, conversation, oldContent, workspace } = createFixture(db);

    await expect(
      createDiffProposal(
        {
          workspaceId: workspace.id,
          agentId: agent.id,
          conversationId: conversation.id,
          filePath: "src/App.tsx",
          newContent: oldContent
        },
        db
      )
    ).rejects.toMatchObject({
      code: "NO_CHANGES"
    });

    expect(getDiffProposalsByConversation(conversation.id, db)).toEqual([]);
  });

  it("does not create text diffs for binary files", async () => {
    const db = initializeDatabase({ dbPath: createTempDbPath() });
    const { agent, conversation, workspace } = createFixture(db);
    const binaryPath = path.join(workspace.rootPath, "src", "asset.bin");

    fs.writeFileSync(binaryPath, Buffer.from([0, 1, 2, 3]));

    await expect(
      createDiffProposal(
        {
          workspaceId: workspace.id,
          agentId: agent.id,
          conversationId: conversation.id,
          filePath: "src/asset.bin",
          newContent: "changed"
        },
        db
      )
    ).rejects.toMatchObject({
      code: "BINARY_FILE"
    });
  });

  it("binds a group sub-agent DiffProposal to its own dispatch step", async () => {
    const db = initializeDatabase({ dbPath: createTempDbPath() });
    const { agent, filePath, oldContent, workspace } = createFixture(db);
    const mainAgent = createAgent(
      {
        workspaceId: workspace.id,
        name: "Main Agent",
        role: "main",
        type: "orchestrator",
        runtimeProvider: "mock",
        status: "available"
      },
      db
    );
    const groupConversation = createConversation(
      {
        workspaceId: workspace.id,
        agentId: mainAgent.id,
        title: "Group Review",
        mode: "single",
        type: "group",
        mainAgentId: mainAgent.id
      },
      db
    );
    createMember(
      {
        conversationId: groupConversation.id,
        memberType: "agent",
        memberId: agent.id,
        role: "member"
      },
      db
    );
    const triggerMessage = createMessage(
      {
        workspaceId: workspace.id,
        conversationId: groupConversation.id,
        senderType: "user",
        senderId: "local-user",
        messageType: "text",
        content: { text: "更新标题" }
      },
      db
    );
    const dispatchRun = createDispatchRun(
      {
        conversationId: groupConversation.id,
        triggerMessageId: triggerMessage.id,
        mode: "mention"
      },
      db
    );
    const dispatchStep = createDispatchStep(
      {
        dispatchRunId: dispatchRun.id,
        stepIndex: 0,
        agentId: agent.id,
        instruction: "更新标题"
      },
      db
    );
    const newContent = "export function App() {\n  return <h1>Group</h1>;\n}\n";

    const proposal = await createDiffProposal(
      {
        workspaceId: workspace.id,
        agentId: agent.id,
        conversationId: groupConversation.id,
        dispatchRunId: dispatchRun.id,
        dispatchStepId: dispatchStep.id,
        filePath: "src/App.tsx",
        newContent
      },
      db
    );

    expect(fs.readFileSync(filePath, "utf8")).toBe(oldContent);
    expect(proposal).toMatchObject({
      dispatchRunId: dispatchRun.id,
      dispatchStepId: dispatchStep.id
    });
    expect(proposal.messageId).toBeTruthy();
  });

  it("creates a proposal from a unified diff and applies the patch on apply", async () => {
    const db = initializeDatabase({ dbPath: createTempDbPath() });
    const { agent, conversation, filePath, oldContent, workspace } = createFixture(db);
    const unifiedDiff = [
      "--- a/src/App.tsx",
      "+++ b/src/App.tsx",
      "@@ -1,3 +1,3 @@",
      " export function App() {",
      "-  return <h1>Hello</h1>;",
      "+  return <h1>Patched</h1>;",
      " }"
    ].join("\n");

    const proposal = await createDiffProposal(
      {
        workspaceId: workspace.id,
        agentId: agent.id,
        conversationId: conversation.id,
        filePath: "src/App.tsx",
        unifiedDiff
      },
      db
    );

    expect(proposal.status).toBe("pending");
    expect(proposal.filePath).toBe("src/App.tsx");
    expect(proposal.diffContent).toBe(unifiedDiff);
    expect(proposal.newContent).toBe(
      "export function App() {\n  return <h1>Patched</h1>;\n}\n"
    );
    expect(fs.readFileSync(filePath, "utf8")).toBe(oldContent);

    const result = await applyDiff(
      { workspaceId: workspace.id, diffProposalId: proposal.id },
      db
    );
    expect(result.status).toBe("applied");
    expect(fs.readFileSync(filePath, "utf8")).toBe(
      "export function App() {\n  return <h1>Patched</h1>;\n}\n"
    );

    const diffCardMessage = getMessagesByConversation(conversation.id, db).find(
      (message) => message.messageType === "diff_card"
    );
    expect(diffCardMessage?.content).toMatchObject({
      diffProposalId: proposal.id,
      filePath: "src/App.tsx"
    });
  });

  it("rejects a unified diff that does not apply to the current file", async () => {
    const db = initializeDatabase({ dbPath: createTempDbPath() });
    const { agent, conversation, workspace } = createFixture(db);
    const brokenDiff = [
      "--- a/src/App.tsx",
      "+++ b/src/App.tsx",
      "@@ -1,3 +1,3 @@",
      " export function App() {",
      "-  return <h1>Original</h1>;",
      "+  return <h1>Does not apply</h1>;",
      " }"
    ].join("\n");

    await expect(
      createDiffProposal(
        {
          workspaceId: workspace.id,
          agentId: agent.id,
          conversationId: conversation.id,
          filePath: "src/App.tsx",
          unifiedDiff: brokenDiff
        },
        db
      )
    ).rejects.toMatchObject({ code: "INVALID_INPUT" });

    expect(getDiffProposalsByConversation(conversation.id, db)).toEqual([]);
  });

  it("creates and applies a new-file proposal, auto-creating parent directories", async () => {
    const db = initializeDatabase({ dbPath: createTempDbPath() });
    const { agent, conversation, workspace } = createFixture(db);
    const newContent = "import React from \"react\";\n\nexport function Button() {\n  return <button>x</button>;\n}\n";

    const proposal = await createDiffProposal(
      {
        workspaceId: workspace.id,
        agentId: agent.id,
        conversationId: conversation.id,
        filePath: "src/components/Button.tsx",
        newContent,
        isNewFile: true
      },
      db
    );

    expect(proposal.filePath).toBe("src/components/Button.tsx");
    expect(proposal.oldContentHash).toBe(
      "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
    );
    expect(proposal.newContent).toBe(newContent);
    expect(proposal.diffContent).toContain("--- a/src/components/Button.tsx");
    expect(proposal.diffContent).toContain("+++ b/src/components/Button.tsx");

    if (!tempDir) throw new Error("Temp directory missing.");
    const onDisk = path.join(tempDir, "workspace", "src", "components", "Button.tsx");
    expect(fs.existsSync(onDisk)).toBe(false);

    const applyResult = await applyDiff(
      {
        workspaceId: workspace.id,
        diffProposalId: proposal.id
      },
      db
    );

    expect(applyResult.status).toBe("applied");
    expect(fs.existsSync(onDisk)).toBe(true);
    expect(fs.readFileSync(onDisk, "utf8")).toBe(newContent);
  });

  it("marks a new-file proposal conflicted when the target file already exists and is non-empty at apply time", async () => {
    const db = initializeDatabase({ dbPath: createTempDbPath() });
    const { agent, conversation, workspace } = createFixture(db);
    const proposal = await createDiffProposal(
      {
        workspaceId: workspace.id,
        agentId: agent.id,
        conversationId: conversation.id,
        filePath: "src/components/Button.tsx",
        newContent: "fresh\n",
        isNewFile: true
      },
      db
    );

    if (!tempDir) throw new Error("Temp directory missing.");
    const conflictingPath = path.join(tempDir, "workspace", "src", "components", "Button.tsx");
    fs.mkdirSync(path.dirname(conflictingPath), { recursive: true });
    fs.writeFileSync(conflictingPath, "pre-existing content\n", "utf8");

    const applyResult = await applyDiff(
      {
        workspaceId: workspace.id,
        diffProposalId: proposal.id
      },
      db
    );

    expect(applyResult.status).toBe("conflicted");
    expect(applyResult.error).toContain("已存在且非空");
    expect(fs.readFileSync(conflictingPath, "utf8")).toBe("pre-existing content\n");
  });
});
