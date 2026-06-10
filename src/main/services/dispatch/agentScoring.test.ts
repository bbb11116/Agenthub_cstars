import { describe, expect, it } from "vitest";
import type { Agent } from "../../../shared/domain";
import type { AgentAssignment, SubTask } from "../../../shared/groupChat";
import {
  buildExecutionBatches,
  filterDispatchCandidates,
  resolveRequiredToolNames
} from "./agentScoring";

function subTask(input: Partial<SubTask> & Pick<SubTask, "id">): SubTask {
  return {
    title: input.id,
    objective: input.id,
    acceptanceCriteria: [],
    requiredSkillQueries: [],
    requiredTools: [],
    taskType: "general",
    dependsOn: [],
    riskLevel: "low",
    expectedOutputType: "analysis",
    ...input
  };
}

function assignment(task: SubTask): AgentAssignment {
  return {
    id: task.id,
    agentId: `agent-${task.id}`,
    instruction: task.objective,
    targetCriteria: [],
    dependsOn: task.dependsOn,
    reason: "test",
    subTask: task
  };
}

describe("buildExecutionBatches", () => {
  it("batches independent tasks together", () => {
    const batches = buildExecutionBatches([
      assignment(subTask({ id: "task-1" })),
      assignment(subTask({ id: "task-2" }))
    ]);

    expect(batches.map((batch) => batch.map((item) => item.id))).toEqual([
      ["task-1", "task-2"]
    ]);
  });

  it("serializes dependency edges", () => {
    const batches = buildExecutionBatches([
      assignment(subTask({ id: "design" })),
      assignment(subTask({ id: "implement", dependsOn: ["design"] })),
      assignment(subTask({ id: "test", dependsOn: ["implement"] }))
    ]);

    expect(batches.map((batch) => batch.map((item) => item.id))).toEqual([
      ["design"],
      ["implement"],
      ["test"]
    ]);
  });

  it("treats prior-round completed task ids as satisfied dependencies", () => {
    const batches = buildExecutionBatches(
      [
        assignment(subTask({ id: "repair", dependsOn: ["design"] })),
        assignment(subTask({ id: "verify", dependsOn: ["repair"] }))
      ],
      ["design"]
    );

    expect(batches.map((batch) => batch.map((item) => item.id))).toEqual([
      ["repair"],
      ["verify"]
    ]);
  });

  it("keeps same-file diff proposals out of the same batch", () => {
    const batches = buildExecutionBatches([
      assignment(
        subTask({
          id: "task-1",
          expectedOutputType: "diff_proposal",
          targetFiles: ["src/App.tsx"]
        })
      ),
      assignment(
        subTask({
          id: "task-2",
          expectedOutputType: "diff_proposal",
          targetFiles: ["src/App.tsx"]
        })
      ),
      assignment(
        subTask({
          id: "task-3",
          expectedOutputType: "diff_proposal",
          targetFiles: ["src/Other.tsx"]
        })
      )
    ]);

    expect(batches.map((batch) => batch.map((item) => item.id))).toEqual([
      ["task-1", "task-3"],
      ["task-2"]
    ]);
  });
});

function makeAgent(input: {
  id: string;
  tools?: Partial<Record<string, boolean>>;
  status?: Agent["status"];
}): Agent {
  return {
    id: input.id,
    name: `Agent ${input.id}`,
    description: "test agent",
    role: "sub",
    type: "specialist",
    status: input.status ?? "available",
    runtimeProvider: "mock",
    model: "test-model",
    workspaceId: "ws-1",
    systemPrompt: "",
    tools: {
      readFile: false,
      writeDiff: false,
      applyDiff: false,
      previewArtifact: false,
      gitStatus: false,
      webSearch: false,
      webFetch: false,
      ...input.tools
    },
    capabilities: [],
    fileScope: [],
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:00Z"
  };
}

describe("resolveRequiredToolNames", () => {
  it("normalizes snake_case aliases to canonical names", () => {
    const result = resolveRequiredToolNames(
      subTask({ id: "t1", requiredTools: ["read_file", "write_diff"] })
    );
    expect(result.tools).toEqual(["readFile", "writeDiff"]);
    expect(result.droppedOriginalNames).toEqual([]);
  });

  it("drops unknown tool names and reports them", () => {
    const result = resolveRequiredToolNames(
      subTask({ id: "t1", requiredTools: ["browse", "firecrawl", "readFile"] })
    );
    expect(result.tools).toEqual(["readFile"]);
    expect(result.droppedOriginalNames).toEqual(["browse", "firecrawl"]);
  });

  it("normalizes PascalCase web tools to canonical camelCase", () => {
    const result = resolveRequiredToolNames(
      subTask({ id: "t1", requiredTools: ["WebSearch", "WebFetch"] })
    );
    expect(result.tools).toEqual(["webSearch", "webFetch"]);
    expect(result.droppedOriginalNames).toEqual([]);
  });

  it("auto-adds writeDiff for diff_proposal even when LLM omits it", () => {
    const result = resolveRequiredToolNames(
      subTask({
        id: "t1",
        requiredTools: [],
        expectedOutputType: "diff_proposal"
      })
    );
    expect(result.tools).toEqual(["writeDiff"]);
  });

  it("keeps writeDiff explicit and deduplicates", () => {
    const result = resolveRequiredToolNames(
      subTask({
        id: "t1",
        requiredTools: ["writeDiff", "write_diff", "apply_diff"],
        expectedOutputType: "diff_proposal"
      })
    );
    expect(result.tools).toEqual(["writeDiff", "applyDiff"]);
  });
});

describe("filterDispatchCandidates — lenient requiredTools", () => {
  const groupMemberAgentIds = new Set(["a-ok", "a-write", "a-bare"]);

  const agents: Agent[] = [
    makeAgent({ id: "a-ok", tools: { readFile: true, writeDiff: true } }),
    makeAgent({ id: "a-write", tools: { writeDiff: true } }),
    makeAgent({ id: "a-bare", tools: {} })
  ];

  it("accepts agents that match the normalized required tools, even when the LLM emitted unknown aliases", () => {
    // LLM mistakenly wrote `browse` / `firecrawl` (real-world LLM confusions
    // for browsing tools). After normalization these drop out, leaving no
    // required tool, so every available group member is a valid candidate.
    const result = filterDispatchCandidates({
      agents,
      groupMemberAgentIds,
      subTask: subTask({
        id: "t1",
        requiredTools: ["browse", "firecrawl"],
        expectedOutputType: "analysis"
      })
    });

    expect(result.candidates.map((agent) => agent.id).sort()).toEqual([
      "a-bare",
      "a-ok",
      "a-write"
    ]);
    expect(result.rejected).toEqual([]);
  });

  it("still enforces writeDiff for diff_proposal when LLM omits requiredTools entirely", () => {
    const result = filterDispatchCandidates({
      agents,
      groupMemberAgentIds,
      subTask: subTask({
        id: "t1",
        requiredTools: [],
        expectedOutputType: "diff_proposal"
      })
    });

    expect(result.candidates.map((agent) => agent.id)).toEqual(["a-ok", "a-write"]);
    expect(result.rejected.find((item) => item.agentId === "a-bare")?.reason).toBe(
      "missing_write_diff"
    );
  });

  it("does not reject everyone just because one unknown tool name was provided", () => {
    // Regression for the "second dispatch silently fails" bug: previously any
    // unknown alias like "browse" / "firecrawl" would mark every agent as
    // missing_required_tool, which made the LLM think the plan had been
    // submitted while in fact execution never started.
    const result = filterDispatchCandidates({
      agents,
      groupMemberAgentIds,
      subTask: subTask({
        id: "t1",
        requiredTools: ["browse", "firecrawl", "google_search"],
        expectedOutputType: "analysis"
      })
    });

    expect(result.candidates.length).toBeGreaterThan(0);
    expect(
      result.rejected.every((item) => item.reason !== "missing_required_tool")
    ).toBe(true);
  });
});
