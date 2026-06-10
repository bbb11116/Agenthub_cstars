import type { Artifact } from "./artifact";
import type { DiffProposal } from "./diff";

export type RuntimeProvider =
  | "codex_local"
  | "claude_code"
  | "opencode"
  | "mock"
  | "builtin_openai"
  | "builtin_anthropic";

export type RuntimeStatus = {
  provider: RuntimeProvider;
  available: boolean;
  version?: string;
  error?: string;
  checkedAt: string;
};

export type LocalAgentRunMode = "interactive" | "non_interactive";

export type LocalAgentRunEvent =
  | { type: "started"; provider: RuntimeProvider; cwd: string }
  | { type: "stdout"; text: string }
  | { type: "stderr"; text: string }
  | { type: "artifact"; artifact: Artifact }
  | { type: "diff_proposal"; diffProposal: DiffProposal }
  | { type: "exited"; code: number | null }
  | { type: "error"; error: string };

export const RUNTIME_PROVIDERS: RuntimeProvider[] = [
  "codex_local",
  "claude_code",
  "opencode",
  "mock",
  "builtin_openai",
  "builtin_anthropic"
];

export const RUNTIME_PROVIDER_LABELS: Record<RuntimeProvider, string> = {
  codex_local: "Codex Local",
  claude_code: "Claude Code",
  opencode: "OpenCode",
  mock: "Mock Demo",
  builtin_openai: "AgentHub Built-in",
  builtin_anthropic: "AgentHub Built-in"
};

export function isRuntimeProvider(value: unknown): value is RuntimeProvider {
  return (
    typeof value === "string" &&
    RUNTIME_PROVIDERS.includes(value as RuntimeProvider)
  );
}

export function isBuiltinProvider(provider: RuntimeProvider): boolean {
  return provider === "builtin_openai" || provider === "builtin_anthropic";
}
