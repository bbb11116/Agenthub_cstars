import { afterEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Agent, Workspace } from "../../shared/domain";
import { parseGitStatusOutput, readGitDiff, readGitStatus } from "./gitService";

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
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "agenthub-git-service-"));
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
    name: input.name ?? "Review Agent",
    role: input.role ?? "sub",
    type: input.type ?? "specialist",
    runtimeProvider: input.runtimeProvider ?? "mock",
    systemPrompt: input.systemPrompt ?? "",
    capabilities: input.capabilities ?? ["Review"],
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

describe("gitService", () => {
  it("parses git status --short output into labeled file statuses", () => {
    const files = parseGitStatusOutput(
      [
        " M src/App.tsx",
        "A  src/NewCard.tsx",
        " D src/Removed.ts",
        "?? src/Untracked.tsx",
        "R  src/Old.ts -> src/New.ts",
        "MM src/Both.ts"
      ].join("\n")
    );

    expect(files).toEqual([
      {
        path: "src/App.tsx",
        indexStatus: "",
        worktreeStatus: "M",
        label: "modified"
      },
      {
        path: "src/NewCard.tsx",
        indexStatus: "A",
        worktreeStatus: "",
        label: "added"
      },
      {
        path: "src/Removed.ts",
        indexStatus: "",
        worktreeStatus: "D",
        label: "deleted"
      },
      {
        path: "src/Untracked.tsx",
        indexStatus: "?",
        worktreeStatus: "?",
        label: "untracked"
      },
      {
        path: "src/New.ts",
        indexStatus: "R",
        worktreeStatus: "",
        label: "renamed"
      },
      {
        path: "src/Both.ts",
        indexStatus: "M",
        worktreeStatus: "M",
        label: "modified"
      }
    ]);
  });

  it("returns a non-Git status without running Git when .git is missing", async () => {
    const rootPath = createTempWorkspace();
    const workspace = registerWorkspace(rootPath);

    await expect(readGitStatus({ workspaceId: workspace.id })).resolves.toEqual({
      workspaceId: workspace.id,
      isGitRepo: false,
      files: []
    });
  });

  it("rejects agent Git status reads when gitStatus is not authorized", async () => {
    const rootPath = createTempWorkspace();
    const workspace = registerWorkspace(rootPath);
    const agent = registerAgent({
      tools: {
        readFile: true,
        writeDiff: true,
        applyDiff: false,
        previewArtifact: true,
        gitStatus: false
      }
    });

    await expect(
      readGitStatus({
        workspaceId: workspace.id,
        agentId: agent.id
      })
    ).rejects.toMatchObject({
      code: "TOOL_PERMISSION_DENIED",
      agentId: agent.id,
      tool: "gitStatus",
      message: "Tool permission denied:\nReview Agent is not allowed to use git_status."
    });
  });

  it("rejects diff reads for non-Git workspaces", async () => {
    const rootPath = createTempWorkspace();
    const workspace = registerWorkspace(rootPath);

    await expect(readGitDiff({ workspaceId: workspace.id })).rejects.toMatchObject({
      code: "NOT_GIT_REPO",
      message: "This workspace is not a Git repository."
    });
  });
});
