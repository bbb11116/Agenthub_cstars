import type { Agent } from "../../../shared/domain";

export type AgentPickerContact = Pick<
  Agent,
  "id" | "name" | "description" | "runtimeProvider" | "role" | "type" | "status"
>;

export type AgentPickerGroup = {
  key: string;
  agents: AgentPickerContact[];
};

const collator = new Intl.Collator("zh-Hans-CN", {
  numeric: true,
  sensitivity: "base"
});

function normalizeSearchText(value: string | undefined): string {
  return value?.trim().toLocaleLowerCase("zh-Hans-CN") ?? "";
}

export function isVisibleAgentPickerContact(agent: AgentPickerContact): boolean {
  return (
    agent.role === "sub" &&
    agent.type === "specialist" &&
    (agent.status === "available" || agent.status === "error")
  );
}

export function getAgentGroupKey(name: string): string {
  const first = name.trim()[0]?.toUpperCase();
  if (!first || first < "A" || first > "Z") {
    return "#";
  }
  return first;
}

export function sortAgentPickerContacts(
  agents: AgentPickerContact[]
): AgentPickerContact[] {
  return agents
    .filter(isVisibleAgentPickerContact)
    .sort((left, right) => collator.compare(left.name, right.name));
}

export function groupAgentPickerContacts(
  agents: AgentPickerContact[]
): AgentPickerGroup[] {
  const groups = new Map<string, AgentPickerContact[]>();
  sortAgentPickerContacts(agents).forEach((agent) => {
    const key = getAgentGroupKey(agent.name);
    groups.set(key, [...(groups.get(key) ?? []), agent]);
  });

  return [...groups.entries()]
    .sort(([left], [right]) => {
      if (left === "#") return 1;
      if (right === "#") return -1;
      return left.localeCompare(right);
    })
    .map(([key, groupedAgents]) => ({ key, agents: groupedAgents }));
}

export function getAgentPickerSearchScore(
  agent: AgentPickerContact,
  query: string
): number {
  const normalizedQuery = normalizeSearchText(query);
  if (!normalizedQuery) {
    return 0;
  }

  const name = normalizeSearchText(agent.name);
  const description = normalizeSearchText(agent.description);
  const provider = normalizeSearchText(agent.runtimeProvider);

  return Math.max(
    name === normalizedQuery ? 100 : 0,
    name.startsWith(normalizedQuery) ? 80 : 0,
    name.includes(normalizedQuery) ? 60 : 0,
    description.includes(normalizedQuery) ? 30 : 0,
    provider.includes(normalizedQuery) ? 20 : 0
  );
}

export function searchAgentPickerContacts(
  agents: AgentPickerContact[],
  query: string
): AgentPickerContact[] {
  const normalizedQuery = query.trim();
  if (!normalizedQuery) {
    return sortAgentPickerContacts(agents);
  }

  return agents
    .filter(isVisibleAgentPickerContact)
    .map((agent) => ({
      agent,
      score: getAgentPickerSearchScore(agent, normalizedQuery)
    }))
    .filter(({ score }) => score > 0)
    .sort((left, right) => {
      if (left.score !== right.score) {
        return right.score - left.score;
      }
      return collator.compare(left.agent.name, right.agent.name);
    })
    .map(({ agent }) => agent);
}
