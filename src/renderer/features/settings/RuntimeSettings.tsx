import { useEffect, useState } from "react";
import type { RuntimeProvider, RuntimeStatus } from "../../../shared/domain";
import { RUNTIME_PROVIDER_LABELS } from "../../../shared/runtime";

type RuntimeSettingsState =
  | { status: "loading" }
  | { status: "empty" }
  | { status: "ready"; runtimeStatuses: RuntimeStatus[] }
  | { status: "error"; message: string };

const RUNTIME_COMMAND_LABELS: Record<RuntimeProvider, string> = {
  codex_local: "codex --version",
  claude_code: "claude --version",
  opencode: "opencode --version",
  mock: "built in",
  builtin_openai: "built in",
  builtin_anthropic: "built in"
};

function getRuntimeLabel(provider: RuntimeProvider): string {
  return RUNTIME_PROVIDER_LABELS[provider] ?? provider;
}

function getRuntimeStateLabel(runtimeStatus: RuntimeStatus): string {
  return runtimeStatus.available ? "Available" : "Unavailable";
}

export function RuntimeSettings() {
  const [settingsState, setSettingsState] = useState<RuntimeSettingsState>({
    status: "loading"
  });

  async function loadRuntimeStatuses(): Promise<void> {
    if (!window.agenthub?.runtime) {
      setSettingsState({
        status: "error",
        message: "Runtime API unavailable"
      });
      return;
    }

    setSettingsState({ status: "loading" });

    try {
      const runtimeStatuses = await window.agenthub.runtime.checkAll();

      setSettingsState(
        runtimeStatuses.length > 0
          ? {
              status: "ready",
              runtimeStatuses
            }
          : {
              status: "empty"
            }
      );
    } catch (error) {
      setSettingsState({
        status: "error",
        message: error instanceof Error ? error.message : "Runtime check failed"
      });
    }
  }

  useEffect(() => {
    void loadRuntimeStatuses();
  }, []);

  if (settingsState.status === "loading") {
    return (
      <div className="placeholder-block inspector-content">
        <span className="placeholder-title">Checking</span>
        <span className="placeholder-muted">Checking local runtimes...</span>
      </div>
    );
  }

  if (settingsState.status === "empty") {
    return (
      <div className="placeholder-block inspector-content">
        <span className="placeholder-title">No Runtimes</span>
        <span className="placeholder-muted">No runtime providers configured.</span>
      </div>
    );
  }

  if (settingsState.status === "error") {
    return (
      <div className="workspace-error inspector-content" role="alert">
        <span>{settingsState.message}</span>
        <button type="button" onClick={() => void loadRuntimeStatuses()}>
          Retry
        </button>
      </div>
    );
  }

  return (
    <div className="runtime-settings inspector-content">
      {settingsState.runtimeStatuses.map((runtimeStatus) => (
        <div className="runtime-setting-row" key={runtimeStatus.provider}>
          <div>
            <span>{getRuntimeLabel(runtimeStatus.provider)}</span>
            <code>{RUNTIME_COMMAND_LABELS[runtimeStatus.provider]}</code>
          </div>
          <strong
            className={
              runtimeStatus.available
                ? "runtime-setting-available"
                : "runtime-setting-unavailable"
            }
          >
            {getRuntimeStateLabel(runtimeStatus)}
          </strong>
          <small>
            {runtimeStatus.version ??
              runtimeStatus.error ??
              `Checked ${new Date(runtimeStatus.checkedAt).toLocaleTimeString()}`}
          </small>
        </div>
      ))}
      <button
        className="runtime-settings-refresh"
        type="button"
        onClick={() => void loadRuntimeStatuses()}
      >
        Refresh
      </button>
    </div>
  );
}
