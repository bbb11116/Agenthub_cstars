import { spawn } from "node:child_process";
import type { AgentAdapter, AgentRunInput, AgentEvent } from "../../../shared/agentAdapter";
import type { ClaudeCodeConfig, ClaudeCodePermissionMode } from "../../../shared/domain";
import { ResumeFailedError } from "../../../shared/agentAdapter";

const RESUME_ERROR_PATTERNS = [
  /session.*not found/i,
  /session.*expired/i,
  /session.*invalid/i,
  /no.*session/i,
  /cannot.*resume/i,
  /resume.*failed/i
];

// Default Claude Code configuration
const DEFAULT_CLAUDE_CODE_CONFIG: ClaudeCodeConfig = {
  permissionMode: "acceptEdits",
  allowedTools: ["Read", "Glob", "Grep", "Edit", "Write"],
  deniedTools: [
    "Bash(rm -rf *)",
    "Bash(sudo *)",
    "Bash(curl *)",
    "Bash(wget *)",
    "Read(./.env)",
    "Read(./secrets/**)"
  ]
};

function buildPrompt(input: AgentRunInput): string {
  if (input.resume.enabled) {
    return input.userMessage;
  }

  const parts: string[] = [];

  if (input.contextMessages && input.contextMessages.length > 0) {
    parts.push("以下是本对话的历史消息，请基于这些上下文继续工作：\n");
    for (const msg of input.contextMessages.slice(-20)) {
      parts.push(`[${msg.role}]: ${msg.content}`);
    }
    parts.push("");
  }

  parts.push(input.userMessage);
  return parts.join("\n");
}

function buildPermissionArgs(config: ClaudeCodeConfig): string[] {
  const args: string[] = [];

  // Permission mode
  if (config.permissionMode === "bypassPermissions") {
    args.push("--dangerously-skip-permissions");
  } else {
    args.push("--permission-mode", config.permissionMode);
  }

  // Allowed tools
  if (config.allowedTools.length > 0) {
    args.push("--allowedTools", ...config.allowedTools);
  }

  // Disallowed tools
  if (config.deniedTools.length > 0) {
    args.push("--disallowedTools", ...config.deniedTools);
  }

  return args;
}

export class ClaudeCodeAdapter implements AgentAdapter {
  async *run(input: AgentRunInput): AsyncIterable<AgentEvent> {
    const args: string[] = [
      "-p",
      "--output-format",
      "json",
      "--max-turns",
      String(input.runOptions.maxIterations)
    ];

    // Merge config with defaults
    const claudeCodeConfig: ClaudeCodeConfig = {
      ...DEFAULT_CLAUDE_CODE_CONFIG,
      ...input.claudeCodeConfig
    };

    // Add permission arguments
    args.push(...buildPermissionArgs(claudeCodeConfig));

    // Resume session - don't pass system prompt, the session has it
    if (input.resume.enabled && input.resume.providerSessionId) {
      args.push("--resume", input.resume.providerSessionId);
    } else if (input.systemPrompt) {
      // New session or fallback - pass system prompt via flag
      args.push("--append-system-prompt", input.systemPrompt);
    }

    // Prompt as positional argument
    const prompt = buildPrompt(input);
    args.push(prompt);

    let child;
    try {
      child = spawn("claude", args, {
        cwd: input.rootPath,
        shell: false,
        windowsHide: true,
        env: input.env ? { ...process.env, ...input.env } : undefined
      });
    } catch (error) {
      yield {
        type: "error",
        message: error instanceof Error ? error.message : "Failed to start Claude Code"
      };
      return;
    }

    let stdout = "";
    let stderr = "";

    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString();
    });

    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });

    child.stdin.end();

    yield { type: "status", status: "running" };

    const exitCode = await new Promise<number | null>((resolve) => {
      child.on("close", resolve);
      child.on("error", () => resolve(1));
    });

    // Parse JSON output to extract session_id and result
    let resultText = "";
    let sessionId: string | undefined;

    try {
      const jsonData = JSON.parse(stdout.trim());
      sessionId = jsonData.session_id;
      resultText = jsonData.result || "";
    } catch {
      // If JSON parsing fails, use raw stdout as fallback
      resultText = stdout.trim();
    }

    // Emit session ID if captured
    if (sessionId) {
      yield {
        type: "provider_session",
        providerSessionId: sessionId
      };
    }

    // Check for resume failures
    if (input.resume.enabled && exitCode !== 0) {
      const combined = stdout + stderr;
      const isResumeError = RESUME_ERROR_PATTERNS.some((p) => p.test(combined));

      if (isResumeError) {
        throw new ResumeFailedError(
          `Claude Code resume failed: ${stderr.trim() || resultText}`
        );
      }
    }

    if (resultText) {
      yield { type: "text_delta", content: resultText };
    }

    if (exitCode !== 0) {
      yield {
        type: "error",
        message: stderr.trim() || `Claude Code exited with code ${exitCode}`
      };
    }

    yield {
      type: "status",
      status: exitCode === 0 ? "completed" : "failed"
    };
  }
}
