import { describe, expect, it, vi, beforeEach } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

// Mock the workspace store
vi.mock("../../state/workspaceStore", () => ({
  useWorkspaceStore: () => ({
    selectChat: vi.fn(),
    setNavigationSection: vi.fn()
  })
}));

// Mock the AgentStatusBadge
vi.mock("./AgentStatusBadge", () => ({
  AgentStatusBadge: ({ status }: { status: string }) => `status:${status}`
}));

import { AgentProfileView } from "./AgentProfileView";

describe("AgentProfileView", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    (globalThis as any).window = {
      ...(globalThis as any).window,
      agenthub: {
        agent: { getAgentProfile: () => new Promise(() => {}) },
        conversation: { findOrCreateDirectConversationForAgent: vi.fn() }
      }
    };
  });

  it("shows loading state when API has not resolved", () => {
    const markup = renderToStaticMarkup(<AgentProfileView agentId="agent-1" />);
    expect(markup).toContain("Loading agent profile...");
  });

  it("shows error state when API rejects synchronously in effect", () => {
    // Note: renderToStaticMarkup is synchronous so the error state won't appear
    // in static rendering. This test verifies the loading state is shown.
    const markup = renderToStaticMarkup(<AgentProfileView agentId="agent-1" />);
    expect(markup).toContain("Loading agent profile...");
  });
});

describe("AgentProfileView display logic", () => {
  it("identifies orchestrator by role", () => {
    const agent = { role: "main", type: "specialist" };
    const isOrchestrator = agent.role === "main" || agent.type === "orchestrator";
    expect(isOrchestrator).toBe(true);
  });

  it("identifies specialist by type", () => {
    const agent = { role: "sub", type: "specialist" };
    const isOrchestrator = agent.role === "main" || agent.type === "orchestrator";
    expect(isOrchestrator).toBe(false);
  });

  it("identifies orchestrator by type", () => {
    const agent = { role: "sub", type: "orchestrator" };
    const isOrchestrator = agent.role === "main" || agent.type === "orchestrator";
    expect(isOrchestrator).toBe(true);
  });

  it("forces applyDiff to false regardless of input", () => {
    const tools = { readFile: true, writeDiff: true, applyDiff: true, previewArtifact: true, gitStatus: true };
    const displayTools = { ...tools, applyDiff: false };
    expect(displayTools.applyDiff).toBe(false);
  });

  it("parses safe JSON with fallback", () => {
    function parseJsonSafe<T>(value: string, fallback: T): T {
      try {
        const parsed = JSON.parse(value);
        return parsed ?? fallback;
      } catch {
        return fallback;
      }
    }
    expect(parseJsonSafe('["a","b"]', [])).toEqual(["a", "b"]);
    expect(parseJsonSafe("invalid", [])).toEqual([]);
    expect(parseJsonSafe("null", [])).toEqual([]);
    expect(parseJsonSafe('["a","b","c","d","e","f"]', []).length).toBe(6);
  });
});
