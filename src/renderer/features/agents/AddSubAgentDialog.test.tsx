import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { AddSubAgentDialog } from "./AddSubAgentDialog";

describe("AddSubAgentDialog", () => {
  it("renders the manual form and disables creation while required fields are blank", () => {
    const markup = renderToStaticMarkup(
      <AddSubAgentDialog
        open
        onClose={() => undefined}
        onCreate={async () => undefined}
      />
    );

    expect(markup).toContain('role="dialog"');
    expect(markup).toContain("添加子 Agent");
    expect(markup).toContain('<option value="builtin_openai" selected="">AgentHub 内置</option>');
    expect(markup).toContain('<option value="codex_local">本地 Codex</option>');
    expect(markup).toContain('<option value="claude_code">Claude Code</option>');
    expect(markup).toContain('<option value="opencode">OpenCode</option>');
    expect(markup).toContain("Agent 描述（可选）");
    expect(markup).toContain('<button disabled="" type="submit">创建子 Agent</button>');
  });
});
