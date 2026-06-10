import { useMemo } from "react";
import {
  groupAgentPickerContacts,
  searchAgentPickerContacts,
  type AgentPickerContact
} from "./agentPickerUtils";

type AgentPickerListProps = {
  agents: AgentPickerContact[];
  query: string;
  selectedAgentIds: string[];
  disabledAgentIds?: string[];
  disabledReasonLabel?: string;
  onToggle: (agentId: string) => void;
};

function AgentRow({
  agent,
  disabled,
  disabledReasonLabel,
  selected,
  onToggle
}: {
  agent: AgentPickerContact;
  disabled: boolean;
  disabledReasonLabel: string;
  selected: boolean;
  onToggle: (agentId: string) => void;
}) {
  return (
    <button
      aria-pressed={selected}
      className={[
        "agent-picker-row",
        selected ? "selected" : "",
        disabled ? "disabled" : ""
      ].filter(Boolean).join(" ")}
      disabled={disabled}
      type="button"
      onClick={() => onToggle(agent.id)}
    >
      <span className="agent-picker-row-copy">
        <strong>{agent.name}</strong>
        {agent.description ? <small>{agent.description}</small> : null}
      </span>
      <span className="agent-picker-row-meta">
        {agent.runtimeProvider ? <small>{agent.runtimeProvider}</small> : null}
        <b>{disabled ? disabledReasonLabel : selected ? "已选择" : "选择"}</b>
      </span>
    </button>
  );
}

export function AgentPickerList({
  agents,
  query,
  selectedAgentIds,
  disabledAgentIds = [],
  disabledReasonLabel = "已添加",
  onToggle
}: AgentPickerListProps) {
  const disabledIds = useMemo(() => new Set(disabledAgentIds), [disabledAgentIds]);
  const selectedIds = useMemo(() => new Set(selectedAgentIds), [selectedAgentIds]);
  const normalizedQuery = query.trim();
  const searchResults = useMemo(
    () => searchAgentPickerContacts(agents, normalizedQuery),
    [agents, normalizedQuery]
  );
  const groupedAgents = useMemo(
    () => groupAgentPickerContacts(agents),
    [agents]
  );

  if (normalizedQuery && searchResults.length === 0) {
    return <p className="agent-picker-empty">没有找到匹配的 Agent</p>;
  }

  if (!normalizedQuery && groupedAgents.length === 0) {
    return <p className="agent-picker-empty">暂无可添加的 Agent</p>;
  }

  if (normalizedQuery) {
    return (
      <div className="agent-picker-results">
        {searchResults.map((agent) => (
          <AgentRow
            agent={agent}
            disabled={disabledIds.has(agent.id)}
            disabledReasonLabel={disabledReasonLabel}
            key={agent.id}
            selected={selectedIds.has(agent.id)}
            onToggle={onToggle}
          />
        ))}
      </div>
    );
  }

  return (
    <div className="agent-picker-groups">
      {groupedAgents.map((group) => (
        <section className="agent-picker-group" key={group.key}>
          <h3>{group.key}</h3>
          {group.agents.map((agent) => (
            <AgentRow
              agent={agent}
              disabled={disabledIds.has(agent.id)}
              disabledReasonLabel={disabledReasonLabel}
              key={agent.id}
              selected={selectedIds.has(agent.id)}
              onToggle={onToggle}
            />
          ))}
        </section>
      ))}
    </div>
  );
}
