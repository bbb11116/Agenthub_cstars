import type { RuntimeProvider } from "../../../shared/runtime";
import type { AgentAdapter } from "../../../shared/agentAdapter";
import type { AgentProviderAdapter } from "../../../shared/agentRunEvent";
import { ClaudeCodeAdapter } from "./claudeCodeAdapter";
import { CodexAdapter } from "./codexAdapter";
import { OpenCodeAdapter } from "./openCodeAdapter";
import { BuiltinAgentAdapter } from "./builtinAgentAdapter";
import { UnifiedAgentProviderAdapter } from "./unifiedAgentProviderAdapter";

const adapters: Record<RuntimeProvider, AgentAdapter | null> = {
  claude_code: new ClaudeCodeAdapter(),
  codex_local: new CodexAdapter(),
  opencode: new OpenCodeAdapter(),
  mock: null,
  builtin_openai: new BuiltinAgentAdapter(),
  builtin_anthropic: new BuiltinAgentAdapter()
};

export function getAdapter(provider: RuntimeProvider): AgentAdapter | null {
  return adapters[provider] ?? null;
}

/**
 * Get the unified provider adapter for a given runtime provider. The unified
 * adapter wraps the underlying provider-specific adapter and emits the
 * AgentRunEvent stream consumed by the streaming run service.
 */
export function getUnifiedProviderAdapter(
  provider: RuntimeProvider
): AgentProviderAdapter | null {
  const inner = adapters[provider];
  if (!inner) {
    return null;
  }
  return new UnifiedAgentProviderAdapter(inner);
}
