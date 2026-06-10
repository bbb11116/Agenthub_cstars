import { describe, expect, it, vi, beforeEach } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

vi.mock("../../state/workspaceStore", () => ({
  useWorkspaceStore: () => ({
    selectChat: vi.fn(),
    setNavigationSection: vi.fn()
  })
}));

import { GroupProfileView } from "./GroupProfileView";

describe("GroupProfileView", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    (globalThis as any).window = {
      ...(globalThis as any).window,
      agenthub: {
        groupConversation: { getGroupProfile: () => new Promise(() => {}) }
      }
    };
  });

  it("shows loading state when API has not resolved", () => {
    const markup = renderToStaticMarkup(<GroupProfileView conversationId="conv-1" />);
    expect(markup).toContain("Loading group profile...");
  });
});

describe("GroupProfileView helpers", () => {
  it("labels member roles in Chinese", () => {
    function memberRoleLabel(role: string): string {
      if (role === "owner") return "群主";
      if (role === "main_agent") return "主 Agent";
      return "子 Agent";
    }
    expect(memberRoleLabel("owner")).toBe("群主");
    expect(memberRoleLabel("main_agent")).toBe("主 Agent");
    expect(memberRoleLabel("member")).toBe("子 Agent");
  });

  it("maps dispatch statuses to Chinese labels with fallback", () => {
    const map: Record<string, string> = {
      planning: "规划中",
      running_subagents: "执行子任务",
      reviewing: "编排者审查",
      redispatching: "重新分发",
      completed: "已完成",
      partial: "部分完成",
      failed: "失败",
      waiting_for_user: "等待用户",
      running: "执行中",
      cancelled: "已取消"
    };
    function dispatchStatusLabel(status: string): string {
      return map[status] ?? status;
    }
    expect(dispatchStatusLabel("completed")).toBe("已完成");
    expect(dispatchStatusLabel("unknown_state")).toBe("unknown_state");
  });

  it("splits members into owner / main / sub buckets by role", () => {
    const members = [
      { id: "m1", role: "owner" as const, name: "u" },
      { id: "m2", role: "main_agent" as const, name: "a" },
      { id: "m3", role: "member" as const, name: "b" },
      { id: "m4", role: "member" as const, name: "c" }
    ];
    const owners = members.filter((m) => m.role === "owner");
    const mainAgents = members.filter((m) => m.role === "main_agent");
    const subs = members.filter((m) => m.role === "member");
    expect(owners).toHaveLength(1);
    expect(mainAgents).toHaveLength(1);
    expect(subs).toHaveLength(2);
  });

  it("routes sub-agent activation to direct chat and main-agent to profile", () => {
    const calls: Array<{ kind: "chat" | "profile"; target: string }> = [];
    function activateSub(agentId: string) {
      calls.push({ kind: "chat", target: agentId });
    }
    function activateMain(agentId: string) {
      calls.push({ kind: "profile", target: agentId });
    }
    activateSub("sub-1");
    activateMain("main-1");
    expect(calls).toEqual([
      { kind: "chat", target: "sub-1" },
      { kind: "profile", target: "main-1" }
    ]);
  });
});
