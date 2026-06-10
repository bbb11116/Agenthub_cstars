import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { AgentToolPermissions } from "../../shared/domain";
import { closeDatabase, initializeDatabase, type AgentHubDatabase } from "../db";
import { createAgent } from "../db/repositories/agentRepo";
import { createConversation } from "../db/repositories/conversationRepo";
import { createWorkspace } from "../db/repositories/workspaceRepo";
import {
  applySearchReplaceEdits,
  createDiffProposalFromText,
  parseSearchReplaceBlocks
} from "./diffProposalTextService";

const SR_S = `${"<".repeat(7)} SEARCH`;
const SR_D = "=".repeat(7);
const SR_R = `${">".repeat(7)} REPLACE`;

let tempDir: string | null = null;

function createTempDbPath(): string {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "agenthub-diff-text-"));
  return path.join(tempDir, "agenthub.db");
}

function createFixture(
  db: AgentHubDatabase,
  files: Record<string, string>,
  tools?: Partial<AgentToolPermissions>
) {
  if (!tempDir) {
    throw new Error("Temp directory unavailable.");
  }

  const rootPath = path.join(tempDir, "workspace");
  for (const [rel, content] of Object.entries(files)) {
    const absolutePath = path.join(rootPath, rel);
    fs.mkdirSync(path.dirname(absolutePath), { recursive: true });
    fs.writeFileSync(absolutePath, content, "utf8");
  }

  const workspace = createWorkspace(
    {
      name: "Edit Workspace",
      rootPath,
      gitEnabled: false
    },
    db
  );
  const agent = createAgent(
    {
      workspaceId: workspace.id,
      name: "Edit Agent",
      role: "sub",
      runtimeProvider: "mock",
      systemPrompt: "Emit edit blocks.",
      capabilities: ["diff"],
      tools,
      fileScope: ["."],
      status: "available"
    },
    db
  );
  const conversation = createConversation(
    {
      workspaceId: workspace.id,
      agentId: agent.id,
      title: "Edits",
      mode: "single"
    },
    db
  );

  return { workspace, agent, conversation, rootPath };
}

afterEach(() => {
  closeDatabase();
  if (tempDir) {
    fs.rmSync(tempDir, { recursive: true, force: true });
    tempDir = null;
  }
});

describe("parseSearchReplaceBlocks", () => {
  it("returns empty when no SEARCH marker present", () => {
    const text = "Here is some\n```python\nprint('hi')\n```\nplain code.";
    expect(parseSearchReplaceBlocks(text)).toEqual([]);
  });

  it("parses one file with a single SEARCH/REPLACE pair", () => {
    const text = [
      "Some preamble.",
      "",
      "src/foo.ts",
      "```",
      SR_S,
      "old line",
      SR_D,
      "new line",
      SR_R,
      "```",
      "trailing prose"
    ].join("\n");
    const blocks = parseSearchReplaceBlocks(text);
    expect(blocks).toHaveLength(1);
    expect(blocks[0].filePath).toBe("src/foo.ts");
    expect(blocks[0].edits).toEqual([{ search: "old line", replace: "new line" }]);
  });

  it("parses multiple SEARCH/REPLACE pairs in one fence", () => {
    const text = [
      "src/foo.ts",
      "```",
      SR_S,
      "a",
      SR_D,
      "A",
      SR_R,
      "",
      SR_S,
      "b",
      SR_D,
      "B",
      SR_R,
      "```"
    ].join("\n");
    const blocks = parseSearchReplaceBlocks(text);
    expect(blocks).toHaveLength(1);
    expect(blocks[0].edits).toEqual([
      { search: "a", replace: "A" },
      { search: "b", replace: "B" }
    ]);
  });

  it("parses multiple files in one message", () => {
    const text = [
      "src/foo.ts",
      "```",
      SR_S,
      "x",
      SR_D,
      "X",
      SR_R,
      "```",
      "",
      "src/bar.ts",
      "```typescript",
      SR_S,
      "y",
      SR_D,
      "Y",
      SR_R,
      "```"
    ].join("\n");
    const blocks = parseSearchReplaceBlocks(text);
    expect(blocks.map((b) => b.filePath)).toEqual(["src/foo.ts", "src/bar.ts"]);
  });

  it("ignores ```diff fenced unified diffs (legacy format)", () => {
    const text = [
      "src/foo.ts",
      "```diff",
      "--- a/src/foo.ts",
      "+++ b/src/foo.ts",
      "@@ -1,1 +1,1 @@",
      "-old",
      "+new",
      "```"
    ].join("\n");
    expect(parseSearchReplaceBlocks(text)).toEqual([]);
  });

  it("skips a fence whose preceding line is not a path", () => {
    const text = [
      "Just some prose with spaces here.",
      "```",
      SR_S,
      "old",
      SR_D,
      "new",
      SR_R,
      "```"
    ].join("\n");
    expect(parseSearchReplaceBlocks(text)).toEqual([]);
  });

  it("flags a block as new-file when every SEARCH segment is empty", () => {
    const text = [
      "src/components/Button.tsx",
      "```",
      SR_S,
      SR_D,
      "export function Button() {",
      "  return null;",
      "}",
      SR_R,
      "```"
    ].join("\n");
    const blocks = parseSearchReplaceBlocks(text);
    expect(blocks).toHaveLength(1);
    expect(blocks[0].isNewFile).toBe(true);
    expect(blocks[0].edits).toEqual([
      { search: "", replace: "export function Button() {\n  return null;\n}" }
    ]);
  });

  it("rejects mixed empty/non-empty SEARCH segments in one block", () => {
    const text = [
      "src/foo.ts",
      "```",
      SR_S,
      SR_D,
      "fresh content",
      SR_R,
      "",
      SR_S,
      "alpha",
      SR_D,
      "beta",
      SR_R,
      "```"
    ].join("\n");
    expect(parseSearchReplaceBlocks(text)).toEqual([]);
  });
});

describe("applySearchReplaceEdits", () => {
  it("applies an exact substring match", () => {
    const result = applySearchReplaceEdits("hello world", [
      { search: "hello", replace: "hi" }
    ]);
    expect(result).toEqual({ ok: true, newContent: "hi world" });
  });

  it("tolerates trailing whitespace differences", () => {
    const fileContent = "function greet() {   \n  return 1;\n}\n";
    const result = applySearchReplaceEdits(fileContent, [
      {
        search: "function greet() {\n  return 1;\n}",
        replace: "function greet() {\n  return 2;\n}"
      }
    ]);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.newContent).toBe("function greet() {\n  return 2;\n}\n");
    }
  });

  it("reports failure when SEARCH not found", () => {
    const result = applySearchReplaceEdits("hello world", [
      { search: "goodbye", replace: "hi" }
    ]);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toContain("未在文件中找到");
    }
  });

  it("reports failure when SEARCH ambiguous", () => {
    const result = applySearchReplaceEdits("foo foo foo", [
      { search: "foo", replace: "bar" }
    ]);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toContain("3 次");
    }
  });

  it("applies multiple edits in order, each based on previous result", () => {
    const result = applySearchReplaceEdits("AAA BBB", [
      { search: "AAA", replace: "111" },
      { search: "BBB", replace: "222" }
    ]);
    expect(result).toEqual({ ok: true, newContent: "111 222" });
  });

  it("annotates which edit failed when multiple edits are provided", () => {
    const result = applySearchReplaceEdits("AAA", [
      { search: "AAA", replace: "111" },
      { search: "ZZZ", replace: "999" }
    ]);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toMatch(/第 2\/2/);
    }
  });

  it("treats empty SEARCH on empty content as new-file creation", () => {
    const result = applySearchReplaceEdits("", [
      { search: "", replace: "hello\nworld" }
    ]);
    expect(result).toEqual({ ok: true, newContent: "hello\nworld" });
  });

  it("rejects empty SEARCH on non-empty content", () => {
    const result = applySearchReplaceEdits("existing content\n", [
      { search: "", replace: "fresh content" }
    ]);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toContain("已存在且非空");
    }
  });
});

describe("createDiffProposalFromText", () => {
  const tools: Partial<AgentToolPermissions> = {
    readFile: true,
    writeDiff: true,
    applyDiff: false,
    previewArtifact: true,
    gitStatus: false
  };

  it("creates a DiffProposal and strips the edit block when SEARCH matches", async () => {
    const db = initializeDatabase({ dbPath: createTempDbPath() });
    const { workspace, agent, conversation } = createFixture(
      db,
      { "src/foo.ts": "function greet() {\n  return 1;\n}\n" },
      tools
    );

    const text = [
      "我帮你改一下：",
      "",
      "src/foo.ts",
      "```",
      SR_S,
      "function greet() {",
      "  return 1;",
      "}",
      SR_D,
      "function greet() {",
      "  return 2;",
      "}",
      SR_R,
      "```"
    ].join("\n");

    const result = await createDiffProposalFromText(
      {
        workspaceId: workspace.id,
        agentId: agent.id,
        conversationId: conversation.id,
        text
      },
      db
    );

    expect(result.diffProposals).toHaveLength(1);
    expect(result.diffProposals[0].filePath).toBe("src/foo.ts");
    expect(result.diffProposals[0].newContent).toBe(
      "function greet() {\n  return 2;\n}\n"
    );
    expect(result.diffMessages).toHaveLength(1);
    expect(result.diffMessages[0].messageType).toBe("diff_card");
    expect(result.text).toBe("我帮你改一下：");
  });

  it("emits a failure notice when SEARCH does not match and does NOT create a DiffProposal", async () => {
    const db = initializeDatabase({ dbPath: createTempDbPath() });
    const { workspace, agent, conversation } = createFixture(
      db,
      { "src/foo.ts": "function greet() {\n  return 1;\n}\n" },
      tools
    );

    const text = [
      "src/foo.ts",
      "```",
      SR_S,
      "function nope() {",
      "  return 99;",
      "}",
      SR_D,
      "function greet() {",
      "  return 2;",
      "}",
      SR_R,
      "```"
    ].join("\n");

    const result = await createDiffProposalFromText(
      {
        workspaceId: workspace.id,
        agentId: agent.id,
        conversationId: conversation.id,
        text
      },
      db
    );

    expect(result.diffProposals).toHaveLength(0);
    expect(result.diffMessages).toHaveLength(0);
    expect(result.text).toContain("⚠ 以下编辑无法应用");
    expect(result.text).toContain("src/foo.ts");
    expect(result.text).toContain("未在文件中找到");
  });

  it("creates DiffProposals for each successful file in multi-file replies", async () => {
    const db = initializeDatabase({ dbPath: createTempDbPath() });
    const { workspace, agent, conversation } = createFixture(
      db,
      {
        "src/a.ts": "alpha\n",
        "src/b.ts": "beta\n"
      },
      tools
    );

    const text = [
      "src/a.ts",
      "```",
      SR_S,
      "alpha",
      SR_D,
      "ALPHA",
      SR_R,
      "```",
      "",
      "src/b.ts",
      "```",
      SR_S,
      "beta",
      SR_D,
      "BETA",
      SR_R,
      "```"
    ].join("\n");

    const result = await createDiffProposalFromText(
      {
        workspaceId: workspace.id,
        agentId: agent.id,
        conversationId: conversation.id,
        text
      },
      db
    );

    expect(result.diffProposals).toHaveLength(2);
    expect(result.diffProposals.map((p) => p.filePath).sort()).toEqual([
      "src/a.ts",
      "src/b.ts"
    ]);
  });

  it("leaves legacy ```diff blocks untouched and does not create a DiffProposal", async () => {
    const db = initializeDatabase({ dbPath: createTempDbPath() });
    const { workspace, agent, conversation } = createFixture(
      db,
      { "src/foo.ts": "alpha\n" },
      tools
    );

    const text = [
      "Here is a unified diff (legacy format, should be ignored):",
      "```diff",
      "--- a/src/foo.ts",
      "+++ b/src/foo.ts",
      "@@ -1,1 +1,1 @@",
      "-alpha",
      "+ALPHA",
      "```"
    ].join("\n");

    const result = await createDiffProposalFromText(
      {
        workspaceId: workspace.id,
        agentId: agent.id,
        conversationId: conversation.id,
        text
      },
      db
    );

    expect(result.diffProposals).toHaveLength(0);
    expect(result.text).toContain("```diff");
  });

  it("creates a DiffProposal for a new file when the empty SEARCH block targets a missing file", async () => {
    const db = initializeDatabase({ dbPath: createTempDbPath() });
    const { workspace, agent, conversation } = createFixture(db, {}, tools);

    const text = [
      "src/components/Button.tsx",
      "```",
      SR_S,
      SR_D,
      "import React from \"react\";",
      "",
      "export function Button() {",
      "  return <button>hi</button>;",
      "}",
      SR_R,
      "```"
    ].join("\n");

    const result = await createDiffProposalFromText(
      {
        workspaceId: workspace.id,
        agentId: agent.id,
        conversationId: conversation.id,
        text
      },
      db
    );

    expect(result.diffProposals).toHaveLength(1);
    expect(result.diffProposals[0].filePath).toBe("src/components/Button.tsx");
    expect(result.diffProposals[0].oldContentHash).toBe(
      // hash of empty string is the marker for new-file proposals
      "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
    );
    expect(result.diffProposals[0].newContent).toBe(
      "import React from \"react\";\n\nexport function Button() {\n  return <button>hi</button>;\n}"
    );
    expect(result.text).not.toContain("src/components/Button.tsx");
    // ensure no failure notice was emitted
    expect(result.text).not.toContain("⚠");
  });

  it("rejects an empty SEARCH block when the target file already exists and is non-empty", async () => {
    const db = initializeDatabase({ dbPath: createTempDbPath() });
    const { workspace, agent, conversation } = createFixture(
      db,
      { "src/components/Button.tsx": "export const old = true;\n" },
      tools
    );

    const text = [
      "src/components/Button.tsx",
      "```",
      SR_S,
      SR_D,
      "export const fresh = true;",
      SR_R,
      "```"
    ].join("\n");

    const result = await createDiffProposalFromText(
      {
        workspaceId: workspace.id,
        agentId: agent.id,
        conversationId: conversation.id,
        text
      },
      db
    );

    expect(result.diffProposals).toHaveLength(0);
    expect(result.text).toContain("已存在且非空");
  });
});
