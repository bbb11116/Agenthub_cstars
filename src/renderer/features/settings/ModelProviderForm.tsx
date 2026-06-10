import { useState } from "react";
import type { SaveModelProviderInput, TestConnectionResult, ModelProviderListItem } from "../../../shared/types";

type Props = {
  initialData?: ModelProviderListItem;
  onSave: (input: SaveModelProviderInput) => Promise<void>;
  onCancel: () => void;
  onTest?: (input: SaveModelProviderInput) => Promise<TestConnectionResult>;
  isEdit?: boolean;
};

const API_FORMAT_OPTIONS = [
  { value: "openai_chat_completions", label: "OpenAI Chat Completions 格式" },
  { value: "anthropic_messages", label: "Anthropic Messages 格式" }
] as const;

function buildFormInput(
  name: string,
  apiFormat: "openai_chat_completions" | "anthropic_messages",
  baseUrl: string,
  isFullUrl: boolean,
  model: string,
  apiKey: string,
  supportsVision: boolean,
  supportsStreaming: boolean,
  isDefaultForMainAgent: boolean,
  enableOneMillionContext: boolean,
  initialData?: ModelProviderListItem,
  testResult?: TestConnectionResult | null
): SaveModelProviderInput {
  return {
    id: initialData?.id,
    name,
    apiFormat,
    baseUrl,
    isFullUrl,
    model,
    apiKey: apiKey || undefined,
    supportsVision,
    supportsStreaming,
    capabilities: testResult?.capabilities,
    isDefaultForMainAgent,
    enableOneMillionContext
  };
}

function formatCapability(status: string): string {
  if (status === "supported") return "支持";
  if (status === "unsupported") return "不支持";
  return "未知";
}

export function ModelProviderForm({ initialData, onSave, onCancel, onTest, isEdit }: Props) {
  const [name, setName] = useState(initialData?.name ?? "");
  const [apiFormat, setApiFormat] = useState<"openai_chat_completions" | "anthropic_messages">(
    initialData?.apiFormat ?? "openai_chat_completions"
  );
  const [baseUrl, setBaseUrl] = useState(initialData?.baseUrl ?? "");
  const [isFullUrl, setIsFullUrl] = useState(initialData?.isFullUrl ?? false);
  const [model, setModel] = useState(initialData?.model ?? "");
  const [apiKey, setApiKey] = useState("");
  const [showApiKey, setShowApiKey] = useState(false);
  const [supportsVision, setSupportsVision] = useState(initialData?.supportsVision ?? false);
  const [supportsStreaming, setSupportsStreaming] = useState(initialData?.supportsStreaming ?? true);
  const [isDefaultForMainAgent, setIsDefaultForMainAgent] = useState(initialData?.isDefaultForMainAgent ?? true);
  const [enableOneMillionContext, setEnableOneMillionContext] = useState(
    initialData?.limits.source === "user_enabled_1m"
  );

  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<TestConnectionResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  const needsApiKey = !isEdit || !initialData?.hasApiKey;
  const canSave = name.trim() && baseUrl.trim() && model.trim() && (!needsApiKey || apiKey.trim());

  function resolveEndpoint(): string {
    const normalizedBase = baseUrl.replace(/\/+$/, "");
    if (isFullUrl) return normalizedBase;
    if (apiFormat === "openai_chat_completions") {
      return normalizedBase.endsWith("/v1")
        ? `${normalizedBase}/chat/completions`
        : `${normalizedBase}/v1/chat/completions`;
    }
    return normalizedBase.endsWith("/v1")
      ? `${normalizedBase}/messages`
      : `${normalizedBase}/v1/messages`;
  }

  async function handleTest(): Promise<void> {
    if (!onTest) return;
    setTesting(true);
    setTestResult(null);
    try {
      const input = buildFormInput(name, apiFormat, baseUrl, isFullUrl, model, apiKey, supportsVision, supportsStreaming, isDefaultForMainAgent, enableOneMillionContext, initialData, null);
      const result = await onTest(input);
      setTestResult(result);
    } catch (err) {
      setTestResult({ ok: false, error: err instanceof Error ? err.message : "Unknown error" });
    } finally {
      setTesting(false);
    }
  }

  async function handleSave(): Promise<void> {
    if (!canSave) return;
    setSaving(true);
    setError(null);
    try {
      const input = buildFormInput(name, apiFormat, baseUrl, isFullUrl, model, apiKey, supportsVision, supportsStreaming, isDefaultForMainAgent, enableOneMillionContext, initialData, testResult);
      await onSave(input);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to save");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="model-provider-form">
      <div className="model-provider-form-field">
        <span>Provider 名称</span>
        <input
          type="text"
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="例如 My OpenAI"
        />
      </div>

      <div className="model-provider-form-field">
        <span>API 格式</span>
        <select
          value={apiFormat}
          onChange={(e) => setApiFormat(e.target.value as "openai_chat_completions" | "anthropic_messages")}
        >
          {API_FORMAT_OPTIONS.map((opt) => (
            <option key={opt.value} value={opt.value}>{opt.label}</option>
          ))}
        </select>
      </div>

      <div className="model-provider-form-field">
        <span>自定义请求地址 (Base URL)</span>
        <input
          type="text"
          value={baseUrl}
          onChange={(e) => setBaseUrl(e.target.value)}
          placeholder="https://api.openai.com"
        />
      </div>

      <div className="model-provider-form-field model-provider-form-checkbox-field">
        <label>
          <input
            type="checkbox"
            checked={enableOneMillionContext}
            onChange={(e) => setEnableOneMillionContext(e.target.checked)}
          />
          <span>启用 1M 上下文</span>
        </label>
        <small>
          当前上下文长度：{enableOneMillionContext ? "1M" : "256K"} tokens
        </small>
        <small>
          仅当你的模型供应商和所选模型确实支持 1M context window 时再启用，否则调用时可能因上下文超限失败。
        </small>
      </div>

      <div className="model-provider-form-field model-provider-form-checkbox-field">
        <label>
          <input
            type="checkbox"
            checked={isFullUrl}
            onChange={(e) => setIsFullUrl(e.target.checked)}
          />
          <span>完整 URL (isFullUrl)</span>
        </label>
        <small>如果请求地址已包含完整路径，请勾选此项</small>
      </div>

      <div className="model-provider-form-field">
        <span>模型 ID</span>
        <input
          type="text"
          value={model}
          onChange={(e) => setModel(e.target.value)}
          placeholder="gpt-4o-mini"
        />
      </div>

      <div className="model-provider-form-field">
        <span>API 密钥</span>
        <div className="model-provider-api-key-wrapper">
          <input
            type={showApiKey ? "text" : "password"}
            value={apiKey}
            onChange={(e) => setApiKey(e.target.value)}
            placeholder={isEdit && initialData?.hasApiKey ? "********" : "输入 API Key"}
          />
          <button
            type="button"
            className="model-provider-api-key-toggle"
            onClick={() => setShowApiKey(!showApiKey)}
          >
            {showApiKey ? "隐藏" : "显示"}
          </button>
        </div>
        {isEdit && initialData?.hasApiKey && (
          <small>留空表示不修改已保存的 API Key</small>
        )}
      </div>

      <div className="model-provider-form-field">
        <span>最终请求地址</span>
        <code className="model-provider-endpoint-preview">{resolveEndpoint()}</code>
      </div>

      <div className="model-provider-form-field model-provider-form-checkbox-field">
        <label>
          <input
            type="checkbox"
            checked={supportsVision}
            onChange={(e) => setSupportsVision(e.target.checked)}
          />
          <span>多模态 (supportsVision)</span>
        </label>
      </div>

      <div className="model-provider-form-field model-provider-form-checkbox-field">
        <label>
          <input
            type="checkbox"
            checked={supportsStreaming}
            onChange={(e) => setSupportsStreaming(e.target.checked)}
          />
          <span>流式输出 (supportsStreaming)</span>
        </label>
      </div>

      <div className="model-provider-form-field model-provider-form-checkbox-field">
        <label>
          <input
            type="checkbox"
            checked={isDefaultForMainAgent}
            onChange={(e) => setIsDefaultForMainAgent(e.target.checked)}
          />
          <span>设为默认主 Agent Provider</span>
        </label>
      </div>

      {testResult && (
        <div className={`model-provider-test-result ${testResult.ok ? "model-provider-test-ok" : "model-provider-test-error"}`} role="status">
          {testResult.ok ? (
            <div>
              <span>连接成功 ({testResult.latencyMs}ms, 模型: {testResult.model})</span>
              {testResult.capabilities && (
                <small>
                  能力：流式 {formatCapability(testResult.capabilities.streaming)} / 视觉 {formatCapability(testResult.capabilities.vision)} / 工具 {formatCapability(testResult.capabilities.toolCalling)} / JSON {formatCapability(testResult.capabilities.jsonMode)}
                </small>
              )}
              {testResult.warnings && testResult.warnings.length > 0 && (
                <pre>{testResult.warnings.join("\n")}</pre>
              )}
            </div>
          ) : (
            <div>
              <span>连接失败: {testResult.errorType}</span>
              {testResult.error && <pre>{testResult.error}</pre>}
            </div>
          )}
        </div>
      )}

      {error && (
        <div className="model-provider-test-error" role="alert">
          {error}
        </div>
      )}

      <div className="model-provider-form-actions">
        <button type="button" onClick={onCancel} disabled={saving}>
          取消
        </button>
        {onTest && (
          <button
            type="button"
            onClick={handleTest}
            disabled={testing || !baseUrl.trim() || !model.trim() || (needsApiKey && !apiKey.trim())}
          >
            {testing ? "测试中..." : "测试连接"}
          </button>
        )}
        <button
          type="button"
          className="model-provider-form-save"
          onClick={handleSave}
          disabled={!canSave || saving}
        >
          {saving ? "保存中..." : "保存并继续"}
        </button>
      </div>
    </div>
  );
}
