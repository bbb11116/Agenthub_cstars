import { afterEach, describe, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { closeDatabase, initializeDatabase } from "../../src/main/db";
import {
  createDemoReactProject,
  initializeDemoGitRepository
} from "../../src/main/demo/demoFixtures";
import { getAgentsByWorkspace } from "../../src/main/db/repositories/agentRepo";
import { getConversationsByAgent } from "../../src/main/db/repositories/conversationRepo";
import { createSubAgentManually } from "../../src/main/services/agentService";
import { applyDiff } from "../../src/main/services/diffService";
import { readGitStatus } from "../../src/main/services/gitService";
import { createMessage } from "../../src/main/services/messageService";
import { runAgentTask } from "../../src/main/services/agentRunService";

let tempDir: string | null = null;

async function createTempRoot(): Promise<string> {
  tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "agenthub-mvp-flow-"));
  return tempDir;
}

afterEach(async () => {
  closeDatabase();

  if (tempDir) {
    await fs.rm(tempDir, { recursive: true, force: true });
    tempDir = null;
  }
});

describe("MVP demo flow", () => {
  it("creates a Workspace, creates a React Agent, generates and applies a Diff, then refreshes Git status", async () => {
    const tempRoot = await createTempRoot();
    const demoProjectRoot = path.join(tempRoot, "demo-project");
    const { appFilePath } = await createDemoReactProject(demoProjectRoot);

    await initializeDemoGitRepository(demoProjectRoot);
    initializeDatabase({ dbPath: path.join(tempRoot, "agenthub.db") });

    const { createWorkspaceFromFolder } = await import(
      "../../src/main/services/workspaceService"
    );
    const { workspace } = await createWorkspaceFromFolder({
      rootPath: demoProjectRoot,
      mainAgentRuntimeProvider: "mock"
    });
    const mainAgent = getAgentsByWorkspace(workspace.id).find(
      (agent) => agent.role === "main"
    );

    expect(mainAgent).toBeTruthy();

    const { agent: reactAgent, conversation: reactConversation } =
      createSubAgentManually({
        workspaceId: workspace.id,
        provider: "mock",
        name: "React Frontend Agent",
        description: "负责 React 前端页面与组件修改"
      });

    expect(reactAgent.name).toMatch(/React Frontend Agent/);

    const beforeApply = await fs.readFile(appFilePath, "utf8");
    const buttonMessage = createMessage({
      workspaceId: workspace.id,
      conversationId: reactConversation.id,
      senderType: "user",
      senderId: "e2e-user",
      messageType: "text",
      content: {
        text: "把首页按钮改成蓝色"
      }
    });
    const runOutput = await runAgentTask({
      workspaceId: workspace.id,
      conversationId: reactConversation.id,
      agentId: reactAgent.id,
      userMessage: "把首页按钮改成蓝色",
      userMessageId: buttonMessage.id
    });

    expect(runOutput.diffProposal).toMatchObject({
      filePath: "src/App.tsx",
      status: "pending"
    });
    expect(runOutput.artifacts?.some((artifact) => artifact.type === "html")).toBe(true);
    expect(await fs.readFile(appFilePath, "utf8")).toBe(beforeApply);

    const applyResult = await applyDiff({
      workspaceId: workspace.id,
      diffProposalId: runOutput.diffProposal!.id
    });
    const afterApply = await fs.readFile(appFilePath, "utf8");
    const gitStatus = await readGitStatus({ workspaceId: workspace.id });

    expect(applyResult.status).toBe("applied");
    expect(afterApply).toContain('backgroundColor: "#2563eb"');
    expect(afterApply).not.toBe(beforeApply);
    expect(gitStatus).toMatchObject({
      isGitRepo: true
    });
    expect(gitStatus.files).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          path: "src/App.tsx",
          label: "modified"
        })
      ])
    );
  });
});
