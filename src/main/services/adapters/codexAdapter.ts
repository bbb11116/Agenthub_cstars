import { spawn } from "node:child_process";
import type { AgentAdapter, AgentRunInput, AgentEvent } from "../../../shared/agentAdapter";
import { ResumeFailedError } from "../../../shared/agentAdapter";

const RESUME_ERROR_PATTERNS = [
  /session.*not found/i,
  /session.*expired/i,
  /cannot.*resume/i,
  /no.*session/i,
  /resume.*failed/i,
  /thread.*not found/i
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

export class CodexAdapter implements AgentAdapter {
  async *run(input: AgentRunInput): AsyncIterable<AgentEvent> {
    const args: string[] = ["exec"];

    if (input.resume.enabled && input.resume.providerSessionId) {
      // Resume: codex exec resume <SESSION_ID> <PROMPT>
      args.push("resume", input.resume.providerSessionId, buildPrompt(input));
    } else {
      // New session: codex exec --json --skip-git-repo-check - (prompt via stdin)
      args.push("--json", "--skip-git-repo-check", "-");
    }

    let child;
    try {
      child = spawn("codex", args, {
        cwd: input.rootPath,
        shell: false,
        windowsHide: true,
        env: input.env ? { ...process.env, ...input.env } : undefined
      });
    } catch (error) {
      yield {
        type: "error",
        message: error instanceof Error ? error.message : "Failed to start Codex"
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

    // For new sessions, pipe prompt via stdin
    if (!input.resume.enabled) {
      child.stdin.write(buildPrompt(input));
    }
    child.stdin.end();

    yield { type: "status", status: "running" };

    const exitCode = await new Promise<number | null>((resolve) => {
      child.on("close", resolve);
      child.on("error", () => resolve(1));
    });

    // Parse JSONL output to extract thread_id and result text
    let resultText = "";
    let threadId: string | undefined;

    for (const line of stdout.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed) continue;

      try {
        const event = JSON.parse(trimmed);

        if (event.type === "thread.started" && event.thread_id) {
          threadId = event.thread_id;
        }

        if (event.type === "item.completed" && event.item) {
          if (event.item.type === "agent_message" && event.item.text) {
            resultText += event.item.text;
          }
        }
      } catch {
        // Non-JSON line, accumulate as plain text
        if (!threadId) {
          resultText += trimmed + "\n";
        }
      }
    }

    // Emit session ID if captured
    if (threadId) {
      yield {
        type: "provider_session",
        providerSessionId: threadId
      };
    }

    // Check for resume failures
    if (input.resume.enabled && exitCode !== 0) {
      const combined = stdout + stderr;
      const isResumeError = RESUME_ERROR_PATTERNS.some((p) => p.test(combined));

      if (isResumeError) {
        throw new ResumeFailedError(
          `Codex resume failed: ${stderr.trim() || resultText}`
        );
      }
    }

    if (resultText.trim()) {
      yield { type: "text_delta", content: resultText.trim() };
    }

    if (exitCode !== 0) {
      yield {
        type: "error",
        message: stderr.trim() || `Codex exited with code ${exitCode}`
      };
    }

    yield {
      type: "status",
      status: exitCode === 0 ? "completed" : "failed"
    };
  }
}
