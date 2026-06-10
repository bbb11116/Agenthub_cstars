import { describe, expect, it } from "vitest";
import {
  getAgentGroupKey,
  groupAgentPickerContacts,
  searchAgentPickerContacts,
  sortAgentPickerContacts,
  type AgentPickerContact
} from "./agentPickerUtils";

function createContact(
  id: string,
  name: string,
  patch: Partial<AgentPickerContact> = {}
): AgentPickerContact {
  return {
    id,
    name,
    description: "",
    runtimeProvider: "codex_local",
    role: "sub",
    type: "specialist",
    status: "available",
    ...patch
  };
}

describe("agentPickerUtils", () => {
  it("shows only available specialist sub Agents and groups non-English names under #", () => {
    const groups = groupAgentPickerContacts([
      createContact("beta", "Beta"),
      createContact("chinese", "中文 Agent"),
      createContact("alpha", "Alpha"),
      createContact("main", "Main Agent", { role: "main", type: "orchestrator" }),
      createContact("deleted", "Deleted Agent", { status: "deleted" }),
      createContact("disabled", "Disabled Agent", { status: "disabled" })
    ]);

    expect(groups).toEqual([
      { key: "A", agents: [expect.objectContaining({ id: "alpha" })] },
      { key: "B", agents: [expect.objectContaining({ id: "beta" })] },
      { key: "#", agents: [expect.objectContaining({ id: "chinese" })] }
    ]);
    expect(getAgentGroupKey("123 Agent")).toBe("#");
    expect(getAgentGroupKey(" 中文")).toBe("#");
  });

  it("sorts by name when there is no search query", () => {
    expect(
      sortAgentPickerContacts([
        createContact("zeta", "Zeta"),
        createContact("alpha", "Alpha 10"),
        createContact("alpha-2", "Alpha 2")
      ]).map((agent) => agent.id)
    ).toEqual(["alpha-2", "alpha", "zeta"]);
  });

  it("orders search results by relevance across name, description, and provider", () => {
    const agents = [
      createContact("provider", "Worker", { runtimeProvider: "codex_local" }),
      createContact("description", "Reviewer", { description: "Own Codex migration" }),
      createContact("contains", "My Codex Helper"),
      createContact("prefix", "Codex Helper"),
      createContact("exact", "Codex")
    ];

    expect(searchAgentPickerContacts(agents, "codex").map((agent) => agent.id)).toEqual([
      "exact",
      "prefix",
      "contains",
      "description",
      "provider"
    ]);
  });
});
