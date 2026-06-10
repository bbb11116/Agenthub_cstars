import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { closeDatabase, initializeDatabase } from "../db";
import { getAgentById } from "../db/repositories/agentRepo";
import { getMessagesByConversation } from "../db/repositories/messageRepo";
import { getDiffProposalsByConversation } from "../db/repositories/diffRepo";
import type {
  AgentStatusCardContent,
  RuntimeProvider,
  RuntimeStatus,
  RunAgentStreamEvent,
  TextMessageContent
} from "../../shared/domain";
import { createSubAgentManually } from "./agentService";
import { runAgentTask } from "./agentRunService";
import { createWorkspaceFromFolder } from "./workspaceService";

let tempDir: string | null = null;
const originalPath = process.env.PATH;

function createTempRoot(): string {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "agenthub-agent-run-"));
  return tempDir;
}

function createSubAgent(
  workspaceId: string,
  provider: RuntimeProvider = "mock"
) {
  return createSubAgentManually({
    workspaceId,
    name: "React Frontend Agent",
    provider,
    description: "Create UI changes and propose safe diffs."
  });
}

function installFakeCliScript(binDir: string, command: string, lines: string[]): void {
  fs.writeFileSync(
    path.join(binDir, command),
    lines.join("\n")
  );
  fs.chmodSync(path.join(binDir, command), 0o755);
}

function installFakeCli(binDir: string, command: string): void {
  installFakeCliScript(binDir, command, [
    "#!/bin/sh",
    "printf 'cwd=%s\\n' \"$(pwd)\"",
    "printf 'args=%s\\n' \"$*\"",
    "printf 'stdin='",
    "cat",
    "printf '\\n'"
  ]);
}

const availableRuntime = async (provider: RuntimeProvider): Promise<RuntimeStatus> => ({
  provider,
  available: true,
  checkedAt: new Date().toISOString()
});

afterEach(() => {
  closeDatabase();
  process.env.PATH = originalPath;

  if (tempDir) {
    fs.rmSync(tempDir, { recursive: true, force: true });
    tempDir = null;
  }
});

describe("agentRunService", () => {
  it("sets a running status, records status cards, and restores available on success", async () => {
    const rootPath = createTempRoot();
    initializeDatabase({ dbPath: path.join(rootPath, "agenthub.db") });
    const { workspace } = await createWorkspaceFromFolder({
      rootPath,
      mainAgentRuntimeProvider: "mock"
    });
    const { agent, conversation } = createSubAgent(workspace.id);

    const output = await runAgentTask(
      {
        workspaceId: workspace.id,
        conversationId: conversation.id,
        agentId: agent.id,
        userMessage: "Create a button component"
      },
      undefined,
      availableRuntime,
      async () => {
        expect(getAgentById(agent.id)?.status).toBe("running");
        return {
          title: "React Frontend Agent generated a diff proposal.",
          detail: "Ready for review."
        };
      }
    );

    expect(output.status).toBe("available");
    expect(output.agent?.status).toBe("available");
    expect(getAgentById(agent.id)?.status).toBe("available");
    expect(output.messages.map((message) => message.messageType)).toEqual([
      "agent_status",
      "agent_status"
    ]);
    expect((output.messages[0].content as AgentStatusCardContent).status).toBe("running");
    expect((output.messages[1].content as AgentStatusCardContent).status).toBe("available");
    expect(getMessagesByConversation(conversation.id)).toHaveLength(3);
  });

  it("marks a local Agent unavailable when its configured runtime is unavailable", async () => {
    const rootPath = createTempRoot();
    initializeDatabase({ dbPath: path.join(rootPath, "agenthub.db") });
    const { workspace } = await createWorkspaceFromFolder({
      rootPath,
      mainAgentRuntimeProvider: "mock"
    });
    const { agent, conversation } = createSubAgent(workspace.id, "codex_local");
    const unavailableRuntime = async (
      provider: RuntimeProvider
    ): Promise<RuntimeStatus> => ({
      provider,
      available: false,
      checkedAt: new Date().toISOString(),
      error: "command not found"
    });

    const output = await runAgentTask(
      {
        workspaceId: workspace.id,
        conversationId: conversation.id,
        agentId: agent.id,
        userMessage: "把首页按钮改成蓝色"
      },
      undefined,
      unavailableRuntime
    );

    expect(output.status).toBe("unavailable");
    expect(output.agent?.status).toBe("unavailable");
    expect(getAgentById(agent.id)?.status).toBe("unavailable");
    expect(output.messages).toHaveLength(1);
    expect((output.messages[0].content as AgentStatusCardContent).status).toBe("unavailable");
  });

  it("runs Codex Local from the workspace root and records local run output", async () => {
    const rootPath = createTempRoot();
    const binDir = path.join(rootPath, "bin");
    fs.mkdirSync(binDir);
    installFakeCli(binDir, "codex");
    process.env.PATH = `${binDir}${path.delimiter}${originalPath ?? ""}`;
    initializeDatabase({ dbPath: path.join(rootPath, "agenthub.db") });
    const { workspace } = await createWorkspaceFromFolder({
      rootPath,
      mainAgentRuntimeProvider: "mock"
    });
    const { agent, conversation } = createSubAgent(workspace.id, "codex_local");

    const output = await runAgentTask(
      {
        workspaceId: workspace.id,
        conversationId: conversation.id,
        agentId: agent.id,
        userMessage: "Please print cwd"
      },
      undefined,
      availableRuntime
    );

    expect(output.status).toBe("available");
    expect(output.runLog).toMatchObject({
      provider: "codex_local",
      cwd: workspace.rootPath,
      status: "exited",
      exitCode: 0
    });
    expect(output.runLog?.stdout).toContain(`cwd=${workspace.rootPath}`);
    expect(output.messages).toHaveLength(1);
    expect(output.messages[0]).toMatchObject({
      senderType: "agent",
      messageType: "text"
    });
    expect((output.messages[0].content as TextMessageContent).text).toContain(
      `cwd=${workspace.rootPath}`
    );
  });

  it("stores only successful Codex stdout as the chat reply and keeps stderr in the run log", async () => {
    const rootPath = createTempRoot();
    const binDir = path.join(rootPath, "bin");
    fs.mkdirSync(binDir);
    installFakeCliScript(binDir, "codex", [
      "#!/bin/sh",
      "printf '%s\\n\\n' '我是这个 AgentHub Workspace 的固定 **Main Agent**。'",
      "printf '%s\\n' '我的职责是：理解当前工作区。'",
      "printf '%s\\n' 'OpenAI Codex v0.133.0' >&2",
      "printf '%s\\n' 'tokens used' >&2"
    ]);
    process.env.PATH = `${binDir}${path.delimiter}${originalPath ?? ""}`;
    initializeDatabase({ dbPath: path.join(rootPath, "agenthub.db") });
    const { workspace } = await createWorkspaceFromFolder({
      rootPath,
      mainAgentRuntimeProvider: "mock"
    });
    const { agent, conversation } = createSubAgent(workspace.id, "codex_local");
    const streamEvents: RunAgentStreamEvent[] = [];

    const output = await runAgentTask(
      {
        workspaceId: workspace.id,
        conversationId: conversation.id,
        agentId: agent.id,
        userMessage: "你是什么角色"
      },
      undefined,
      availableRuntime,
      undefined,
      (event) => streamEvents.push(event)
    );

    expect(output.status).toBe("available");
    expect(output.runLog?.stderr).toContain("OpenAI Codex v0.133.0");
    expect(output.messages).toHaveLength(1);
    expect(output.messages[0]).toMatchObject({
      senderType: "agent",
      messageType: "text"
    });
    expect(streamEvents.map((event) => event.text).join("")).toBe(output.runLog?.stdout);

    const content = output.messages[0].content as TextMessageContent;
    expect(content.text).toBe(
      [
        "我是这个 AgentHub Workspace 的固定 **Main Agent**。",
        "",
        "我的职责是：理解当前工作区。"
      ].join("\n")
    );
    expect(content.text).not.toContain("Codex Local run log");
    expect(content.text).not.toContain("stderr:");
    expect(content.text).not.toContain("tokens used");
  });

  it("runs Claude Code from the workspace root when the Agent is bound to Claude", async () => {
    const rootPath = createTempRoot();
    const binDir = path.join(rootPath, "bin");
    fs.mkdirSync(binDir);
    installFakeCli(binDir, "claude");
    process.env.PATH = `${binDir}${path.delimiter}${originalPath ?? ""}`;
    initializeDatabase({ dbPath: path.join(rootPath, "agenthub.db") });
    const { workspace } = await createWorkspaceFromFolder({
      rootPath,
      mainAgentRuntimeProvider: "mock"
    });
    const { agent, conversation } = createSubAgent(workspace.id, "claude_code");

    const output = await runAgentTask(
      {
        workspaceId: workspace.id,
        conversationId: conversation.id,
        agentId: agent.id,
        userMessage: "Please print cwd"
      },
      undefined,
      availableRuntime
    );

    expect(output.status).toBe("available");
    expect(output.runLog).toMatchObject({
      provider: "claude_code",
      cwd: workspace.rootPath,
      status: "exited",
      exitCode: 0
    });
    expect(output.runLog?.stdout).toContain(`cwd=${workspace.rootPath}`);
    expect(output.runLog?.stdout).toContain("--append-system-prompt");
  });

  it("marks the Agent error when the task runner fails", async () => {
    const rootPath = createTempRoot();
    initializeDatabase({ dbPath: path.join(rootPath, "agenthub.db") });
    const { workspace } = await createWorkspaceFromFolder({
      rootPath,
      mainAgentRuntimeProvider: "mock"
    });
    const { agent, conversation } = createSubAgent(workspace.id);

    const output = await runAgentTask(
      {
        workspaceId: workspace.id,
        conversationId: conversation.id,
        agentId: agent.id,
        userMessage: "Run this task"
      },
      undefined,
      availableRuntime,
      async () => {
        throw new Error("Task failed");
      }
    );

    expect(output.status).toBe("error");
    expect(output.agent?.status).toBe("error");
    expect(getAgentById(agent.id)?.status).toBe("error");
    expect((output.messages[0].content as AgentStatusCardContent).status).toBe("running");
    expect((output.messages[1].content as AgentStatusCardContent).status).toBe("error");
  });

  it("strips empty DiffProposal blocks from identity question replies", async () => {
    const rootPath = createTempRoot();
    const binDir = path.join(rootPath, "bin");
    fs.mkdirSync(binDir);
    installFakeCliScript(binDir, "codex", [
      "#!/bin/sh",
      "cat <<'ENDOFOUTPUT'",
      "我是 Codex，本轮作为 AgentHub 的 React 组件子 Agent 运行。",
      "这次只是回答身份问题，不需要提交代码变更，因此没有 DiffProposal。",
      "",
      "```diff",
      "# DiffProposal",
      "# No file changes proposed.",
      "```",
      "ENDOFOUTPUT"
    ]);
    process.env.PATH = `${binDir}${path.delimiter}${originalPath ?? ""}`;
    initializeDatabase({ dbPath: path.join(rootPath, "agenthub.db") });
    const { workspace } = await createWorkspaceFromFolder({
      rootPath,
      mainAgentRuntimeProvider: "mock"
    });
    const { agent, conversation } = createSubAgent(workspace.id, "codex_local");

    const output = await runAgentTask(
      {
        workspaceId: workspace.id,
        conversationId: conversation.id,
        agentId: agent.id,
        userMessage: "你叫什么名字"
      },
      undefined,
      availableRuntime
    );

    expect(output.status).toBe("available");
    expect(output.messages).toHaveLength(1);
    const content = output.messages[0].content as TextMessageContent;
    expect(content.text).toContain("我是 Codex");
    expect(content.text).not.toContain("DiffProposal");
    expect(content.text).not.toContain("No file changes proposed");
    expect(content.text).not.toContain("```diff");
    expect(content.text).not.toContain("本次无需修改文件");
    expect(getDiffProposalsByConversation(conversation.id)).toHaveLength(0);
    expect(getMessagesByConversation(conversation.id).some((m) => m.messageType === "diff_card")).toBe(
      false
    );
  });

  it("strips standalone 'No file changes proposed' text from replies", async () => {
    const rootPath = createTempRoot();
    const binDir = path.join(rootPath, "bin");
    fs.mkdirSync(binDir);
    installFakeCliScript(binDir, "codex", [
      "#!/bin/sh",
      "cat <<'ENDOFOUTPUT'",
      "我是 Codex，本轮作为 AgentHub 里的 React 组件子 Agent 工作。",
      "本次无需修改文件。",
      "ENDOFOUTPUT"
    ]);
    process.env.PATH = `${binDir}${path.delimiter}${originalPath ?? ""}`;
    initializeDatabase({ dbPath: path.join(rootPath, "agenthub.db") });
    const { workspace } = await createWorkspaceFromFolder({
      rootPath,
      mainAgentRuntimeProvider: "mock"
    });
    const { agent, conversation } = createSubAgent(workspace.id, "codex_local");

    const output = await runAgentTask(
      {
        workspaceId: workspace.id,
        conversationId: conversation.id,
        agentId: agent.id,
        userMessage: "你叫什么名字"
      },
      undefined,
      availableRuntime
    );

    expect(output.status).toBe("available");
    const content = output.messages[0].content as TextMessageContent;
    expect(content.text).toContain("我是 Codex");
    expect(content.text).not.toContain("本次无需修改文件");
    expect(getDiffProposalsByConversation(conversation.id)).toHaveLength(0);
  });

  it("does not create diff_card messages for ordinary Markdown code blocks", async () => {
    const rootPath = createTempRoot();
    const binDir = path.join(rootPath, "bin");
    fs.mkdirSync(binDir);
    installFakeCliScript(binDir, "codex", [
      "#!/bin/sh",
      "cat <<'ENDOFOUTPUT'",
      "这里是一个示例：",
      "",
      "```ts",
      "export const answer = 42;",
      "```",
      "ENDOFOUTPUT"
    ]);
    process.env.PATH = `${binDir}${path.delimiter}${originalPath ?? ""}`;
    initializeDatabase({ dbPath: path.join(rootPath, "agenthub.db") });
    const { workspace } = await createWorkspaceFromFolder({
      rootPath,
      mainAgentRuntimeProvider: "mock"
    });
    const { agent, conversation } = createSubAgent(workspace.id, "codex_local");

    const output = await runAgentTask(
      {
        workspaceId: workspace.id,
        conversationId: conversation.id,
        agentId: agent.id,
        userMessage: "解释一下常量写法"
      },
      undefined,
      availableRuntime
    );

    expect(output.status).toBe("available");
    expect(output.messages.some((message) => message.messageType === "diff_card")).toBe(false);
    expect(getDiffProposalsByConversation(conversation.id)).toHaveLength(0);
    const content = output.messages[0].content as TextMessageContent;
    expect(content.text).toContain("```ts");
  });

  it("creates a structured diff_card message for real single-file CLI diffs", async () => {
    const rootPath = createTempRoot();
    fs.mkdirSync(path.join(rootPath, "src"), { recursive: true });
    fs.writeFileSync(
      path.join(rootPath, "src", "Button.tsx"),
      [
        "export function Button() {",
        "  return <button className=\"red\">Save</button>;",
        "}"
      ].join("\n")
    );
    const binDir = path.join(rootPath, "bin");
    fs.mkdirSync(binDir);
    const sr_s = `${"<".repeat(7)} SEARCH`;
    const sr_d = "=".repeat(7);
    const sr_r = `${">".repeat(7)} REPLACE`;
    installFakeCliScript(binDir, "codex", [
      "#!/bin/sh",
      "cat <<'ENDOFOUTPUT'",
      "Here is the button style change:",
      "",
      "src/Button.tsx",
      "```",
      sr_s,
      "  return <button className=\"red\">Save</button>;",
      sr_d,
      "  return <button className=\"blue\">Save</button>;",
      sr_r,
      "```",
      "ENDOFOUTPUT"
    ]);
    process.env.PATH = `${binDir}${path.delimiter}${originalPath ?? ""}`;
    initializeDatabase({ dbPath: path.join(rootPath, "agenthub.db") });
    const { workspace } = await createWorkspaceFromFolder({
      rootPath,
      mainAgentRuntimeProvider: "mock"
    });
    const { agent, conversation } = createSubAgent(workspace.id, "codex_local");

    const output = await runAgentTask(
      {
        workspaceId: workspace.id,
        conversationId: conversation.id,
        agentId: agent.id,
        userMessage: "帮我修改 Button 组件样式"
      },
      undefined,
      availableRuntime
    );

    expect(output.status).toBe("available");
    expect(output.diffProposal).toMatchObject({
      conversationId: conversation.id,
      filePath: "src/Button.tsx",
      status: "pending"
    });
    expect(output.diffProposal?.newContent).toContain("className=\"blue\"");
    expect(output.messages.some((message) => message.messageType === "diff_card")).toBe(true);
    const textMessage = output.messages.find((message) => message.messageType === "text");
    expect((textMessage?.content as TextMessageContent).text).toContain(
      "Here is the button style change:"
    );
    expect((textMessage?.content as TextMessageContent).text).not.toContain("SEARCH");
    expect(getDiffProposalsByConversation(conversation.id)).toHaveLength(1);
    expect(getMessagesByConversation(conversation.id).some((m) => m.messageType === "diff_card")).toBe(
      true
    );
  });
});
