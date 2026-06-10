import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { Agent } from "../../shared/domain";
import type { ResolvedConfig } from "./agenthub-config-schema";
import { loadPromptFile } from "./agenthub-config-loader";
import { resolveProviderEnv } from "./provider-env-resolver";

let tempDir: string | null = null;

function createTempRoot(): string {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "agenthub-config-security-"));
  return fs.realpathSync.native(tempDir);
}

function createAgent(): Agent {
  return {
    id: "agent-1",
    workspaceId: "workspace-1",
    name: "Codex Agent",
    role: "sub",
    type: "specialist",
    runtimeProvider: "codex_local",
    systemPrompt: "Edit workspace files when requested.",
    capabilities: ["coding"],
    tools: {
      readFile: true,
      writeDiff: true,
      applyDiff: false,
      previewArtifact: true,
      gitStatus: true
    },
    fileScope: ["src/**"],
    status: "available",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  };
}

afterEach(() => {
  if (tempDir) {
    fs.rmSync(tempDir, { recursive: true, force: true });
    tempDir = null;
  }
});

describe("workspace config security", () => {
  it("loads prompt files only from inside the workspace", () => {
    const parent = createTempRoot();
    const rootPath = path.join(parent, "workspace");
    const promptPath = path.join(rootPath, "prompts", "agent.md");
    const outsidePath = path.join(parent, "outside.md");

    fs.mkdirSync(path.dirname(promptPath), { recursive: true });
    fs.writeFileSync(promptPath, "inside prompt\n");
    fs.writeFileSync(outsidePath, "outside prompt\n");

    expect(loadPromptFile("prompts/agent.md", rootPath)).toBe("inside prompt");
    expect(loadPromptFile("../outside.md", rootPath)).toBeUndefined();
    expect(loadPromptFile(outsidePath, rootPath)).toBeUndefined();
  });

  it("applies only safe workspace-local provider environment overrides", () => {
    const config: ResolvedConfig = {
      global: { version: 1, modelProviders: [] },
      workspace: { version: 1 },
      local: {
        providerEnvOverrides: {
          codex_local: {
            OPENAI_BASE_URL: "https://workspace.example.test",
            OPENAI_MODEL: "workspace-model",
            OPENAI_API_KEY: "untrusted-key",
            PATH: "/tmp/untrusted-bin",
            NODE_OPTIONS: "--require /tmp/untrusted.js"
          }
        }
      },
      merged: {
        modelProviders: [
          {
            id: "provider-1",
            name: "Provider",
            apiFormat: "openai_chat_completions",
            baseUrl: "https://global.example.test",
            isFullUrl: false,
            model: "global-model",
            apiKeyRef: "trusted-key",
            supportsVision: false,
            supportsStreaming: true,
            isDefaultForMainAgent: false,
            limits: {
              contextWindowTokens: 262_144,
              maxOutputTokens: 65_536,
              source: "default_256k"
            },
            createdAt: "2026-01-01T00:00:00.000Z",
            updatedAt: "2026-01-01T00:00:00.000Z"
          }
        ],
        mainAgent: {},
        groupChat: {},
        agentDefaults: {}
      }
    };

    expect(resolveProviderEnv(createAgent(), config)).toEqual({
      OPENAI_BASE_URL: "https://workspace.example.test",
      OPENAI_API_KEY: "trusted-key",
      OPENAI_MODEL: "workspace-model"
    });
  });
});
