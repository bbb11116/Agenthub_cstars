import type {
  Agent,
  AgentToolName,
  ToolPermissionError
} from "../../shared/domain";
import type { AgentHubDatabase } from "../db";
import { getAgentById } from "../db/repositories/agentRepo";

export type AssertAgentCanUseToolInput = {
  agentId: string;
  tool: AgentToolName;
};

type ToolPermissionServiceErrorOptions = ErrorOptions &
  Partial<Pick<ToolPermissionError, "agentId" | "tool">>;

const TOOL_LABELS: Record<AgentToolName, string> = {
  readFile: "read_file",
  writeDiff: "write_diff",
  applyDiff: "apply_diff",
  previewArtifact: "preview_artifact",
  gitStatus: "git_status",
  webSearch: "web_search",
  webFetch: "web_fetch"
};

export class ToolPermissionServiceError
  extends Error
  implements ToolPermissionError
{
  readonly code = "TOOL_PERMISSION_DENIED";
  readonly agentId?: string;
  readonly tool?: AgentToolName;

  constructor(message: string, options: ToolPermissionServiceErrorOptions = {}) {
    super(message, options);
    this.name = "ToolPermissionServiceError";
    this.agentId = options.agentId;
    this.tool = options.tool;
  }
}

function formatToolName(tool: AgentToolName): string {
  return TOOL_LABELS[tool];
}

function createDeniedMessage(agent: Agent | null, tool: AgentToolName): string {
  const agentName = agent?.name ?? "Agent";

  if (tool === "applyDiff") {
    return [
      "Tool permission denied:",
      "applyDiff is reserved for explicit Diff UI actions. Agents must submit DiffProposal and wait for user confirmation."
    ].join("\n");
  }

  return [
    "Tool permission denied:",
    `${agentName} is not allowed to use ${formatToolName(tool)}.`
  ].join("\n");
}

export function checkToolPermission(
  agent: Agent | null | undefined,
  toolName: AgentToolName
): boolean {
  if (!agent || toolName === "applyDiff") {
    return false;
  }

  return agent.tools[toolName] === true;
}

export function assertAgentCanUseTool(
  input: AssertAgentCanUseToolInput,
  db?: AgentHubDatabase
): void {
  const agent = getAgentById(input.agentId, db);

  if (!checkToolPermission(agent, input.tool)) {
    throw new ToolPermissionServiceError(createDeniedMessage(agent, input.tool), {
      agentId: input.agentId,
      tool: input.tool
    });
  }
}
