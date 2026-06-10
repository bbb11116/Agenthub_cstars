import { useEffect, useMemo, useState } from "react";
import type { ApplyDiffResult, DiffProposal } from "../../../shared/diff";
import { useWorkspaceStore } from "../../state/workspaceStore";
import { DiffViewer } from "./DiffViewer";

type DiffTabState = {
  proposals: DiffProposal[];
  selectedProposalId: string | null;
  loading: boolean;
  error: string | null;
  actionLoadingId: string | null;
  notice: string | null;
};

const initialDiffTabState: DiffTabState = {
  proposals: [],
  selectedProposalId: null,
  loading: false,
  error: null,
  actionLoadingId: null,
  notice: null
};

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "Failed to load diff proposals.";
}

function formatStatus(status: DiffProposal["status"]): string {
  return status.charAt(0).toUpperCase() + status.slice(1);
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

export function DiffTab() {
  const { activeWorkspace } = useWorkspaceStore();
  const [diffState, setDiffState] = useState<DiffTabState>(initialDiffTabState);

  useEffect(() => {
    let cancelled = false;

    async function loadProposals(workspaceId: string): Promise<void> {
      if (!window.agenthub?.diff) {
        setDiffState({
          ...initialDiffTabState,
          error: "Diff API unavailable."
        });
        return;
      }

      setDiffState({
        ...initialDiffTabState,
        loading: true
      });

      try {
        const proposals = await window.agenthub.diff.listByWorkspace(workspaceId);

        if (cancelled) {
          return;
        }

        setDiffState({
          proposals,
          selectedProposalId: proposals[0]?.id ?? null,
          loading: false,
          error: null,
          actionLoadingId: null,
          notice: null
        });
      } catch (error) {
        if (cancelled) {
          return;
        }

        setDiffState({
          ...initialDiffTabState,
          error: getErrorMessage(error)
        });
      }
    }

    if (!activeWorkspace) {
      setDiffState(initialDiffTabState);
      return;
    }

    void loadProposals(activeWorkspace.id);

    return () => {
      cancelled = true;
    };
  }, [activeWorkspace?.id]);

  const selectedProposal = useMemo(
    () =>
      diffState.proposals.find(
        (proposal) => proposal.id === diffState.selectedProposalId
      ) ??
      diffState.proposals[0] ??
      null,
    [diffState.proposals, diffState.selectedProposalId]
  );

  function updateProposal(nextProposal: DiffProposal): void {
    setDiffState((currentState) => ({
      ...currentState,
      proposals: currentState.proposals.map((proposal) =>
        proposal.id === nextProposal.id ? nextProposal : proposal
      ),
      selectedProposalId: nextProposal.id
    }));
  }

  async function handleApply(proposal: DiffProposal): Promise<void> {
    if (!window.agenthub?.diff) {
      setDiffState((currentState) => ({
        ...currentState,
        notice: "Diff API unavailable."
      }));
      return;
    }

    setDiffState((currentState) => ({
      ...currentState,
      actionLoadingId: proposal.id,
      notice: null,
      error: null
    }));

    try {
      const result = await window.agenthub.diff.apply({
        workspaceId: proposal.workspaceId,
        diffProposalId: proposal.id
      });

      if (result.diffProposal) {
        updateProposal(result.diffProposal);
        notifyDiffChanged(result.diffProposal, result);
      }

      setDiffState((currentState) => ({
        ...currentState,
        actionLoadingId: null,
        notice:
          result.status === "applied"
            ? result.error ?? "Diff applied successfully."
            : result.error ?? "Failed to apply diff."
      }));
    } catch (error) {
      setDiffState((currentState) => ({
        ...currentState,
        actionLoadingId: null,
        notice: getErrorMessage(error)
      }));
    }
  }

  async function handleReject(proposal: DiffProposal): Promise<void> {
    if (!window.agenthub?.diff) {
      setDiffState((currentState) => ({
        ...currentState,
        notice: "Diff API unavailable."
      }));
      return;
    }

    setDiffState((currentState) => ({
      ...currentState,
      actionLoadingId: proposal.id,
      notice: null,
      error: null
    }));

    try {
      const rejectedProposal = await window.agenthub.diff.reject({
        workspaceId: proposal.workspaceId,
        diffProposalId: proposal.id
      });

      updateProposal(rejectedProposal);
      notifyDiffChanged(rejectedProposal);
      setDiffState((currentState) => ({
        ...currentState,
        actionLoadingId: null,
        notice: "Diff rejected."
      }));
    } catch (error) {
      setDiffState((currentState) => ({
        ...currentState,
        actionLoadingId: null,
        notice: getErrorMessage(error)
      }));
    }
  }

  useEffect(() => {
    if (!activeWorkspace || !window.agenthub?.diff) {
      return;
    }

    const workspaceId = activeWorkspace.id;

    function handleDiffChanged(event: Event): void {
      const detail = (
        event as CustomEvent<{ workspaceId?: string; diffProposalId?: string }>
      ).detail;

      if (detail?.workspaceId !== workspaceId || !detail.diffProposalId) {
        return;
      }

      const diffApi = window.agenthub?.diff;

      if (!diffApi) {
        return;
      }

      void diffApi
        .get(detail.diffProposalId)
        .then((changedProposal: DiffProposal) => {
          setDiffState((currentState) => {
            const hasProposal = currentState.proposals.some(
              (proposal) => proposal.id === changedProposal.id
            );

            return {
              ...currentState,
              proposals: hasProposal
                ? currentState.proposals.map((proposal) =>
                    proposal.id === changedProposal.id ? changedProposal : proposal
                  )
                : [changedProposal, ...currentState.proposals],
              selectedProposalId:
                currentState.selectedProposalId ?? changedProposal.id
            };
          });
        })
        .catch(() => {
          setDiffState((currentState) => ({
            ...currentState,
            notice: "Failed to refresh diff status."
          }));
        });
    }

    function handleOpenDiff(event: Event): void {
      const detail = (
        event as CustomEvent<{ workspaceId?: string; diffProposalId?: string }>
      ).detail;

      if (detail?.workspaceId !== workspaceId || !detail.diffProposalId) {
        return;
      }

      const diffApi = window.agenthub?.diff;

      if (!diffApi) {
        return;
      }

      void diffApi
        .get(detail.diffProposalId)
        .then((openedProposal: DiffProposal) => {
          setDiffState((currentState) => {
            const hasProposal = currentState.proposals.some(
              (proposal) => proposal.id === openedProposal.id
            );

            return {
              ...currentState,
              proposals: hasProposal
                ? currentState.proposals.map((proposal) =>
                    proposal.id === openedProposal.id ? openedProposal : proposal
                  )
                : [openedProposal, ...currentState.proposals],
              selectedProposalId: openedProposal.id
            };
          });
        })
        .catch(() => {
          setDiffState((currentState) => ({
            ...currentState,
            notice: "Failed to open diff proposal."
          }));
        });
    }

    window.addEventListener("agenthub:diff-changed", handleDiffChanged);
    window.addEventListener("agenthub:open-diff", handleOpenDiff);

    return () => {
      window.removeEventListener("agenthub:diff-changed", handleDiffChanged);
      window.removeEventListener("agenthub:open-diff", handleOpenDiff);
    };
  }, [activeWorkspace?.id]);

  if (!activeWorkspace) {
    return (
      <div className="placeholder-block inspector-content">
        <span className="placeholder-title">No Workspace</span>
        <span className="placeholder-muted">Open a workspace to review proposed diffs.</span>
      </div>
    );
  }

  if (diffState.loading) {
    return (
      <div className="placeholder-block inspector-content" role="status">
        <span className="placeholder-title">Loading</span>
        <span className="placeholder-muted">Loading diffs...</span>
      </div>
    );
  }

  if (diffState.error) {
    return (
      <div className="workspace-error inspector-content" role="alert">
        <span>{diffState.error}</span>
      </div>
    );
  }

  if (!selectedProposal) {
    return (
      <div className="placeholder-block inspector-content">
        <span className="placeholder-title">No Diff Proposal</span>
        <span className="placeholder-muted">Agent proposals will appear here.</span>
      </div>
    );
  }

  const isPending = selectedProposal.status === "pending";
  const isApplying = diffState.actionLoadingId === selectedProposal.id;

  return (
    <div className="diff-tab inspector-content">
      <div className="diff-proposal-list" aria-label="Diff proposals">
        {diffState.proposals.map((proposal) => (
          <button
            key={proposal.id}
            className={proposal.id === selectedProposal.id ? "active" : ""}
            type="button"
            onClick={() =>
              setDiffState((currentState) => ({
                ...currentState,
                selectedProposalId: proposal.id
              }))
            }
          >
            <span>{proposal.filePath}</span>
            <small>{formatStatus(proposal.status)}</small>
          </button>
        ))}
      </div>

      <DiffViewer
        diffContent={selectedProposal.diffContent}
        filePath={selectedProposal.filePath}
        label={`Diff for ${selectedProposal.filePath}`}
      />

      <div className="diff-tab-actions">
        <button
          disabled={!isPending || isApplying}
          type="button"
          onClick={() => void handleApply(selectedProposal)}
        >
          {isApplying ? "Applying" : "Apply Diff"}
        </button>
        <button
          disabled={!isPending || isApplying}
          type="button"
          onClick={() => void handleReject(selectedProposal)}
        >
          Reject
        </button>
        {selectedProposal.status === "conflicted" ? (
          <button
            type="button"
            onClick={() =>
              setDiffState((currentState) => ({
                ...currentState,
                notice: "请基于最新文件重新生成 Diff。"
              }))
            }
          >
            Regenerate
          </button>
        ) : null}
      </div>

      {diffState.notice ? <p className="diff-tab-notice">{diffState.notice}</p> : null}
    </div>
  );
}
