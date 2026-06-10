import type { AgentStatusCardContent } from "../../../../shared/domain";
import { AgentStatusBadge } from "../../agents/AgentStatusBadge";

type AgentStatusMessageProps = {
  content: AgentStatusCardContent;
};

export function AgentStatusMessage({ content }: AgentStatusMessageProps) {
  const role = content.status === "error" ? "alert" : "status";

  return (
    <article
      className={`agent-status-card agent-status-card-${content.status}`}
      role={role}
    >
      <AgentStatusBadge status={content.status} />
      <div>
        <span>{content.title}</span>
        {content.detail ? <p>{content.detail}</p> : null}
      </div>
    </article>
  );
}
