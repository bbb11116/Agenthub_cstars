import { afterEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Agent, Workspace } from "../../shared/domain";
import {
  globWorkspaceFiles,
  listWorkspaceDirectory,
  readFileTree,
  readWorkspaceFile,
  writeWorkspaceTextFile
} from "./fileService";

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
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "agenthub-file-service-"));
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
    name: input.name ?? "React Frontend Agent",
    role: input.role ?? "sub",
    type: input.type ?? "specialist",
    runtimeProvider: input.runtimeProvider ?? "mock",
    systemPrompt: input.systemPrompt ?? "",
    capabilities: input.capabilities ?? ["React"],
    tools: {
      readFile: true,
      writeDiff: true,
      applyDiff: false,
      previewArtifact: true,
      gitStatus: true,
      ...input.tools
    },
    fileScope: input.fileScope ?? ["src/**"],
    status: input.status ?? "available",
    createdAt: input.createdAt ?? "2026-01-01T00:00:00.000Z",
    updatedAt: input.updatedAt ?? "2026-01-01T00:00:00.000Z"
  };

  agentStore.byId[agent.id] = agent;
  return agent;
}

afterEach(() => {
  workspaceStore.byId = {};
  agentStore.byId = {};

  if (tempDir) {
    fs.rmSync(tempDir, { recursive: true, force: true });
    tempDir = null;
  }
});

describe("fileService", () => {
  it("reads the workspace file tree with relative paths and ignored directories filtered", async () => {
    const rootPath = createTempWorkspace();
    fs.mkdirSync(path.join(rootPath, "src"), { recursive: true });
    fs.mkdirSync(path.join(rootPath, "node_modules", "package"), { recursive: true });
    fs.mkdirSync(path.join(rootPath, ".git"), { recursive: true });
    fs.mkdirSync(path.join(rootPath, "build"), { recursive: true });
    fs.writeFileSync(path.join(rootPath, "README.md"), "# Demo");
    fs.writeFileSync(path.join(rootPath, "src", "App.tsx"), "export function App() {}");
    fs.writeFileSync(path.join(rootPath, "node_modules", "package", "index.js"), "");
    fs.writeFileSync(path.join(rootPath, ".git", "config"), "");
    fs.writeFileSync(path.join(rootPath, "build", "bundle.js"), "");

    const workspace = registerWorkspace(rootPath);
    const tree = await readFileTree({ workspaceId: workspace.id });

    expect(tree.map((node) => node.name)).toEqual(["src", "README.md"]);
    expect(tree[0]).toMatchObject({
      name: "src",
      relativePath: "src",
      type: "directory",
      children: [
        {
          name: "App.tsx",
          relativePath: "src/App.tsx",
          type: "file"
        }
      ]
    });
  });

  it("reads text file content and infers the preview language", async () => {
    const rootPath = createTempWorkspace();
    const appContent = "export const value = 1;\n";
    fs.mkdirSync(path.join(rootPath, "src"), { recursive: true });
    fs.writeFileSync(path.join(rootPath, "src", "App.tsx"), appContent);

    const workspace = registerWorkspace(rootPath);
    const content = await readWorkspaceFile({
      workspaceId: workspace.id,
      relativePath: "src/App.tsx"
    });

    expect(content).toMatchObject({
      relativePath: "src/App.tsx",
      content: appContent,
      language: "tsx",
      size: Buffer.byteLength(appContent)
    });
  });

  it("rejects paths outside the workspace root", async () => {
    const rootPath = createTempWorkspace();
    fs.writeFileSync(path.join(tempDir ?? rootPath, "outside.txt"), "nope");

    const workspace = registerWorkspace(rootPath);

    await expect(
      readWorkspaceFile({
        workspaceId: workspace.id,
        relativePath: "../outside.txt"
      })
    ).rejects.toMatchObject({
      code: "PATH_OUTSIDE_WORKSPACE",
      message: "Security blocked:\nFile access outside workspace is not allowed."
    });
  });

  it("rejects agent file reads when readFile is not authorized", async () => {
    const rootPath = createTempWorkspace();
    fs.mkdirSync(path.join(rootPath, "src"), { recursive: true });
    fs.writeFileSync(path.join(rootPath, "src", "App.tsx"), "export const app = true;\n");

    const workspace = registerWorkspace(rootPath);
    const agent = registerAgent({
      tools: {
        readFile: false,
        writeDiff: true,
        applyDiff: false,
        previewArtifact: true,
        gitStatus: true
      }
    });

    await expect(
      readWorkspaceFile({
        workspaceId: workspace.id,
        relativePath: "src/App.tsx",
        agentId: agent.id
      })
    ).rejects.toMatchObject({
      code: "TOOL_PERMISSION_DENIED",
      agentId: agent.id,
      tool: "readFile",
      message:
        "Tool permission denied:\nReact Frontend Agent is not allowed to use read_file."
    });
  });

  it("does not read large or binary files into the preview", async () => {
    const rootPath = createTempWorkspace();
    fs.writeFileSync(path.join(rootPath, "large.txt"), Buffer.alloc(1024 * 1024 + 1, "a"));
    fs.writeFileSync(path.join(rootPath, "image.bin"), Buffer.from([0, 1, 2, 3]));

    const workspace = registerWorkspace(rootPath);

    await expect(
      readWorkspaceFile({
        workspaceId: workspace.id,
        relativePath: "large.txt"
      })
    ).rejects.toMatchObject({
      code: "FILE_TOO_LARGE",
      message: "File too large to preview"
    });
    await expect(
      readWorkspaceFile({
        workspaceId: workspace.id,
        relativePath: "image.bin"
      })
    ).rejects.toMatchObject({
      code: "BINARY_FILE",
      message: "Binary file preview is not supported"
    });
  });

  it("lists a single directory's entries with directories first and ignores noisy subtrees", async () => {
    const rootPath = createTempWorkspace();
    fs.mkdirSync(path.join(rootPath, "src", "components"), { recursive: true });
    fs.mkdirSync(path.join(rootPath, "node_modules"), { recursive: true });
    fs.writeFileSync(path.join(rootPath, "README.md"), "# Demo");
    fs.writeFileSync(path.join(rootPath, "src", "index.ts"), "");
    fs.writeFileSync(path.join(rootPath, "src", "components", "App.tsx"), "");

    const workspace = registerWorkspace(rootPath);
    const result = await listWorkspaceDirectory({ workspaceId: workspace.id });

    expect(result.relativePath).toBe("");
    expect(result.entries.map((entry) => entry.name)).toEqual([
      "src",
      "README.md"
    ]);
    expect(result.entries[0]).toMatchObject({
      name: "src",
      type: "directory"
    });
  });

  it("rejects list requests for paths outside the workspace", async () => {
    const rootPath = createTempWorkspace();
    const workspace = registerWorkspace(rootPath);

    await expect(
      listWorkspaceDirectory({
        workspaceId: workspace.id,
        relativePath: "../"
      })
    ).rejects.toMatchObject({ code: "PATH_OUTSIDE_WORKSPACE" });
  });

  it("returns files matching a glob pattern across nested directories", async () => {
    const rootPath = createTempWorkspace();
    fs.mkdirSync(path.join(rootPath, "src", "components"), { recursive: true });
    fs.mkdirSync(path.join(rootPath, "tests"), { recursive: true });
    fs.writeFileSync(path.join(rootPath, "src", "index.ts"), "");
    fs.writeFileSync(path.join(rootPath, "src", "components", "App.ts"), "");
    fs.writeFileSync(path.join(rootPath, "tests", "App.test.ts"), "");
    fs.writeFileSync(path.join(rootPath, "README.md"), "");

    const workspace = registerWorkspace(rootPath);
    const result = await globWorkspaceFiles({
      workspaceId: workspace.id,
      pattern: "src/**/*.ts"
    });

    expect(result.matches.sort()).toEqual([
      "src/components/App.ts",
      "src/index.ts"
    ]);
    expect(result.truncated).toBe(false);
  });

  it("caps glob results and reports truncation", async () => {
    const rootPath = createTempWorkspace();
    fs.mkdirSync(path.join(rootPath, "src"), { recursive: true });
    for (let i = 0; i < 5; i += 1) {
      fs.writeFileSync(path.join(rootPath, "src", `file${i}.ts`), "");
    }

    const workspace = registerWorkspace(rootPath);
    const result = await globWorkspaceFiles({
      workspaceId: workspace.id,
      pattern: "src/*.ts",
      maxResults: 2
    });

    expect(result.matches).toHaveLength(2);
    expect(result.truncated).toBe(true);
  });

  it("rejects glob requests for empty patterns", async () => {
    const rootPath = createTempWorkspace();
    const workspace = registerWorkspace(rootPath);

    await expect(
      globWorkspaceFiles({
        workspaceId: workspace.id,
        pattern: "   "
      })
    ).rejects.toMatchObject({ code: "INVALID_INPUT" });
  });

  it("creates the target file and any missing parent directories when writing new content", async () => {
    const rootPath = createTempWorkspace();
    const workspace = registerWorkspace(rootPath);
    const nestedPath = "src/lib/auth/new.ts";

    const result = await writeWorkspaceTextFile({
      workspaceId: workspace.id,
      relativePath: nestedPath,
      content: "export function login() {}\n"
    });

    expect(result.relativePath).toBe(nestedPath);
    const onDisk = path.join(rootPath, "src", "lib", "auth", "new.ts");
    expect(fs.existsSync(onDisk)).toBe(true);
    expect(fs.readFileSync(onDisk, "utf8")).toBe("export function login() {}\n");
  });
});
