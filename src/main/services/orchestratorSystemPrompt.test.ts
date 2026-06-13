import { describe, expect, it } from "vitest";
import type { Workspace } from "../../shared/domain";
import { buildOrchestratorSystemPrompt } from "./orchestratorSystemPrompt";

describe("buildOrchestratorSystemPrompt", () => {
  it("does not advertise the retired conversational Agent creation intent", () => {
    const workspace: Workspace = {
      id: "workspace",
      name: "Workspace",
      rootPath: "/workspace",
      mainAgentId: "main-agent",
      gitEnabled: false,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    };
    const prompt = buildOrchestratorSystemPrompt(workspace, [], []);

    expect(prompt).not.toContain("create_agent");
    expect(prompt).not.toContain("AgentConfigDraft");
    expect(prompt).toContain("左上角加号手动创建子 Agent");
  });

  it("advertises new-file support so the LLM does not refuse the request", () => {
    const workspace: Workspace = {
      id: "workspace",
      name: "Workspace",
      rootPath: "/workspace",
      mainAgentId: "main-agent",
      gitEnabled: false,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    };
    const prompt = buildOrchestratorSystemPrompt(workspace, [], []);

    expect(prompt).toContain("也能创建全新文件");
    expect(prompt).toContain("空 SEARCH 块");
    expect(prompt).toContain("绝对不要**告诉用户");
    expect(prompt).toContain("无论绑定了哪个 runtime 都同样可以");
    expect(prompt).not.toContain("dispatch to specialist sub-agents");
    expect(prompt).toContain("切换 Runtime");
  });

  it("constrains PPT HTML output to a full-width slide canvas", () => {
    const workspace: Workspace = {
      id: "workspace",
      name: "Workspace",
      rootPath: "/workspace",
      mainAgentId: "main-agent",
      gitEnabled: false,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    };
    const prompt = buildOrchestratorSystemPrompt(workspace, [], []);

    expect(prompt).toContain("PPT / 幻灯片 / slide deck");
    expect(prompt).toContain("width: 1920px");
    expect(prompt).toContain("height: 1080px");
    expect(prompt).toContain("不要使用 `max-width` 外层容器");
    expect(prompt).toContain("不要添加 JavaScript 翻页");
  });
});
