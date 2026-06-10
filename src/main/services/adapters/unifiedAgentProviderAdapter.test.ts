import { describe, expect, it } from "vitest";
import { translateAgentEvent } from "./unifiedAgentProviderAdapter";
import type { AgentEvent } from "../../../shared/agentAdapter";

describe("translateAgentEvent", () => {
  const base = {
    conversationId: "conv-1",
    runId: "run-1",
    startedAt: new Date().toISOString(),
    startingSeq: 0,
    messageId: "msg-1"
  };

  it("maps text_delta to message.delta with a string delta payload", () => {
    const event: AgentEvent = { type: "text_delta", content: "hello" };
    const [out] = translateAgentEvent(event, base.conversationId, base.runId, base.startedAt, base.startingSeq, base.messageId);
    expect(out.type).toBe("message.delta");
    if (out.type !== "message.delta") {
      throw new Error("Expected message.delta");
    }
    expect(out.payload.delta).toBe("hello");
    expect(out.payload.messageId).toBe(base.messageId);
    expect(typeof out.payload.delta).toBe("string");
  });

  it("preserves multi-line text and never wraps the delta in JSON", () => {
    const event: AgentEvent = { type: "text_delta", content: "## title\n\n- a\n- b\n" };
    const [out] = translateAgentEvent(event, base.conversationId, base.runId, base.startedAt, base.startingSeq, base.messageId);
    expect(out.type).toBe("message.delta");
    if (out.type !== "message.delta") {
      throw new Error("Expected message.delta");
    }
    expect(out.payload.delta).not.toMatch(/^\{/);
    expect(out.payload.delta).toContain("- a");
  });

  it("maps error events to run.failed", () => {
    const event: AgentEvent = { type: "error", message: "boom" };
    const [out] = translateAgentEvent(event, base.conversationId, base.runId, base.startedAt, base.startingSeq, base.messageId);
    expect(out.type).toBe("run.failed");
    if (out.type !== "run.failed") {
      throw new Error("Expected run.failed");
    }
    expect(out.payload.message).toBe("boom");
    expect(out.payload.messageId).toBe(base.messageId);
  });

  it("maps structured_result tool calls to tool.call.completed", () => {
    const event: AgentEvent = {
      type: "structured_result",
      result: {
        toolCalls: [
          { id: "t1", name: "readFile", arguments: { path: "/tmp/a.ts" } }
        ]
      }
    };
    const [out] = translateAgentEvent(event, base.conversationId, base.runId, base.startedAt, base.startingSeq, base.messageId);
    expect(out.type).toBe("tool.call.completed");
    if (out.type !== "tool.call.completed") {
      throw new Error("Expected tool.call.completed");
    }
    expect(out.payload.toolCallId).toBe("t1");
    expect(out.payload.name).toBe("readFile");
    expect(out.payload.ok).toBe(true);
  });

  it("maps structured_result tool results to tool.result", () => {
    const event: AgentEvent = {
      type: "structured_result",
      result: {
        toolResults: [
          {
            toolCallId: "t1",
            name: "web_search",
            result: { results: [] },
            ok: true
          }
        ]
      }
    };
    const [out] = translateAgentEvent(event, base.conversationId, base.runId, base.startedAt, base.startingSeq, base.messageId);
    expect(out.type).toBe("tool.result");
    if (out.type !== "tool.result") {
      throw new Error("Expected tool.result");
    }
    expect(out.payload.toolCallId).toBe("t1");
    expect(out.payload.name).toBe("web_search");
    expect(out.payload.result).toEqual({ results: [] });
    expect(out.payload.ok).toBe(true);
  });

  it("maps structured_result diffProposals to diff.proposal", () => {
    const event: AgentEvent = {
      type: "structured_result",
      result: {
        diffProposals: [
          {
            id: "p1",
            files: [
              { path: "src/foo.ts", status: "modified", unifiedDiff: "@@ ..." }
            ]
          }
        ]
      }
    };
    const [out] = translateAgentEvent(event, base.conversationId, base.runId, base.startedAt, base.startingSeq, base.messageId);
    expect(out.type).toBe("diff.proposal");
    if (out.type !== "diff.proposal") {
      throw new Error("Expected diff.proposal");
    }
    expect(out.payload.proposalId).toBe("p1");
    expect(out.payload.files).toEqual([
      { path: "src/foo.ts", status: "modified", unifiedDiff: "@@ ..." }
    ]);
  });

  it("ignores status events that are not iteration_limit_reached", () => {
    const event: AgentEvent = { type: "status", status: "running" };
    const out = translateAgentEvent(event, base.conversationId, base.runId, base.startedAt, base.startingSeq, base.messageId);
    expect(out).toEqual([]);
  });

  it("maps iteration_limit_reached status to run.failed", () => {
    const event: AgentEvent = { type: "status", status: "iteration_limit_reached" };
    const [out] = translateAgentEvent(event, base.conversationId, base.runId, base.startedAt, base.startingSeq, base.messageId);
    expect(out.type).toBe("run.failed");
  });
});
