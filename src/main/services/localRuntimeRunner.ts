import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import type { Agent, Conversation, Workspace } from "../../shared/domain";
import type {
  LocalAgentRunEvent,
  LocalAgentRunMode,
  RuntimeProvider
} from "../../shared/runtime";
import {
  buildAgentSkillsSystemPrompt,
  getEffectiveAgentCapabilities
} from "./agentSkillCatalogService";

export type RunLocalAgentInput = {
  workspace: Workspace;
  agent: Agent;
  conversation?: Conversation;
  userMessage?: string;
  userPrompt?: string;
  mode: LocalAgentRunMode;
  metaPrompt?: string;
};

export type LocalRuntimeCommand = {
  command: string;
  args: string[];
  cwd: string;
  stdinText: string;
};

type SpawnLocalProcess = (
  command: string,
  args: string[],
  options: {
    cwd: string;
    shell: false;
    windowsHide: true;
  }
) => ChildProcessWithoutNullStreams;

export type RunLocalAgentOptions = {
  timeoutMs?: number;
  reconnectTimeoutMs?: number;
  maxOutputBytes?: number;
  spawnProcess?: SpawnLocalProcess;
};

const DEFAULT_TIMEOUT_MS = 120_000;
const DEFAULT_RECONNECT_TIMEOUT_MS = 5 * 60_000;
const DEFAULT_MAX_OUTPUT_BYTES = 96 * 1024;
const DANGEROUS_ARGUMENTS = new Set(["--danger-full-access", "danger-full-access", "--yolo", "yolo"]);
const DEFAULT_SAFE_FILE_SCOPE = ["src/**"];

function getProviderCommand(provider: RuntimeProvider): string | null {
  switch (provider) {
    case "codex_local":
      return "codex";
    case "claude_code":
      return "claude";
    case "opencode":
      return "opencode";
    case "mock":
    case "builtin_openai":
    case "builtin_anthropic":
      return null;
  }
}

function assertWorkspaceRootPath(workspace: Workspace): void {
  if (!workspace.rootPath || typeof workspace.rootPath !== "string") {
    throw new Error("Workspace rootPath is required.");
  }

  if (!path.isAbsolute(workspace.rootPath)) {
    throw new Error("Workspace rootPath must be absolute.");
  }

  let stats: fs.Stats;

  try {
    stats = fs.statSync(workspace.rootPath);
  } catch (error) {
    throw new Error("Workspace rootPath does not exist.", { cause: error });
  }

  if (!stats.isDirectory()) {
    throw new Error("Workspace rootPath is not a directory.");
  }
}

function assertCommandSafe(command: LocalRuntimeCommand, workspace: Workspace): void {
  if (command.cwd !== workspace.rootPath) {
    throw new Error("Refusing to start local runtime outside workspace.rootPath.");
  }

  if (command.args.some((arg) => DANGEROUS_ARGUMENTS.has(arg))) {
    throw new Error("Refusing to start local runtime with unsafe sandbox arguments.");
  }
}

export function buildMainAgentPrompt(agent: Agent, workspace: Workspace): string {
  return [
    agent.systemPrompt,
    "Language policy: follow the user's latest message language. If the user writes in Chinese, answer in Chinese unless they explicitly request another language.",
    "AgentHub Agents are local Runtime Provider configuration instances, not separate LLM services.",
    `Workspace id: ${workspace.id}`,
    `Workspace name: ${workspace.name}`,
    `workspace.rootPath: ${workspace.rootPath}`,
    "For explicit code or file modification requests only, emit Aider-style SEARCH/REPLACE edit blocks (file path on its own line, then a fenced block containing one or more `<<<<<<< SEARCH / ======= / >>>>>>> REPLACE` pairs whose SEARCH text matches the current file byte-for-byte). AgentHub turns each block into a DiffProposal. For ordinary chat, identity questions, explanation, analysis, code reading, architecture discussion, or design advice, answer naturally as plain text without edit blocks or 'No file changes proposed' notices. Never bypass AgentHub by writing files yourself, and never emit raw unified diffs / ```diff fences — they will be ignored.",
    "AgentHub FULLY supports creating new files via edit blocks. To create a new file, emit a fenced block whose SEARCH segment is empty and whose REPLACE segment contains the full file contents. The target file must not already exist (non-empty); otherwise use a normal SEARCH/REPLACE block. AgentHub will create the file and any missing parent directories. When the user asks you to create a new file, ALWAYS emit an empty-SEARCH DiffProposal — do NOT tell the user that creating new files is unsupported."
  ]
    .filter((line) => line.trim().length > 0)
    .join("\n");
}

function getUserMessage(input: RunLocalAgentInput): string {
  return input.userMessage ?? input.userPrompt ?? "";
}

function getEffectiveFileScope(agent: Agent): string[] {
  return agent.fileScope.length > 0 ? agent.fileScope : DEFAULT_SAFE_FILE_SCOPE;
}

function formatToolPermissions(agent: Agent): string {
  return Object.entries({
    ...agent.tools,
    applyDiff: false
  })
    .map(([tool, enabled]) => `${tool}=${enabled ? "true" : "false"}`)
    .join(", ");
}

function buildRuntimePrompt(input: RunLocalAgentInput): string {
  const systemPrompt =
    input.agent.role === "main"
      ? buildMainAgentPrompt(input.agent, input.workspace)
      : input.agent.systemPrompt;
  const skillsPrompt = buildAgentSkillsSystemPrompt(input.agent.skillIds ?? []);
  const userMessage = getUserMessage(input);
  const systemPromptWithSkills = [systemPrompt, skillsPrompt]
    .filter((part) => part.trim().length > 0)
    .join("\n\n");
  const effectiveSystemPrompt = input.metaPrompt
    ? `${input.metaPrompt}\n\n---\n\n${systemPromptWithSkills}`
    : systemPromptWithSkills;
  const capabilities = getEffectiveAgentCapabilities(input.agent);

  return [
    effectiveSystemPrompt,
    "Language policy: follow the user's latest message language. If the user writes in Chinese, answer in Chinese unless they explicitly request another language.",
    "AgentHub execution model: Claude Code, Codex Local, or OpenCode provides local code intelligence; AgentHub Built-in uses the configured Model Provider for conversational tasks.",
    `Workspace root path: ${input.workspace.rootPath}`,
    `Agent runtime provider: ${input.agent.runtimeProvider}`,
    `Agent role: ${input.agent.role}`,
    `Agent capabilities: ${capabilities.join(", ") || "coding"}`,
    `Agent tools: ${formatToolPermissions(input.agent)}`,
    `Agent file scope: ${getEffectiveFileScope(input.agent).join(", ")}`,
    input.conversation ? `Conversation id: ${input.conversation.id}` : "",
    "User prompt:",
    userMessage,
    "IMPORTANT: For explicit code or file modification requests only, emit Aider-style SEARCH/REPLACE edit blocks (file path on its own line, then a fenced block with one or more `<<<<<<< SEARCH / ======= / >>>>>>> REPLACE` pairs; SEARCH must match the current file byte-for-byte and be uniquely locatable — read the file with read_file first). Never write final file changes directly, and never emit raw unified diffs / ```diff fences. For ordinary chat, identity questions, explanation, analysis, code reading, architecture discussion, or design advice, answer naturally as plain text without edit blocks or 'No file changes proposed' notices.",
    "AgentHub FULLY supports creating new files via edit blocks. To create a new file, emit a fenced block whose SEARCH segment is empty and whose REPLACE segment contains the full file contents. The target file must not already exist (non-empty); otherwise use a normal SEARCH/REPLACE block. AgentHub will create the file and any missing parent directories. When the user asks you to create a new file, ALWAYS emit an empty-SEARCH DiffProposal — do NOT tell the user that creating new files is unsupported."
  ]
    .filter((line) => line.trim().length > 0)
    .join("\n\n");
}

export function buildLocalRuntimeCommand(input: RunLocalAgentInput): LocalRuntimeCommand | null {
  assertWorkspaceRootPath(input.workspace);

  const command = getProviderCommand(input.agent.runtimeProvider);

  if (!command) {
    return null;
  }

  const runtimePrompt = buildRuntimePrompt(input);
  let localCommand: LocalRuntimeCommand;

  if (input.agent.runtimeProvider === "codex_local") {
    localCommand = {
      command,
      args:
        input.mode === "non_interactive"
          ? [
              "exec",
              "--cd",
              input.workspace.rootPath,
              "--skip-git-repo-check",
              "-"
            ]
          : ["--cd", input.workspace.rootPath],
      cwd: input.workspace.rootPath,
      stdinText: runtimePrompt
    };
  } else if (input.agent.runtimeProvider === "claude_code") {
    localCommand = {
      command,
      args: ["--append-system-prompt", input.agent.systemPrompt],
      cwd: input.workspace.rootPath,
      stdinText: runtimePrompt
    };
  } else {
    localCommand = {
      command,
      args: [],
      cwd: input.workspace.rootPath,
      stdinText: runtimePrompt
    };
  }

  assertCommandSafe(localCommand, input.workspace);
  return localCommand;
}

function appendChunkWithLimit(
  currentBytes: number,
  text: string,
  maxOutputBytes: number
): { text: string; nextBytes: number; truncated: boolean } {
  const chunkBytes = Buffer.byteLength(text, "utf8");

  if (currentBytes + chunkBytes <= maxOutputBytes) {
    return {
      text,
      nextBytes: currentBytes + chunkBytes,
      truncated: false
    };
  }

  const remainingBytes = Math.max(0, maxOutputBytes - currentBytes);

  if (remainingBytes === 0) {
    return {
      text: "",
      nextBytes: currentBytes,
      truncated: true
    };
  }

  return {
    text: Buffer.from(text).subarray(0, remainingBytes).toString("utf8"),
    nextBytes: maxOutputBytes,
    truncated: true
  };
}

function normalizeSpawnError(error: NodeJS.ErrnoException): string {
  if (error.code === "ENOENT") {
    return "command not found";
  }

  if (error.code === "EACCES" || error.code === "EPERM") {
    return "permission denied";
  }

  return error.message || "local runtime failed";
}

function isReconnectNotice(text: string): boolean {
  return /reconnecting(?:\.\.\.|…)/i.test(text);
}

export async function* runLocalAgent(
  input: RunLocalAgentInput,
  options: RunLocalAgentOptions = {}
): AsyncIterable<LocalAgentRunEvent> {
  const localCommand = buildLocalRuntimeCommand(input);

  if (!localCommand) {
    yield {
      type: "error",
      error: "Mock runtime does not start a local CLI process."
    };
    return;
  }

  const spawnProcess = options.spawnProcess ?? spawn;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const reconnectTimeoutMs =
    options.reconnectTimeoutMs ?? DEFAULT_RECONNECT_TIMEOUT_MS;
  const maxOutputBytes = options.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES;
  const eventQueue: LocalAgentRunEvent[] = [];
  let notify: (() => void) | null = null;
  let finished = false;
  let stdoutBytes = 0;
  let stderrBytes = 0;
  let timeout: NodeJS.Timeout | undefined;

  function enqueue(event: LocalAgentRunEvent): void {
    eventQueue.push(event);

    if (notify) {
      notify();
      notify = null;
    }
  }

  function scheduleTimeout(ms: number, error = "timeout"): void {
    if (timeout) {
      clearTimeout(timeout);
    }

    timeout = setTimeout(() => {
      child.kill();
      enqueue({
        type: "error",
        error
      });
    }, ms);
  }

  let child: ChildProcessWithoutNullStreams;

  try {
    child = spawnProcess(localCommand.command, localCommand.args, {
      cwd: localCommand.cwd,
      shell: false,
      windowsHide: true
    });
  } catch (error) {
    yield {
      type: "error",
      error: error instanceof Error ? error.message : "Failed to start local runtime."
    };
    return;
  }

  enqueue({
    type: "started",
    provider: input.agent.runtimeProvider,
    cwd: localCommand.cwd
  });

  scheduleTimeout(timeoutMs);

  child.stdout.on("data", (chunk) => {
    const output = appendChunkWithLimit(stdoutBytes, String(chunk), maxOutputBytes);
    stdoutBytes = output.nextBytes;

    if (output.text) {
      enqueue({
        type: "stdout",
        text: output.text
      });
    }

    if (isReconnectNotice(output.text)) {
      scheduleTimeout(reconnectTimeoutMs, "timeout while reconnecting");
    }

    if (output.truncated) {
      enqueue({
        type: "stderr",
        text: "\n[stdout truncated]\n"
      });
    }
  });

  child.stderr.on("data", (chunk) => {
    const output = appendChunkWithLimit(stderrBytes, String(chunk), maxOutputBytes);
    stderrBytes = output.nextBytes;

    if (output.text) {
      enqueue({
        type: "stderr",
        text: output.text
      });
    }

    if (isReconnectNotice(output.text)) {
      scheduleTimeout(reconnectTimeoutMs, "timeout while reconnecting");
    }

    if (output.truncated) {
      enqueue({
        type: "stderr",
        text: "\n[stderr truncated]\n"
      });
    }
  });

  child.on("error", (error: NodeJS.ErrnoException) => {
    if (timeout) {
      clearTimeout(timeout);
    }
    enqueue({
      type: "error",
      error: normalizeSpawnError(error)
    });
    finished = true;

    if (notify) {
      notify();
      notify = null;
    }
  });

  child.on("close", (code) => {
    if (timeout) {
      clearTimeout(timeout);
    }
    enqueue({
      type: "exited",
      code
    });
    finished = true;

    if (notify) {
      notify();
      notify = null;
    }
  });

  if (localCommand.stdinText) {
    child.stdin.write(localCommand.stdinText);
  }
  child.stdin.end();

  while (!finished || eventQueue.length > 0) {
    if (eventQueue.length === 0) {
      await new Promise<void>((resolve) => {
        notify = resolve;
      });
      continue;
    }

    yield eventQueue.shift() as LocalAgentRunEvent;
  }
}
