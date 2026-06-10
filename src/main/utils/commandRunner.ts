import { spawn } from "node:child_process";

export type CommandRunOptions = {
  cwd: string;
  timeoutMs?: number;
  maxOutputBytes?: number;
};

export type CommandRunResult = {
  command: string;
  args: string[];
  cwd: string;
  stdout: string;
  stderr: string;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  timedOut: boolean;
  truncated: boolean;
};

export type CommandRunnerErrorCode =
  | "COMMAND_UNAVAILABLE"
  | "PERMISSION_DENIED"
  | "TIMEOUT"
  | "EXIT_NON_ZERO"
  | "COMMAND_FAILED";

export class CommandRunnerError extends Error {
  readonly code: CommandRunnerErrorCode;
  readonly result?: CommandRunResult;

  constructor(
    code: CommandRunnerErrorCode,
    message: string,
    options?: ErrorOptions & { result?: CommandRunResult }
  ) {
    super(message, options);
    this.name = "CommandRunnerError";
    this.code = code;
    this.result = options?.result;
  }
}

const DEFAULT_TIMEOUT_MS = 5000;
const DEFAULT_MAX_OUTPUT_BYTES = 128 * 1024;

function isPermissionDeniedText(value: string): boolean {
  return /permission denied|operation not permitted|eacces|eperm/i.test(value);
}

function isCommandNotFoundText(value: string): boolean {
  return /command not found|not recognized|enoent|not found/i.test(value);
}

function appendOutput(
  currentOutput: string,
  chunk: unknown,
  maxOutputBytes: number
): { output: string; truncated: boolean } {
  const nextOutput = `${currentOutput}${String(chunk)}`;

  if (Buffer.byteLength(nextOutput, "utf8") <= maxOutputBytes) {
    return {
      output: nextOutput,
      truncated: false
    };
  }

  return {
    output: nextOutput.slice(0, maxOutputBytes),
    truncated: true
  };
}

function normalizeSpawnError(error: NodeJS.ErrnoException): CommandRunnerErrorCode {
  if (error.code === "ENOENT") {
    return "COMMAND_UNAVAILABLE";
  }

  if (error.code === "EACCES" || error.code === "EPERM" || isPermissionDeniedText(error.message)) {
    return "PERMISSION_DENIED";
  }

  return "COMMAND_FAILED";
}

function normalizeExitError(result: CommandRunResult): CommandRunnerErrorCode {
  if (isPermissionDeniedText(result.stderr)) {
    return "PERMISSION_DENIED";
  }

  if (isCommandNotFoundText(result.stderr) || result.exitCode === 127) {
    return "COMMAND_UNAVAILABLE";
  }

  return "EXIT_NON_ZERO";
}

export function runCommand(
  command: string,
  args: string[],
  options: CommandRunOptions
): Promise<CommandRunResult> {
  return new Promise((resolve, reject) => {
    const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const maxOutputBytes = options.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES;
    let stdout = "";
    let stderr = "";
    let settled = false;
    let timedOut = false;
    let truncated = false;
    let timeout: NodeJS.Timeout | undefined;

    function createResult(
      exitCode: number | null,
      signal: NodeJS.Signals | null
    ): CommandRunResult {
      return {
        command,
        args,
        cwd: options.cwd,
        stdout,
        stderr,
        exitCode,
        signal,
        timedOut,
        truncated
      };
    }

    function settleSuccess(result: CommandRunResult): void {
      if (settled) {
        return;
      }

      settled = true;
      if (timeout) {
        clearTimeout(timeout);
      }
      resolve(result);
    }

    function settleError(error: CommandRunnerError): void {
      if (settled) {
        return;
      }

      settled = true;
      if (timeout) {
        clearTimeout(timeout);
      }
      reject(error);
    }

    const child = spawn(command, args, {
      cwd: options.cwd,
      shell: false,
      windowsHide: true
    });

    timeout = setTimeout(() => {
      timedOut = true;
      child.kill();
      const result = createResult(null, null);
      settleError(
        new CommandRunnerError("TIMEOUT", "Timeout", {
          result
        })
      );
    }, timeoutMs);

    child.stdout?.on("data", (chunk) => {
      const nextOutput = appendOutput(stdout, chunk, maxOutputBytes);
      stdout = nextOutput.output;
      truncated = truncated || nextOutput.truncated;
    });

    child.stderr?.on("data", (chunk) => {
      const nextOutput = appendOutput(stderr, chunk, maxOutputBytes);
      stderr = nextOutput.output;
      truncated = truncated || nextOutput.truncated;
    });

    child.on("error", (error: NodeJS.ErrnoException) => {
      const code = normalizeSpawnError(error);
      settleError(
        new CommandRunnerError(code, error.message || "Command failed", {
          cause: error,
          result: createResult(null, null)
        })
      );
    });

    child.on("close", (exitCode, signal) => {
      const result = createResult(exitCode, signal);

      if (timedOut) {
        return;
      }

      if (exitCode === 0) {
        settleSuccess(result);
        return;
      }

      const code = normalizeExitError(result);
      settleError(
        new CommandRunnerError(
          code,
          result.stderr.trim() || `Command exited with code ${exitCode ?? "unknown"}`,
          {
            result
          }
        )
      );
    });
  });
}
