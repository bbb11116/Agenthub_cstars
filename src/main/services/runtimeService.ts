import { spawn } from "node:child_process";
import {
  isBuiltinProvider,
  isRuntimeProvider,
  RUNTIME_PROVIDERS,
  type RuntimeProvider,
  type RuntimeStatus
} from "../../shared/runtime";

type RuntimeCommand = {
  command: string;
  args: string[];
};

type RuntimeCheckSuccess = {
  ok: true;
  stdout: string;
  stderr: string;
};

type RuntimeCheckFailure = {
  ok: false;
  error: string;
};

type RuntimeCheckResult = RuntimeCheckSuccess | RuntimeCheckFailure;

const CHECK_TIMEOUT_MS = 3000;
const MAX_CAPTURED_OUTPUT_LENGTH = 4096;

const RUNTIME_COMMANDS: Record<
  Exclude<RuntimeProvider, "mock" | "builtin_openai" | "builtin_anthropic">,
  RuntimeCommand
> = {
  codex_local: {
    command: "codex",
    args: ["--version"]
  },
  claude_code: {
    command: "claude",
    args: ["--version"]
  },
  opencode: {
    command: "opencode",
    args: ["--version"]
  }
};

function createCheckedAt(): string {
  return new Date().toISOString();
}

function appendOutput(currentOutput: string, chunk: unknown): string {
  const nextOutput = `${currentOutput}${String(chunk)}`;

  if (nextOutput.length <= MAX_CAPTURED_OUTPUT_LENGTH) {
    return nextOutput;
  }

  return nextOutput.slice(0, MAX_CAPTURED_OUTPUT_LENGTH);
}

function extractVersion(output: string): string | undefined {
  const trimmedOutput = output.trim();
  const versionMatch = trimmedOutput.match(/\b\d+\.\d+(?:\.\d+)?(?:[-+][0-9A-Za-z.-]+)?\b/);

  return versionMatch?.[0];
}

function isPermissionDeniedText(value: string): boolean {
  return /permission denied|operation not permitted|eacces/i.test(value);
}

function isCommandNotFoundText(value: string): boolean {
  return /command not found|not recognized|enoent|not found/i.test(value);
}

function normalizeSpawnError(error: NodeJS.ErrnoException): string {
  if (error.code === "ENOENT") {
    return "command not found";
  }

  if (error.code === "EACCES" || isPermissionDeniedText(error.message)) {
    return "permission denied";
  }

  return error.message || "runtime check failed";
}

function normalizeExitError(
  code: number | null,
  signal: NodeJS.Signals | null,
  stderr: string
): string {
  if (isPermissionDeniedText(stderr)) {
    return "permission denied";
  }

  if (isCommandNotFoundText(stderr) || code === 127) {
    return "command not found";
  }

  if (signal) {
    return `terminated by ${signal}`;
  }

  return stderr.trim() || `exited with code ${code ?? "unknown"}`;
}

function isCommandNotFound(result: RuntimeCheckResult): boolean {
  return !result.ok && result.error === "command not found";
}

function runVersionCommand(
  runtimeCommand: RuntimeCommand,
  options: { shell: boolean }
): Promise<RuntimeCheckResult> {
  return new Promise((resolve) => {
    let stdout = "";
    let stderr = "";
    let settled = false;
    let timeout: NodeJS.Timeout | undefined;

    function settle(result: RuntimeCheckResult): void {
      if (settled) {
        return;
      }

      settled = true;
      if (timeout) {
        clearTimeout(timeout);
      }
      resolve(result);
    }

    const child = spawn(runtimeCommand.command, runtimeCommand.args, {
      shell: options.shell,
      windowsHide: true
    });
    timeout = setTimeout(() => {
      child.kill();
      settle({
        ok: false,
        error: "timeout"
      });
    }, CHECK_TIMEOUT_MS);

    child.stdout?.on("data", (chunk) => {
      stdout = appendOutput(stdout, chunk);
    });

    child.stderr?.on("data", (chunk) => {
      stderr = appendOutput(stderr, chunk);
    });

    child.on("error", (error: NodeJS.ErrnoException) => {
      settle({
        ok: false,
        error: normalizeSpawnError(error)
      });
    });

    child.on("close", (code, signal) => {
      if (code === 0) {
        settle({
          ok: true,
          stdout,
          stderr
        });
        return;
      }

      settle({
        ok: false,
        error: normalizeExitError(code, signal, stderr)
      });
    });
  });
}

export async function checkRuntimeProvider(provider: RuntimeProvider): Promise<RuntimeStatus> {
  if (!isRuntimeProvider(provider)) {
    throw new Error("Runtime provider is invalid.");
  }

  if (provider === "mock" || isBuiltinProvider(provider)) {
    return {
      provider,
      available: true,
      checkedAt: createCheckedAt()
    };
  }

  const runtimeCommand = RUNTIME_COMMANDS[provider as keyof typeof RUNTIME_COMMANDS];
  let result = await runVersionCommand(runtimeCommand, { shell: false });

  if (process.platform === "win32" && isCommandNotFound(result)) {
    result = await runVersionCommand(runtimeCommand, { shell: true });
  }

  if (result.ok) {
    return {
      provider,
      available: true,
      version: extractVersion(`${result.stdout}\n${result.stderr}`),
      checkedAt: createCheckedAt()
    };
  }

  return {
    provider,
    available: false,
    error: result.error,
    checkedAt: createCheckedAt()
  };
}

export async function checkAllRuntimeProviders(): Promise<RuntimeStatus[]> {
  const visibleProviders = RUNTIME_PROVIDERS.filter(
    (provider) => provider !== "mock" && provider !== "builtin_anthropic"
  );

  return Promise.all(visibleProviders.map((provider) => checkRuntimeProvider(provider)));
}
