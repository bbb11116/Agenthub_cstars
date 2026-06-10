import { useEffect, useState } from "react";
import type {
  ApplyDiffResult,
  DiffCardContent,
  DiffProposal
} from "../../../../shared/diff";
import { DiffViewer } from "../../diff/DiffViewer";

type DiffCardStatus = "loading" | "ready" | "error";
type DiffActionStatus = "idle" | "applying" | "rejecting";

type DiffCardMessageProps = {
  content: DiffCardContent;
};

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "加载 Diff 提案失败。";
}

function formatStatus(status: DiffProposal["status"]): string {
  const labels: Record<DiffProposal["status"], string> = {
    pending: "待处理",
    applied: "已应用",
    rejected: "已拒绝",
    conflicted: "有冲突",
    failed: "失败"
  };
  return labels[status] ?? status;
}

function notifyDiffChanged(proposal: DiffProposal, result?: ApplyDiffResult): void {
  window.dispatchEvent(
    new CustomEvent("agenthub:diff-changed", {
      detail: {
        workspaceId: proposal.workspaceId,
        diffProposalId: proposal.id,
        status: proposal.status
      }
    })
  );

  if (proposal.status !== "applied") {
    return;
  }

  window.dispatchEvent(
    new CustomEvent("agenthub:files-changed", {
      detail: {
        workspaceId: proposal.workspaceId,
        filePath: proposal.filePath
      }
    })
  );
  window.dispatchEvent(
    new CustomEvent("agenthub:git-changed", {
      detail: {
        workspaceId: proposal.workspaceId,
        gitStatus: result?.gitStatus
      }
    })
  );
  window.dispatchEvent(
    new CustomEvent("agenthub:messages-changed", {
      detail: {
        conversationId: proposal.conversationId
      }
    })
  );
}

export function DiffCardMessage({ content }: DiffCardMessageProps) {
  const [status, setStatus] = useState<DiffCardStatus>("loading");
  const [proposal, setProposal] = useState<DiffProposal | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [actionNotice, setActionNotice] = useState<string | null>(null);
  const [actionStatus, setActionStatus] = useState<DiffActionStatus>("idle");

  useEffect(() => {
    let cancelled = false;

    async function loadProposal(): Promise<void> {
      if (!window.agenthub?.diff) {
        setStatus("error");
        setError("Diff API 不可用。");
        return;
      }

      setStatus("loading");
      setError(null);

      try {
        const loadedProposal = await window.agenthub.diff.get(content.diffProposalId);

        if (cancelled) {
          return;
        }

        setProposal(loadedProposal);
        setStatus("ready");
        setActionNotice(null);
      } catch (loadError) {
        if (cancelled) {
          return;
        }

        setProposal(null);
        setError(getErrorMessage(loadError));
        setStatus("error");
      }
    }

    void loadProposal();

    return () => {
      cancelled = true;
    };
  }, [content.diffProposalId]);

  async function handleApply(): Promise<void> {
    if (!proposal || !window.agenthub?.diff) {
      setActionNotice("Diff API 不可用。");
      return;
    }

    setActionStatus("applying");
    setActionNotice(null);

    try {
      const result = await window.agenthub.diff.apply({
        workspaceId: proposal.workspaceId,
        diffProposalId: proposal.id
      });

      if (result.diffProposal) {
        setProposal(result.diffProposal);
        notifyDiffChanged(result.diffProposal, result);
      }

      if (result.status === "applied") {
        setActionNotice(result.error ?? "Diff 已应用。");
        return;
      }

      if (result.status === "conflicted") {
        setActionNotice(result.error ?? "文件已被修改，请重新生成 Diff。");
        return;
      }

      setActionNotice(result.error ?? "应用 Diff 失败。");
    } catch (applyError) {
      setActionNotice(getErrorMessage(applyError));
    } finally {
      setActionStatus("idle");
    }
  }

  async function handleReject(): Promise<void> {
    if (!proposal || !window.agenthub?.diff) {
      setActionNotice("Diff API 不可用。");
      return;
    }

    setActionStatus("rejecting");
    setActionNotice(null);

    try {
      const rejectedProposal = await window.agenthub.diff.reject({
        workspaceId: proposal.workspaceId,
        diffProposalId: proposal.id
      });

      setProposal(rejectedProposal);
      notifyDiffChanged(rejectedProposal);
      setActionNotice("Diff 已拒绝。");
    } catch (rejectError) {
      setActionNotice(getErrorMessage(rejectError));
    } finally {
      setActionStatus("idle");
    }
  }

  if (status === "loading") {
    return (
      <div className="diff-card" role="status">
        <div className="diff-card-header">
          <div>
            <span>变更提案</span>
            <small>{content.filePath}</small>
          </div>
          <strong>加载中</strong>
        </div>
        <div className="diff-card-state">
          <span className="placeholder-muted">正在加载 Diff 提案...</span>
        </div>
      </div>
    );
  }

  if (status === "error" || !proposal) {
    return (
      <div className="diff-card" role="alert">
        <div className="diff-card-header">
          <div>
            <span>变更提案</span>
            <small>{content.filePath}</small>
          </div>
          <strong>错误</strong>
        </div>
        <div className="diff-card-state diff-card-error">
          <span>{error ?? "Diff 提案不可用。"}</span>
        </div>
      </div>
    );
  }

  const isPending = proposal.status === "pending";
  const isBusy = actionStatus !== "idle";

  return (
    <article className="diff-card">
      <header className="diff-card-header">
        <div>
          <span>变更提案</span>
          <small>文件: {proposal.filePath}</small>
          <small>状态: {formatStatus(proposal.status)}</small>
        </div>
        {content.summary ? <strong>{content.summary}</strong> : null}
      </header>

      <DiffViewer
        diffContent={proposal.diffContent}
        filePath={proposal.filePath}
        label={`${proposal.filePath} 的 Diff 提案`}
      />

      <div className="diff-card-actions">
        <button
          disabled={!isPending || isBusy}
          type="button"
          onClick={() => void handleApply()}
        >
          {actionStatus === "applying" ? "应用中" : "应用 Diff"}
        </button>
        <button
          disabled={!isPending || isBusy}
          type="button"
          onClick={() => void handleReject()}
        >
          {actionStatus === "rejecting" ? "拒绝中" : "拒绝"}
        </button>
        {proposal.status === "conflicted" ? (
          <button
            type="button"
            onClick={() => setActionNotice("请基于最新文件重新生成 Diff。")}
          >
            重新生成
          </button>
        ) : null}
      </div>

      {actionNotice ? <p className="diff-card-notice">{actionNotice}</p> : null}
    </article>
  );
}
