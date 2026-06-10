import type { AgentStatus } from "../../../shared/domain";

type AgentStatusBadgeProps = {
  status: AgentStatus;
  label?: string;
  className?: string;
};

const STATUS_LABELS: Record<AgentStatus, string> = {
  draft: "Draft",
  available: "Available",
  running: "Running",
  error: "Error",
  unavailable: "Unavailable",
  disabled: "Disabled",
  deleted: "Deleted"
};

export function AgentStatusBadge({
  className,
  label,
  status
}: AgentStatusBadgeProps) {
  const statusLabel = STATUS_LABELS[status];
  const classNames = [
    "agent-status-badge",
    `agent-status-badge-${status}`,
    className
  ]
    .filter(Boolean)
    .join(" ");

  return (
    <span className={classNames} role="status" title={statusLabel}>
      <span className="agent-status-dot" aria-hidden="true" />
      <span className="agent-status-label">{label ?? statusLabel}</span>
    </span>
  );
}
