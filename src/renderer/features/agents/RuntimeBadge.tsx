import { useEffect, useMemo, useState } from "react";
import type { RuntimeProvider, RuntimeStatus } from "../../../shared/domain";
import type { ModelProviderListItem } from "../../../shared/types";
import { isBuiltinProvider, RUNTIME_PROVIDER_LABELS } from "../../../shared/runtime";

type RuntimeBadgeState =
  | { status: "loading" }
  | { status: "ready"; runtimeStatus: RuntimeStatus }
  | { status: "error"; message: string };

function getRuntimeLabel(provider: RuntimeProvider): string {
  return RUNTIME_PROVIDER_LABELS[provider] ?? provider;
}

function getUnavailableMessage(runtimeStatus: RuntimeStatus): string {
  return runtimeStatus.error ? `Unavailable: ${runtimeStatus.error}` : "Unavailable";
}

function findConfiguredProviderName(
  providers: ModelProviderListItem[],
  modelProviderId?: string
): string | null {
  const provider = modelProviderId
    ? providers.find((item) => item.id === modelProviderId)
    : providers.find((item) => item.isDefaultForMainAgent) ?? providers[0];

  return provider?.name ?? null;
}

export function RuntimeBadge({
  provider,
  modelProviderId
}: {
  provider: RuntimeProvider;
  modelProviderId?: string;
}) {
  const isBuiltin = isBuiltinProvider(provider);
  const [configuredProviderName, setConfiguredProviderName] = useState<string | null>(null);
  const [badgeState, setBadgeState] = useState<RuntimeBadgeState>(
    isBuiltin
      ? {
          status: "ready",
          runtimeStatus: {
            provider,
            available: true,
            checkedAt: new Date().toISOString()
          }
        }
      : { status: "loading" }
  );

  useEffect(() => {
    if (!isBuiltin || !window.agenthub?.modelProvider) {
      setConfiguredProviderName(null);
      return;
    }

    let cancelled = false;

    void window.agenthub.modelProvider.list()
      .then((providers) => {
        if (!cancelled) {
          setConfiguredProviderName(findConfiguredProviderName(providers, modelProviderId));
        }
      })
      .catch(() => {
        if (!cancelled) {
          setConfiguredProviderName(null);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [isBuiltin, modelProviderId]);

  useEffect(() => {
    if (isBuiltin) {
      setBadgeState({
        status: "ready",
        runtimeStatus: {
          provider,
          available: true,
          checkedAt: new Date().toISOString()
        }
      });
      return;
    }

    let cancelled = false;

    async function checkRuntime(): Promise<void> {
      if (!window.agenthub?.runtime) {
        setBadgeState({
          status: "error",
          message: "Runtime API unavailable"
        });
        return;
      }

      setBadgeState({ status: "loading" });

      try {
        const runtimeStatus = await window.agenthub.runtime.check(provider);

        if (!cancelled) {
          setBadgeState({
            status: "ready",
            runtimeStatus
          });
        }
      } catch (error) {
        if (!cancelled) {
          setBadgeState({
            status: "error",
            message: error instanceof Error ? error.message : "Runtime check failed"
          });
        }
      }
    }

    void checkRuntime();

    return () => {
      cancelled = true;
    };
  }, [provider, isBuiltin]);

  const label = configuredProviderName ?? getRuntimeLabel(provider);
  const displayState = useMemo(() => {
    if (badgeState.status === "loading") {
      return {
        tone: "loading",
        text: "Checking",
        title: `${label} runtime check in progress`
      };
    }

    if (badgeState.status === "error") {
      return {
        tone: "error",
        text: "Check failed",
        title: badgeState.message
      };
    }

    if (badgeState.runtimeStatus.available) {
      return {
        tone: "available",
        text: "Available",
        title: badgeState.runtimeStatus.version
          ? `${label} ${badgeState.runtimeStatus.version}`
          : `${label} available`
      };
    }

    return {
      tone: "unavailable",
      text: "Unavailable",
      title: getUnavailableMessage(badgeState.runtimeStatus)
    };
  }, [badgeState, label]);

  return (
    <span
      className={`runtime-badge runtime-badge-${displayState.tone}`}
      role="status"
      title={displayState.title}
    >
      {label} · {displayState.text}
    </span>
  );
}
