import type { LLMToolDefinition } from "./llmProviderAdapters";
import {
  FileServiceError,
  globWorkspaceFiles,
  listWorkspaceDirectory,
  readWorkspaceFile
} from "./fileService";
import type { AgentHubDatabase } from "../db";

export type MainAgentFileToolContext = {
  workspaceId: string;
  conversationId?: string;
  agentId: string;
};

export type MainAgentFileToolResult =
  | { ok: true; output: string }
  | { ok: false; error: string };

type ToolArgs = Record<string, unknown>;

const STRING_PROPERTY: Record<string, unknown> = { type: "string" };
const INTEGER_PROPERTY: Record<string, unknown> = { type: "integer", minimum: 1 };

export const MAIN_AGENT_FILE_TOOLS: LLMToolDefinition[] = [
  {
    name: "read_file",
    description:
      "Read the contents of a file in the current workspace. Path is relative to the workspace root (e.g. 'src/index.ts' or 'README.md'). Files larger than 1MB or binary files are not supported.",
    inputSchema: {
      type: "object",
      properties: {
        path: {
          ...STRING_PROPERTY,
          description: "File path relative to the workspace root."
        }
      },
      required: ["path"],
      additionalProperties: false
    }
  },
  {
    name: "list_files",
    description:
      "List the immediate entries of a directory in the current workspace. Default is the workspace root. Returns file and directory names. Does not recurse into subdirectories.",
    inputSchema: {
      type: "object",
      properties: {
        path: {
          ...STRING_PROPERTY,
          description: "Directory path relative to the workspace root. Defaults to root."
        }
      },
      additionalProperties: false
    }
  },
  {
    name: "glob_files",
    description:
      "Find files in the workspace whose relative paths match a glob pattern. Supports `**` (any path segments), `*` (any chars except `/`), and `?` (single char except `/`). Example: 'src/**/*.ts'.",
    inputSchema: {
      type: "object",
      properties: {
        pattern: {
          ...STRING_PROPERTY,
          description: "Glob pattern, e.g. 'src/**/*.ts'."
        },
        maxResults: {
          ...INTEGER_PROPERTY,
          description: "Maximum number of matches to return. Defaults to 200."
        }
      },
      required: ["pattern"],
      additionalProperties: false
    }
  }
];

function readStringArg(args: ToolArgs, key: string): string {
  const value = args[key];
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`Argument "${key}" must be a non-empty string.`);
  }
  return value.trim();
}

function readOptionalStringArg(args: ToolArgs, key: string): string | undefined {
  const value = args[key];
  if (value === undefined || value === null) {
    return undefined;
  }
  if (typeof value !== "string") {
    throw new Error(`Argument "${key}" must be a string when provided.`);
  }
  return value;
}

function readOptionalIntegerArg(args: ToolArgs, key: string): number | undefined {
  const value = args[key];
  if (value === undefined || value === null) {
    return undefined;
  }
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`Argument "${key}" must be a number when provided.`);
  }
  return value;
}

function formatToolError(toolName: string, error: unknown): string {
  if (error instanceof FileServiceError) {
    return `[${toolName}] ${error.code}: ${error.message}`;
  }
  const message = error instanceof Error ? error.message : String(error);
  return `[${toolName}] ${message}`;
}

async function executeReadFile(
  args: ToolArgs,
  context: MainAgentFileToolContext,
  db?: AgentHubDatabase
): Promise<MainAgentFileToolResult> {
  try {
    const path = readStringArg(args, "path");
    const result = await readWorkspaceFile(
      {
        workspaceId: context.workspaceId,
        conversationId: context.conversationId,
        agentId: context.agentId,
        relativePath: path
      },
      db
    );
    return {
      ok: true,
      output: `path: ${result.relativePath}\nsize: ${result.size} bytes\nlanguage: ${result.language ?? "unknown"}\n---\n${result.content}`
    };
  } catch (error) {
    return { ok: false, error: formatToolError("read_file", error) };
  }
}

async function executeListFiles(
  args: ToolArgs,
  context: MainAgentFileToolContext,
  db?: AgentHubDatabase
): Promise<MainAgentFileToolResult> {
  try {
    const path = readOptionalStringArg(args, "path") ?? "";
    const result = await listWorkspaceDirectory(
      {
        workspaceId: context.workspaceId,
        conversationId: context.conversationId,
        relativePath: path
      },
      db
    );

    if (result.entries.length === 0) {
      return {
        ok: true,
        output: `path: ${result.relativePath || "/"}\n(empty)`
      };
    }

    const lines = result.entries.map((entry) =>
      entry.type === "directory" ? `${entry.name}/` : entry.name
    );
    return {
      ok: true,
      output: `path: ${result.relativePath || "/"}\n${lines.join("\n")}`
    };
  } catch (error) {
    return { ok: false, error: formatToolError("list_files", error) };
  }
}

async function executeGlobFiles(
  args: ToolArgs,
  context: MainAgentFileToolContext,
  db?: AgentHubDatabase
): Promise<MainAgentFileToolResult> {
  try {
    const pattern = readStringArg(args, "pattern");
    const maxResults = readOptionalIntegerArg(args, "maxResults");
    const result = await globWorkspaceFiles(
      {
        workspaceId: context.workspaceId,
        conversationId: context.conversationId,
        pattern,
        maxResults
      },
      db
    );

    if (result.matches.length === 0) {
      return {
        ok: true,
        output: `pattern: ${result.pattern}\n(no matches)`
      };
    }

    const lines = result.matches.map((path) => path);
    const suffix = result.truncated ? "\n(truncated)" : "";
    return {
      ok: true,
      output: `pattern: ${result.pattern}\n${lines.join("\n")}${suffix}`
    };
  } catch (error) {
    return { ok: false, error: formatToolError("glob_files", error) };
  }
}

const EXECUTORS: Record<
  string,
  (
    args: ToolArgs,
    context: MainAgentFileToolContext,
    db?: AgentHubDatabase
  ) => Promise<MainAgentFileToolResult>
> = {
  read_file: executeReadFile,
  list_files: executeListFiles,
  glob_files: executeGlobFiles
};

export function isMainAgentFileTool(name: string): boolean {
  return name in EXECUTORS;
}

export async function executeMainAgentFileTool(
  name: string,
  args: ToolArgs,
  context: MainAgentFileToolContext,
  db?: AgentHubDatabase
): Promise<MainAgentFileToolResult> {
  const executor = EXECUTORS[name];
  if (!executor) {
    return { ok: false, error: `Unknown tool: ${name}` };
  }
  return executor(args, context, db);
}
