import type { AgentFileDefinition } from "./agenthub-config-schema";
import type { AgentHubDatabase } from "../db";
import { getAgentsByWorkspace, createAgent } from "../db/repositories/agentRepo";
import { isRuntimeProvider } from "../../shared/runtime";
import { loadPromptFile } from "./agenthub-config-loader";

function mapToolsArray(tools: string[]): {
  readFile: boolean;
  writeDiff: boolean;
  applyDiff: boolean;
  previewArtifact: boolean;
  gitStatus: boolean;
  webSearch?: boolean;
  webFetch?: boolean;
} {
  const set = new Set(tools);
  return {
    readFile: set.has("read_file"),
    writeDiff: set.has("write_diff"),
    applyDiff: false,
    previewArtifact: set.has("preview_artifact"),
    gitStatus: set.has("git_status"),
    webSearch: set.has("web_search"),
    webFetch: set.has("web_fetch")
  };
}

export function syncWorkspaceAgentsFromFiles(
  workspaceId: string,
  rootPath: string,
  agentFiles: AgentFileDefinition[],
  db: AgentHubDatabase
): void {
  if (agentFiles.length === 0) return;

  const existingAgents = getAgentsByWorkspace(workspaceId, db);
  const existingByName = new Map(
    existingAgents.filter((a) => a.role !== "main").map((a) => [a.name, a])
  );

  for (const fileAgent of agentFiles) {
    if (!isRuntimeProvider(fileAgent.provider)) continue;

    const systemPrompt = fileAgent.systemPrompt
      ?? (fileAgent.systemPromptPath ? loadPromptFile(fileAgent.systemPromptPath, rootPath) : undefined)
      ?? "";

    const tools = mapToolsArray(fileAgent.tools);
    const capabilities = fileAgent.capabilityTags ?? [];
    const existing = existingByName.get(fileAgent.name);

    if (existing) {
      // The schema has no provenance flag, so do not overwrite a manually edited Agent.
      continue;
    } else {
      // Create new agent from file
      createAgent(
        {
          workspaceId,
          name: fileAgent.name,
          description: fileAgent.description,
          role: "sub",
          type: "specialist",
          runtimeProvider: fileAgent.provider,
          systemPrompt,
          capabilities,
          tools,
          fileScope: ["src/**"]
        },
        db
      );
    }
  }
}
