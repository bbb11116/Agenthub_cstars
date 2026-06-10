import { useCallback, useEffect, useState } from "react";
import type { ModelProviderListItem, SaveModelProviderInput, TestConnectionResult } from "../../../shared/types";
import { ModelProviderForm } from "./ModelProviderForm";
import { ModelProviderList } from "./ModelProviderList";

type Props = {
  onBack: () => void;
};

type PageState =
  | { view: "list" }
  | { view: "add" }
  | { view: "edit"; providerId: string };

function getApi() {
  if (!window.agenthub) throw new Error("AgentHub API unavailable");
  return window.agenthub;
}

export function ModelProviderSettingsPage({ onBack }: Props) {
  const [providers, setProviders] = useState<ModelProviderListItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [pageState, setPageState] = useState<PageState>({ view: "list" });
  const [editData, setEditData] = useState<ModelProviderListItem | null>(null);

  const loadProviders = useCallback(async () => {
    setLoading(true);
    try {
      const list = await getApi().modelProvider.list();
      setProviders(list);
    } catch (err) {
      console.error("Failed to load providers:", err);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadProviders();
  }, [loadProviders]);

  useEffect(() => {
    if (pageState.view === "edit") {
      const provider = providers.find((p) => p.id === pageState.providerId);
      setEditData(provider ?? null);
    } else {
      setEditData(null);
    }
  }, [pageState, providers]);

  async function handleSave(input: SaveModelProviderInput): Promise<void> {
    await getApi().modelProvider.save(input);
    await loadProviders();
    setPageState({ view: "list" });
  }

  async function handleTest(input: SaveModelProviderInput): Promise<TestConnectionResult> {
    return getApi().modelProvider.testConnection(input);
  }

  async function handleDelete(id: string): Promise<void> {
    await getApi().modelProvider.delete(id);
    await loadProviders();
  }

  if (pageState.view === "add") {
    return (
      <section className="model-provider-settings-shell">
        <div className="model-provider-settings-card">
          <div className="model-provider-settings-header">
            <button type="button" className="model-provider-back-button" onClick={() => setPageState({ view: "list" })}>
              &larr; 返回
            </button>
            <h2>添加 Model Provider</h2>
          </div>
          <ModelProviderForm
            onSave={handleSave}
            onCancel={() => setPageState({ view: "list" })}
            onTest={handleTest}
          />
        </div>
      </section>
    );
  }

  if (pageState.view === "edit") {
    if (!editData) {
      return (
        <section className="model-provider-settings-shell">
          <div className="model-provider-settings-card">
            <p>Provider 未找到。</p>
            <button type="button" onClick={() => setPageState({ view: "list" })}>返回列表</button>
          </div>
        </section>
      );
    }

    return (
      <section className="model-provider-settings-shell">
        <div className="model-provider-settings-card">
          <div className="model-provider-settings-header">
            <button type="button" className="model-provider-back-button" onClick={() => setPageState({ view: "list" })}>
              &larr; 返回
            </button>
            <h2>编辑 Provider</h2>
          </div>
          <ModelProviderForm
            initialData={editData}
            isEdit
            onSave={handleSave}
            onCancel={() => setPageState({ view: "list" })}
            onTest={handleTest}
          />
        </div>
      </section>
    );
  }

  // List view
  return (
    <section className="model-provider-settings-shell">
      <div className="model-provider-settings-card">
        <div className="model-provider-settings-header">
          <button type="button" className="model-provider-back-button" onClick={onBack}>
            &larr; 返回
          </button>
          <h2>模型 API 配置</h2>
        </div>

        {loading ? (
          <div className="model-provider-list-loading">加载中...</div>
        ) : (
          <ModelProviderList
            providers={providers}
            onEdit={(id) => setPageState({ view: "edit", providerId: id })}
            onDelete={handleDelete}
            onAdd={() => setPageState({ view: "add" })}
          />
        )}
      </div>
    </section>
  );
}
