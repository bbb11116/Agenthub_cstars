import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { AgentPickerDialog } from "./AgentPickerDialog";
import type { AgentPickerContact } from "./agentPickerUtils";

function createContact(
  id: string,
  name: string,
  patch: Partial<AgentPickerContact> = {}
): AgentPickerContact {
  return {
    id,
    name,
    runtimeProvider: "codex_local",
    role: "sub",
    type: "specialist",
    status: "available",
    ...patch
  };
}

describe("AgentPickerDialog", () => {
  it("hides non-active and main Agents while disabling existing group members", () => {
    const markup = renderToStaticMarkup(
      <AgentPickerDialog
        agents={[
          createContact("available", "Available Agent"),
          createContact("existing", "Existing Agent"),
          createContact("main", "Main Agent", { role: "main", type: "orchestrator" }),
          createContact("deleted", "Deleted Agent", { status: "deleted" })
        ]}
        disabledAgentIds={["existing"]}
        open
        onCancel={() => undefined}
        onConfirm={() => undefined}
      />
    );

    expect(markup).toContain("搜索 Agent 名称、描述或 Provider");
    expect(markup).toContain("Available Agent");
    expect(markup).toContain("Existing Agent");
    expect(markup).toContain("已添加");
    expect(markup).not.toContain("Main Agent");
    expect(markup).not.toContain("Deleted Agent");
    expect(markup).toContain('<button disabled="" type="button">添加</button>');
  });
});
