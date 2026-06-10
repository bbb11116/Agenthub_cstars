import type { Message } from "../../../../shared/domain";
import { TextMessage } from "./TextMessage";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function getTextContent(content: unknown): string {
  return isRecord(content) && typeof content.text === "string" ? content.text : "";
}

function openInspector(tab: "Diff" | "Preview" | "Runtime"): void {
  window.dispatchEvent(
    new CustomEvent("agenthub:open-inspector", {
      detail: { tab }
    })
  );
}

function collectArtifactIds(metadata: Message["metadata"]): string[] {
  const ids = new Set<string>();

  if (Array.isArray(metadata?.artifactIds)) {
    for (const id of metadata.artifactIds) {
      if (typeof id === "string" && id.trim()) {
        ids.add(id);
      }
    }
  }

  if (Array.isArray(metadata?.outputs)) {
    for (const output of metadata.outputs) {
      if (
        isRecord(output) &&
        typeof output.artifactId === "string" &&
        output.artifactId.trim()
      ) {
        ids.add(output.artifactId);
      }
    }
  }

  return [...ids];
}

export function AgentAssignmentMessage({ message }: { message: Message }) {
  const fallbackText = getTextContent(message.content);
  const metadata = message.metadata;
  const status =
    metadata && typeof metadata.status === "string"
      ? metadata.status
      : isRecord(metadata?.subAgentResult) && typeof metadata.subAgentResult.status === "string"
        ? metadata.subAgentResult.status
      : "completed";
  const summary =
    metadata && typeof metadata.summary === "string"
      ? metadata.summary
      : isRecord(metadata?.subAgentResult) && typeof metadata.subAgentResult.summary === "string"
        ? metadata.subAgentResult.summary
      : fallbackText;

  if (!summary) {
    return <TextMessage content={{ text: fallbackText }} />;
  }

  const agentName =
    message.metadata && typeof message.metadata.agentName === "string"
      ? message.metadata.agentName
      : typeof metadata?.agentId === "string"
        ? metadata.agentId
        : "Agent";

  const diffProposalId =
    typeof metadata?.diffProposalId === "string" ? metadata.diffProposalId : null;
  const artifactIds = collectArtifactIds(metadata);
  const primaryArtifactId = artifactIds[0];

  return (
    <article className="structured-message-card agent-assignment-message">
      <header className="structured-message-header">
        <div>
          <span>{agentName}</span>
          <small>子 Agent 执行结果</small>
        </div>
        <strong>{status}</strong>
      </header>
      <div className="structured-message-body">
        <p>{summary}</p>
        <div className="structured-message-actions">
          <button type="button" onClick={() => openInspector("Runtime")}>查看详情</button>
          {diffProposalId ? (
            <button
              type="button"
              onClick={() => {
                window.dispatchEvent(
                  new CustomEvent("agenthub:open-diff", {
                    detail: {
                      workspaceId: message.workspaceId,
                      diffProposalId
                    }
                  })
                );
                openInspector("Diff");
              }}
            >
              查看 Diff
            </button>
          ) : null}
          {primaryArtifactId ? (
            <button
              type="button"
              onClick={() => {
                window.dispatchEvent(
                  new CustomEvent("agenthub:open-artifact", {
                    detail: {
                      workspaceId: message.workspaceId,
                      artifactId: primaryArtifactId
                    }
                  })
                );
                openInspector("Preview");
              }}
            >
              查看产物
            </button>
          ) : null}
          <button type="button" onClick={() => openInspector("Runtime")}>查看日志</button>
        </div>
      </div>
    </article>
  );
}
