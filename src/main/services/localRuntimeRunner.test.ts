import { PassThrough } from "node:stream";
import { EventEmitter } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Agent, RuntimeProvider, Workspace } from "../../shared/domain";
import {
  buildLocalRuntimeCommand,
  buildMainAgentPrompt,
  runLocalAgent
} from "./localRuntimeRunner";

let tempDir: string | null = null;
let originalPath = process.env.PATH;

function createTempRoot(): string {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "agenthub-local-runtime-"));
  return fs.realpathSync.native(tempDir);
}

function createWorkspace(rootPath: string): Workspace {
  return {
    id: "workspace-1",
    name: "Project",
    rootPath,
    mainAgentId: "agent-1",
    gitEnabled: false,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  };
}

function createAgent(provider: RuntimeProvider): Agent {
  return {
    id: "agent-1",
    workspaceId: "workspace-1",
    name: "Main Agent",
    role: "main",
    type: "orchestrator",
    runtimeProvider: provider,
    systemPrompt: "Main Agent rules",
    capabilities: ["workspace-management"],
    tools: {
      readFile: true,
      writeDiff: true,
      applyDiff: false,
      previewArtifact: true,
      gitStatus: true
    },
    fileScope: ["**/*"],
    status: "available",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  };
}

function installFakeCli(binDir: string, command: string): void {
  fs.writeFileSync(
    path.join(binDir, command),
    [
      "#!/bin/sh",
      "printf 'cwd=%s\\n' \"$(pwd)\"",
      "printf 'args=%s\\n' \"$*\"",
      "printf 'stdin='",
      "cat",
      "printf '\\n'"
    ].join("\n")
  );
  fs.chmodSync(path.join(binDir, command), 0o755);
}

afterEach(() => {
  process.env.PATH = originalPath;

  if (tempDir) {
    fs.rmSync(tempDir, { recursive: true, force: true });
    tempDir = null;
  }
});

describe("localRuntimeRunner", () => {
  it("builds Codex Local command with --cd and workspace cwd without unsafe flags", () => {
    const rootPath = createTempRoot();
    const command = buildLocalRuntimeCommand({
      workspace: createWorkspace(rootPath),
      agent: createAgent("codex_local"),
      userPrompt: "Please print cwd",
      mode: "non_interactive"
    });

    expect(command).toMatchObject({
      command: "codex",
      cwd: rootPath
    });
    expect(command?.args).toEqual([
      "exec",
      "--cd",
      rootPath,
      "--skip-git-repo-check",
      "-"
    ]);
    expect(command?.args).not.toContain("danger-full-access");
    expect(command?.args).not.toContain("yolo");
    expect(command?.stdinText).toContain("Main Agent rules");
    expect(command?.stdinText).toContain("Please print cwd");
    expect(command?.stdinText).toContain("For explicit code or file modification requests only");
    expect(command?.stdinText).toContain("answer naturally as plain text");
  });

  it("builds Claude Code command with workspace cwd and appended system prompt", () => {
    const rootPath = createTempRoot();
    const command = buildLocalRuntimeCommand({
      workspace: createWorkspace(rootPath),
      agent: createAgent("claude_code"),
      userPrompt: "Please print cwd",
      mode: "non_interactive"
    });

    expect(command).toEqual({
      command: "claude",
      args: ["--append-system-prompt", "Main Agent rules"],
      cwd: rootPath,
      stdinText: expect.stringContaining("Please print cwd")
    });
  });

  it("streams local CLI events from the workspace root", async () => {
    const rootPath = createTempRoot();
    const binDir = path.join(rootPath, "bin");
    fs.mkdirSync(binDir);
    installFakeCli(binDir, "codex");
    process.env.PATH = `${binDir}${path.delimiter}${originalPath ?? ""}`;

    const events = [];

    for await (const event of runLocalAgent(
      {
        workspace: createWorkspace(rootPath),
        agent: createAgent("codex_local"),
        userPrompt: "Please print cwd",
        mode: "non_interactive"
      },
      {
        timeoutMs: 5_000
      }
    )) {
      events.push(event);
    }

    expect(events[0]).toEqual({
      type: "started",
      provider: "codex_local",
      cwd: rootPath
    });
    expect(events).toContainEqual({
      type: "exited",
      code: 0
    });
    expect(
      events
        .filter((event) => event.type === "stdout")
        .map((event) => event.text)
        .join("")
    ).toContain(`cwd=${rootPath}`);
  });

  it("extends the timeout window when Codex reports Reconnecting", async () => {
    const rootPath = createTempRoot();
    const events = [];
    const spawnProcess = vi.fn(() => {
      const child = new EventEmitter() as any;

      child.stdout = new PassThrough();
      child.stderr = new PassThrough();
      child.stdin = new PassThrough();
      child.kill = vi.fn(() => {
        child.emit("close", null);
        return true;
      });

      setTimeout(() => {
        child.stderr.write("Reconnecting...\n");
      }, 0);
      setTimeout(() => {
        child.stdout.write("connected\n");
        child.emit("close", 0);
      }, 200);

      return child;
    });

    for await (const event of runLocalAgent(
      {
        workspace: createWorkspace(rootPath),
        agent: createAgent("codex_local"),
        userPrompt: "Please print cwd",
        mode: "non_interactive"
      },
      {
        timeoutMs: 100,
        reconnectTimeoutMs: 1_000,
        spawnProcess
      }
    )) {
      events.push(event);
    }

    expect(events).toContainEqual({
      type: "stderr",
      text: "Reconnecting...\n"
    });
    expect(events).toContainEqual({
      type: "exited",
      code: 0
    });
    expect(events).not.toContainEqual({
      type: "error",
      error: "timeout"
    });
  });

  it("returns an unavailable-style error when the CLI command is missing", async () => {
    const rootPath = createTempRoot();
    const events = [];
    process.env.PATH = rootPath;

    for await (const event of runLocalAgent(
      {
        workspace: createWorkspace(rootPath),
        agent: createAgent("codex_local"),
        userPrompt: "Please print cwd",
        mode: "non_interactive"
      },
      {
        timeoutMs: 1_000
      }
    )) {
      events.push(event);
    }

    expect(events).toContainEqual({
      type: "error",
      error: "command not found"
    });
  });

  it("includes workspace constraints in the Main Agent prompt", () => {
    const rootPath = createTempRoot();
    const prompt = buildMainAgentPrompt(createAgent("claude_code"), createWorkspace(rootPath));

    expect(prompt).toContain("Main Agent rules");
    expect(prompt).toContain(`workspace.rootPath: ${rootPath}`);
    expect(prompt).toContain("For explicit code or file modification requests only");
    expect(prompt).toContain("SEARCH/REPLACE edit blocks");
    expect(prompt).toContain("never emit raw unified diffs");
    expect(prompt).toContain("AgentHub FULLY supports creating new files");
  });
});
