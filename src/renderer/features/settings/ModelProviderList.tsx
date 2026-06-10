import type { ModelProviderListItem } from "../../../shared/types";

type Props = {
  providers: ModelProviderListItem[];
  onEdit: (id: string) => void;
  onDelete: (id: string) => void;
  onAdd: () => void;
};

const FORMAT_LABELS: Record<string, string> = {
  openai_chat_completions: "OpenAI",
  anthropic_messages: "Anthropic"
};

function formatCapability(status: string): string {
  if (status === "supported") return "支持";
  if (status === "unsupported") return "不支持";
  return "未知";
}

export function ModelProviderList({ providers, onEdit, onDelete, onAdd }: Props) {
  if (providers.length === 0) {
    return (
      <div className="model-provider-list">
        <div className="model-provider-list-empty">
          <p>暂未配置任何 Model Provider。</p>
          <button type="button" className="model-provider-add-button" onClick={onAdd}>
            添加 Provider
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="model-provider-list">
      <div className="model-provider-list-header">
        <h3>已配置的 Provider</h3>
        <button type="button" className="model-provider-add-button" onClick={onAdd}>
          添加 Provider
        </button>
      </div>

      {providers.map((provider) => (
        <div key={provider.id} className="model-provider-row">
          <div className="model-provider-row-info">
            <div className="model-provider-row-name">
              {provider.name}
              {provider.isDefaultForMainAgent && (
                <span className="model-provider-default-badge">默认</span>
              )}
            </div>
            <div className="model-provider-row-details">
              <span className="model-provider-format-badge">
                {FORMAT_LABELS[provider.apiFormat] ?? provider.apiFormat}
              </span>
              <code className="model-provider-row-model">{provider.model}</code>
              <span>
                {provider.limits.contextWindowTokens >= 1_048_576 ? "1M" : "256K"} context
              </span>
              <span>
                流式 {formatCapability(provider.capabilities.streaming)}
              </span>
              <span>
                工具 {formatCapability(provider.capabilities.toolCalling)}
              </span>
              <span>
                JSON {formatCapability(provider.capabilities.jsonMode)}
              </span>
              <span className="model-provider-row-url">{provider.baseUrl}</span>
            </div>
          </div>
          <div className="model-provider-row-actions">
            <button type="button" onClick={() => onEdit(provider.id)}>
              编辑
            </button>
            <button
              type="button"
              className="model-provider-delete-button"
              onClick={() => {
                if (window.confirm(`确定删除 "${provider.name}" ?`)) {
                  onDelete(provider.id);
                }
              }}
            >
              删除
            </button>
          </div>
        </div>
      ))}
    </div>
  );
}
