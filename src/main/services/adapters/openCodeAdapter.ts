import { spawn } from "node:child_process";
import type { AgentAdapter, AgentRunInput, AgentEvent } from "../../../shared/agentAdapter";
import { ResumeFailedError } from "../../../shared/agentAdapter";

const SESSION_ID_PATTERNS = [
  /session[_-]?id[:\s]+"?([a-f0-9-]{36})"?/i,
  /"session_id"\s*:\s*"([a-f0-9-]{36})"/i
];

const RESUME_ERROR_PATTERNS = [
  /session.*not found/i,
  /session.*expired/i,
  /cannot.*resume/i,
  /no.*session/i
];

function buildPrompt(input: AgentRunInput): string {
  if (input.resume.enabled) {
    return input.userMessage;
  }

  const parts: string[] = [];

  if (input.systemPrompt) {
    parts.push(input.systemPrompt);
    parts.push("");
  }

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

export class OpenCodeAdapter implements AgentAdapter {
  async *run(input: AgentRunInput): AsyncIterable<AgentEvent> {
    const args: string[] = ["run"];

    if (input.resume.enabled && input.resume.providerSessionId) {
      args.push("--session", input.resume.providerSessionId);
    }

    const prompt = buildPrompt(input);

    let child;
    try {
      child = spawn("opencode", args, {
        cwd: input.rootPath,
        shell: false,
        windowsHide: true,
        env: input.env ? { ...process.env, ...input.env } : undefined
      });
    } catch (error) {
      yield {
        type: "error",
        message: error instanceof Error ? error.message : "Failed to start OpenCode"
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

    if (prompt) {
      child.stdin.write(prompt);
    }
    child.stdin.end();

    yield { type: "status", status: "running" };

    const exitCode = await new Promise<number | null>((resolve) => {
      child.on("close", resolve);
      child.on("error", () => resolve(1));
    });

    // Try to extract session ID from output
    const combined = stdout + "\n" + stderr;
    let sessionId: string | undefined;

    for (const pattern of SESSION_ID_PATTERNS) {
      const match = combined.match(pattern);
      if (match) {
        sessionId = match[1];
        break;
      }
    }

    if (sessionId) {
      yield {
        type: "provider_session",
        providerSessionId: sessionId
      };
    }

    // Check for resume failures
    if (input.resume.enabled && exitCode !== 0) {
      const isResumeError = RESUME_ERROR_PATTERNS.some((p) => p.test(combined));

      if (isResumeError) {
        throw new ResumeFailedError(
          `OpenCode resume failed: ${stderr.trim() || stdout.trim()}`
        );
      }
    }

    if (stdout.trim()) {
      yield { type: "text_delta", content: stdout };
    }

    if (exitCode !== 0) {
      yield {
        type: "error",
        message: stderr.trim() || `OpenCode exited with code ${exitCode}`
      };
    }

    yield {
      type: "status",
      status: exitCode === 0 ? "completed" : "failed"
    };
  }
}
