import type { SaveModelProviderInput, TestConnectionResult } from "../../../shared/types";
import { useWorkspaceStore } from "../../state/workspaceStore";
import { ModelProviderForm } from "./ModelProviderForm";

function getApi() {
  if (!window.agenthub) throw new Error("AgentHub API unavailable");
  return window.agenthub;
}

export function OnboardingModelProviderPage() {
  const { setAppView, loadWorkspaces } = useWorkspaceStore();

  async function handleSave(input: SaveModelProviderInput): Promise<void> {
    await getApi().modelProvider.save(input);
    // Reload workspaces which will transition to main view
    await loadWorkspaces();
  }

  async function handleTest(input: SaveModelProviderInput): Promise<TestConnectionResult> {
    return getApi().modelProvider.testConnection(input);
  }

  return (
    <main className="onboarding-shell">
      <section className="onboarding-card" aria-label="Model provider onboarding">
        <div className="onboarding-header">
          <span className="eyebrow">配置</span>
          <h1>配置 AI 模型</h1>
          <p>
            AgentHub 需要一个大模型 API 来驱动主 Agent。请填写你的模型 Provider 信息。
          </p>
        </div>

        <ModelProviderForm
          onSave={handleSave}
          onCancel={() => setAppView("main")}
          onTest={handleTest}
        />
      </section>
    </main>
  );
}
