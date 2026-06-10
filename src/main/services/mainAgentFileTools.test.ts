import { afterEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Agent, Workspace } from "../../shared/domain";
import {
  executeMainAgentFileTool,
  isMainAgentFileTool,
  MAIN_AGENT_FILE_TOOLS,
  type MainAgentFileToolContext
} from "./mainAgentFileTools";

const workspaceStore = vi.hoisted(() => ({
  byId: {} as Record<string, Workspace>
}));
const agentStore = vi.hoisted(() => ({
  byId: {} as Record<string, Agent>
}));

vi.mock("../db/repositories/workspaceRepo", () => ({
  getWorkspaceById: (id: string) => workspaceStore.byId[id] ?? null
}));
vi.mock("../db/repositories/agentRepo", () => ({
  getAgentById: (id: string) => agentStore.byId[id] ?? null
}));

let tempDir: string | null = null;

function createTempWorkspace(): string {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "agenthub-main-agent-tools-"));
  const rootPath = path.join(tempDir, "workspace");
  fs.mkdirSync(rootPath);
  return rootPath;
}

function registerWorkspace(rootPath: string): Workspace {
  const workspace: Workspace = {
    id: "workspace-1",
    name: "Workspace",
    rootPath,
    mainAgentId: null,
    gitEnabled: false,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z"
  };
  workspaceStore.byId[workspace.id] = workspace;
  return workspace;
}

function registerAgent(input: Partial<Agent> = {}): Agent {
  const agent: Agent = {
    id: input.id ?? "agent-1",
    workspaceId: input.workspaceId ?? "workspace-1",
    name: input.name ?? "Main Agent",
    role: input.role ?? "main",
    type: input.type ?? "orchestrator",
    runtimeProvider: input.runtimeProvider ?? "mock",
    systemPrompt: input.systemPrompt ?? "",
    capabilities: input.capabilities ?? [],
    tools: {
      readFile: true,
      writeDiff: true,
      applyDiff: false,
      previewArtifact: true,
      gitStatus: true,
      ...input.tools
    },
    fileScope: input.fileScope ?? [],
    status: input.status ?? "available",
    createdAt: input.createdAt ?? "2026-01-01T00:00:00.000Z",
    updatedAt: input.updatedAt ?? "2026-01-01T00:00:00.000Z"
  };
  agentStore.byId[agent.id] = agent;
  return agent;
}

const baseContext = (): MainAgentFileToolContext => ({
  workspaceId: "workspace-1",
  agentId: "agent-1"
});

afterEach(() => {
  workspaceStore.byId = {};
  agentStore.byId = {};
  if (tempDir) {
    fs.rmSync(tempDir, { recursive: true, force: true });
    tempDir = null;
  }
});

describe("mainAgentFileTools", () => {
  it("exposes read_file, list_files, and glob_files tool definitions", () => {
    const names = MAIN_AGENT_FILE_TOOLS.map((tool) => tool.name).sort();
    expect(names).toEqual(["glob_files", "list_files", "read_file"]);
    for (const tool of MAIN_AGENT_FILE_TOOLS) {
      expect(tool.description.length).toBeGreaterThan(10);
      expect(tool.inputSchema.type).toBe("object");
    }
  });

  it("returns file content for read_file", async () => {
    const rootPath = createTempWorkspace();
    fs.writeFileSync(path.join(rootPath, "hello.txt"), "hello world\n");
    registerWorkspace(rootPath);
    registerAgent();

    const result = await executeMainAgentFileTool(
      "read_file",
      { path: "hello.txt" },
      baseContext()
    );

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.output).toContain("path: hello.txt");
      expect(result.output).toContain("hello world");
    }
  });

  it("returns a structured error for read_file on a missing path", async () => {
    const rootPath = createTempWorkspace();
    registerWorkspace(rootPath);
    registerAgent();

    const result = await executeMainAgentFileTool(
      "read_file",
      { path: "does-not-exist.txt" },
      baseContext()
    );

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain("read_file");
    }
  });

  it("returns a directory listing for list_files", async () => {
    const rootPath = createTempWorkspace();
    fs.mkdirSync(path.join(rootPath, "src"), { recursive: true });
    fs.writeFileSync(path.join(rootPath, "README.md"), "x");
    fs.writeFileSync(path.join(rootPath, "src", "index.ts"), "x");
    registerWorkspace(rootPath);
    registerAgent();

    const result = await executeMainAgentFileTool(
      "list_files",
      { path: "" },
      baseContext()
    );

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.output).toContain("src/");
      expect(result.output).toContain("README.md");
    }
  });

  it("returns matching files for glob_files", async () => {
    const rootPath = createTempWorkspace();
    fs.mkdirSync(path.join(rootPath, "src", "components"), { recursive: true });
    fs.writeFileSync(path.join(rootPath, "src", "index.ts"), "x");
    fs.writeFileSync(path.join(rootPath, "src", "components", "App.ts"), "x");
    fs.writeFileSync(path.join(rootPath, "README.md"), "x");
    registerWorkspace(rootPath);
    registerAgent();

    const result = await executeMainAgentFileTool(
      "glob_files",
      { pattern: "src/**/*.ts" },
      baseContext()
    );

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.output).toContain("src/index.ts");
      expect(result.output).toContain("src/components/App.ts");
      expect(result.output).not.toContain("README.md");
    }
  });

  it("returns ok=false for unknown tool names", async () => {
    const result = await executeMainAgentFileTool(
      "not_a_real_tool",
      {},
      baseContext()
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain("Unknown tool");
    }
  });

  it("rejects missing required arguments with a friendly error", async () => {
    const rootPath = createTempWorkspace();
    registerWorkspace(rootPath);
    registerAgent();

    const result = await executeMainAgentFileTool("read_file", {}, baseContext());
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain("path");
    }
  });

  it("rejects read_file when the agent does not have readFile permission", async () => {
    const rootPath = createTempWorkspace();
    fs.writeFileSync(path.join(rootPath, "hello.txt"), "hello");
    registerWorkspace(rootPath);
    registerAgent({ tools: { readFile: false, writeDiff: true, applyDiff: false, previewArtifact: true, gitStatus: true } });

    const result = await executeMainAgentFileTool(
      "read_file",
      { path: "hello.txt" },
      baseContext()
    );
    expect(result.ok).toBe(false);
  });

  it("isMainAgentFileTool only accepts the registered tool names", () => {
    expect(isMainAgentFileTool("read_file")).toBe(true);
    expect(isMainAgentFileTool("list_files")).toBe(true);
    expect(isMainAgentFileTool("glob_files")).toBe(true);
    expect(isMainAgentFileTool("applyDiff")).toBe(false);
  });
});
