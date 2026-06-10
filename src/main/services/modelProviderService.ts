import crypto from "node:crypto";
import type {
  ModelProviderConfig,
  GlobalSettings
} from "../config/agenthub-config-schema";
import { loadGlobalSettings, saveGlobalSettings } from "../config/agenthub-config-loader";
import { deleteSecret, setSecret, getSecret, resolveApiKey } from "../config/secret-resolver";
import { clearConfigCache } from "./configService";
import type {
  ModelProviderListItem,
  SaveModelProviderInput,
  TestConnectionResult
} from "../../shared/types";
import {
  createConfiguredProviderCapabilities,
  createModelProviderLimits,
  normalizeModelProviderLimits,
  normalizeProviderCapabilities,
  type ModelProviderApiFormat,
  type ModelProviderLimits,
  type ProviderCapabilities,
  type ProviderCapabilityStatus
} from "../../shared/modelProvider";

const TEST_TIMEOUT_MS = 15_000;
const CAPABILITY_PROBE_TIMEOUT_MS = 8_000;
const TINY_PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=";

function getSecretKeyForProvider(providerId: string): string {
  return `provider:${providerId}`;
}

export function resolveEndpoint(input: {
  apiFormat: ModelProviderApiFormat;
  baseUrl: string;
  isFullUrl: boolean;
}): string {
  const baseUrl = input.baseUrl.replace(/\/+$/, "");

  if (input.isFullUrl) {
    return baseUrl;
  }

  if (input.apiFormat === "openai_chat_completions") {
    if (baseUrl.endsWith("/v1")) {
      return `${baseUrl}/chat/completions`;
    }
    return `${baseUrl}/v1/chat/completions`;
  }

  // anthropic_messages
  if (baseUrl.endsWith("/v1")) {
    return `${baseUrl}/messages`;
  }
  return `${baseUrl}/v1/messages`;
}

function providerToListItem(p: ModelProviderConfig): ModelProviderListItem {
  const secretKey = getSecretKeyForProvider(p.id);
  const hasApiKey = !!getSecret(secretKey) || p.apiKeyRef.startsWith("env:");
  const limits = normalizeModelProviderLimits(p.limits);
  const capabilities = normalizeProviderCapabilities(p.capabilities, {
    supportsVision: p.supportsVision,
    supportsStreaming: p.supportsStreaming,
    limits
  });

  return {
    id: p.id,
    name: p.name,
    apiFormat: p.apiFormat,
    baseUrl: p.baseUrl,
    isFullUrl: p.isFullUrl,
    model: p.model,
    supportsVision: p.supportsVision,
    supportsStreaming: p.supportsStreaming,
    capabilities,
    isDefaultForMainAgent: p.isDefaultForMainAgent,
    limits,
    hasApiKey,
    createdAt: p.createdAt,
    updatedAt: p.updatedAt
  };
}

export function listProviders(): ModelProviderListItem[] {
  const settings = loadGlobalSettings();
  return (settings.modelProviders ?? []).map(providerToListItem);
}

export function getProvider(id: string): ModelProviderListItem | null {
  const settings = loadGlobalSettings();
  const provider = settings.modelProviders?.find((p) => p.id === id);
  return provider ? providerToListItem(provider) : null;
}

function resolveCapabilityBoolean(
  status: ProviderCapabilityStatus,
  fallback: boolean
): boolean {
  if (status === "supported") return true;
  if (status === "unsupported") return false;
  return fallback;
}

function createManualCapabilities(input: {
  supportsVision: boolean;
  supportsStreaming: boolean;
  limits: ModelProviderLimits;
  capabilities?: ProviderCapabilities;
}): ProviderCapabilities {
  return normalizeProviderCapabilities(
    input.capabilities ?? createConfiguredProviderCapabilities({
      supportsVision: input.supportsVision,
      supportsStreaming: input.supportsStreaming,
      limits: input.limits
    }),
    {
      supportsVision: input.supportsVision,
      supportsStreaming: input.supportsStreaming,
      limits: input.limits
    }
  );
}

export async function saveProvider(input: SaveModelProviderInput): Promise<ModelProviderListItem> {
  const settings = loadGlobalSettings();
  const now = new Date().toISOString();
  const isUpdate = !!input.id;
  const id = input.id ?? crypto.randomUUID();

  // Store API key if provided
  if (input.apiKey && input.apiKey.length > 0) {
    const secretKey = getSecretKeyForProvider(id);
    setSecret(secretKey, input.apiKey);
  }

  const apiKeyRef = `secret:provider:${id}`;

  // If setting as default, clear other defaults
  if (input.isDefaultForMainAgent) {
    for (const p of settings.modelProviders ?? []) {
      if (p.id !== id) {
        p.isDefaultForMainAgent = false;
      }
    }
  }

  const existing = settings.modelProviders?.find((p) => p.id === id);
  const existingLimits = normalizeModelProviderLimits(existing?.limits);
  const limits: ModelProviderLimits = {
    ...createModelProviderLimits(input.enableOneMillionContext),
    maxOutputTokens: existingLimits.maxOutputTokens,
    ...(existingLimits.hardMaxOutputTokens
      ? { hardMaxOutputTokens: existingLimits.hardMaxOutputTokens }
      : {})
  };
  let capabilities = createManualCapabilities({
    supportsVision: input.supportsVision,
    supportsStreaming: input.supportsStreaming,
    limits,
    capabilities: input.capabilities
  });

  try {
    const probe = await testConnection({
      ...input,
      id
    });
    if (probe.ok && probe.capabilities) {
      capabilities = normalizeProviderCapabilities(probe.capabilities, {
        supportsVision: input.supportsVision,
        supportsStreaming: input.supportsStreaming,
        limits
      });
    }
  } catch {
    // Saving provider configuration should not depend on optional capability probes.
  }

  const provider: ModelProviderConfig = {
    id,
    name: input.name,
    apiFormat: input.apiFormat,
    baseUrl: input.baseUrl,
    isFullUrl: input.isFullUrl,
    model: input.model,
    apiKeyRef,
    supportsVision: resolveCapabilityBoolean(capabilities.vision, input.supportsVision),
    supportsStreaming: resolveCapabilityBoolean(capabilities.streaming, input.supportsStreaming),
    capabilities,
    isDefaultForMainAgent: input.isDefaultForMainAgent,
    limits,
    createdAt: existing?.createdAt ?? now,
    updatedAt: now
  };

  if (!settings.modelProviders) {
    settings.modelProviders = [];
  }

  if (isUpdate) {
    const idx = settings.modelProviders.findIndex((p) => p.id === id);
    if (idx >= 0) {
      settings.modelProviders[idx] = provider;
    } else {
      settings.modelProviders.push(provider);
    }
  } else {
    settings.modelProviders.push(provider);
  }

  // Update defaults.mainAgentProviderId for backward compat
  if (input.isDefaultForMainAgent) {
    if (!settings.defaults) settings.defaults = {};
    settings.defaults.mainAgentProviderId = id;
  }

  saveGlobalSettings(settings);
  clearConfigCache();
  return providerToListItem(provider);
}

export function deleteProvider(id: string): boolean {
  const settings = loadGlobalSettings();
  const idx = settings.modelProviders?.findIndex((p) => p.id === id) ?? -1;
  if (idx < 0) return false;

  settings.modelProviders!.splice(idx, 1);

  // Clear default if it was this provider
  if (settings.defaults?.mainAgentProviderId === id) {
    settings.defaults.mainAgentProviderId = undefined;
  }

  saveGlobalSettings(settings);
  deleteSecret(getSecretKeyForProvider(id));
  clearConfigCache();
  return true;
}

export function hasAnyProvider(): boolean {
  const settings = loadGlobalSettings();
  return (settings.modelProviders ?? []).length > 0;
}

function classifyHttpError(status: number): TestConnectionResult["errorType"] {
  if (status === 401 || status === 403) return "UNAUTHORIZED";
  if (status === 404) return "NOT_FOUND";
  if (status === 400) return "BAD_REQUEST";
  if (status === 429) return "RATE_LIMITED";
  return "UNKNOWN_ERROR";
}

function getTestLimits(input: SaveModelProviderInput): ModelProviderLimits {
  return createModelProviderLimits(input.enableOneMillionContext);
}

function createProbeCapabilities(input: {
  supportsVision: boolean;
  supportsStreaming: boolean;
  limits: ModelProviderLimits;
  chat: ProviderCapabilityStatus;
  streaming: ProviderCapabilityStatus;
  vision: ProviderCapabilityStatus;
  toolCalling: ProviderCapabilityStatus;
  jsonMode: ProviderCapabilityStatus;
  warnings: string[];
}): ProviderCapabilities {
  return normalizeProviderCapabilities(
    {
      chat: input.chat,
      streaming: input.streaming,
      vision: input.vision,
      toolCalling: input.toolCalling,
      jsonMode: input.jsonMode,
      contextWindowTokens: input.limits.contextWindowTokens,
      maxOutputTokens: input.limits.maxOutputTokens,
      source: "connection_probe",
      detectedAt: new Date().toISOString(),
      notes: [
        "contextWindowTokens and maxOutputTokens come from AgentHub configuration.",
        ...input.warnings
      ]
    },
    {
      supportsVision: input.supportsVision,
      supportsStreaming: input.supportsStreaming,
      limits: input.limits
    }
  );
}

async function fetchWithTimeout(
  url: string,
  init: RequestInit,
  timeoutMs = CAPABILITY_PROBE_TIMEOUT_MS
): Promise<Response> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, {
      ...init,
      signal: controller.signal
    });
  } finally {
    clearTimeout(timeout);
  }
}

async function readResponseText(response: Response): Promise<string> {
  return response.text().catch(() => "");
}

async function probeCapability(
  label: string,
  warnings: string[],
  fn: () => Promise<ProviderCapabilityStatus>
): Promise<ProviderCapabilityStatus> {
  try {
    return await fn();
  } catch (error) {
    warnings.push(`${label} probe failed: ${error instanceof Error ? error.message : "unknown error"}`);
    return "unknown";
  }
}

function openAIHeaders(apiKey: string): Record<string, string> {
  return {
    "Content-Type": "application/json",
    Authorization: `Bearer ${apiKey}`
  };
}

function anthropicHeaders(apiKey: string): Record<string, string> {
  return {
    "Content-Type": "application/json",
    "x-api-key": apiKey,
    "anthropic-version": "2023-06-01"
  };
}

async function probeOpenAIStreaming(
  endpoint: string,
  model: string,
  apiKey: string,
  warnings: string[]
): Promise<ProviderCapabilityStatus> {
  const response = await fetchWithTimeout(endpoint, {
    method: "POST",
    headers: openAIHeaders(apiKey),
    body: JSON.stringify({
      model,
      messages: [{ role: "user", content: "ping" }],
      temperature: 0,
      max_completion_tokens: 8,
      stream: true,
      stream_options: { include_usage: true }
    })
  });
  if (!response.ok) {
    warnings.push(`streaming probe returned HTTP ${response.status}: ${(await readResponseText(response)).slice(0, 180)}`);
    return "unsupported";
  }
  if (!response.body) {
    return "unsupported";
  }
  const reader = response.body.getReader();
  try {
    const { done, value } = await reader.read();
    return !done && value && value.byteLength > 0 ? "supported" : "unknown";
  } finally {
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}

async function probeOpenAIJsonMode(
  endpoint: string,
  model: string,
  apiKey: string,
  warnings: string[]
): Promise<ProviderCapabilityStatus> {
  const response = await fetchWithTimeout(endpoint, {
    method: "POST",
    headers: openAIHeaders(apiKey),
    body: JSON.stringify({
      model,
      messages: [{ role: "user", content: "Return {\"ok\":true} as a JSON object." }],
      temperature: 0,
      max_completion_tokens: 32,
      response_format: { type: "json_object" },
      stream: false
    })
  });
  if (!response.ok) {
    warnings.push(`json mode probe returned HTTP ${response.status}: ${(await readResponseText(response)).slice(0, 180)}`);
    return "unsupported";
  }
  const data = await response.json() as {
    choices?: Array<{ message?: { content?: string } }>;
  };
  const content = data.choices?.[0]?.message?.content;
  if (!content) return "unknown";
  try {
    JSON.parse(content);
    return "supported";
  } catch {
    return "unknown";
  }
}

async function probeOpenAIToolCalling(
  endpoint: string,
  model: string,
  apiKey: string,
  warnings: string[]
): Promise<ProviderCapabilityStatus> {
  const response = await fetchWithTimeout(endpoint, {
    method: "POST",
    headers: openAIHeaders(apiKey),
    body: JSON.stringify({
      model,
      messages: [{ role: "user", content: "Call ping_tool." }],
      temperature: 0,
      max_completion_tokens: 32,
      tools: [
        {
          type: "function",
          function: {
            name: "ping_tool",
            description: "Return pong.",
            parameters: {
              type: "object",
              properties: {},
              additionalProperties: false
            }
          }
        }
      ],
      tool_choice: { type: "function", function: { name: "ping_tool" } },
      stream: false
    })
  });
  if (!response.ok) {
    warnings.push(`tool calling probe returned HTTP ${response.status}: ${(await readResponseText(response)).slice(0, 180)}`);
    return "unsupported";
  }
  const data = await response.json() as {
    choices?: Array<{ message?: { tool_calls?: unknown[] } }>;
  };
  return Array.isArray(data.choices?.[0]?.message?.tool_calls)
    ? "supported"
    : "unknown";
}

async function probeOpenAIVision(
  endpoint: string,
  model: string,
  apiKey: string,
  warnings: string[]
): Promise<ProviderCapabilityStatus> {
  const response = await fetchWithTimeout(endpoint, {
    method: "POST",
    headers: openAIHeaders(apiKey),
    body: JSON.stringify({
      model,
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: "Reply with one word after inspecting the image." },
            {
              type: "image_url",
              image_url: { url: `data:image/png;base64,${TINY_PNG_BASE64}` }
            }
          ]
        }
      ],
      temperature: 0,
      max_completion_tokens: 8,
      stream: false
    })
  });
  if (!response.ok) {
    warnings.push(`vision probe returned HTTP ${response.status}: ${(await readResponseText(response)).slice(0, 180)}`);
    return "unsupported";
  }
  const data = await response.json() as {
    choices?: Array<{ message?: { content?: string } }>;
  };
  return data.choices?.[0]?.message?.content ? "supported" : "unknown";
}

async function probeAnthropicStreaming(
  endpoint: string,
  model: string,
  apiKey: string,
  warnings: string[]
): Promise<ProviderCapabilityStatus> {
  const response = await fetchWithTimeout(endpoint, {
    method: "POST",
    headers: anthropicHeaders(apiKey),
    body: JSON.stringify({
      model,
      max_tokens: 8,
      messages: [{ role: "user", content: "ping" }],
      stream: true
    })
  });
  if (!response.ok) {
    warnings.push(`streaming probe returned HTTP ${response.status}: ${(await readResponseText(response)).slice(0, 180)}`);
    return "unsupported";
  }
  if (!response.body) {
    return "unsupported";
  }
  const reader = response.body.getReader();
  try {
    const { done, value } = await reader.read();
    return !done && value && value.byteLength > 0 ? "supported" : "unknown";
  } finally {
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}

async function probeAnthropicToolCalling(
  endpoint: string,
  model: string,
  apiKey: string,
  warnings: string[]
): Promise<ProviderCapabilityStatus> {
  const response = await fetchWithTimeout(endpoint, {
    method: "POST",
    headers: anthropicHeaders(apiKey),
    body: JSON.stringify({
      model,
      max_tokens: 64,
      messages: [{ role: "user", content: "Call ping_tool." }],
      tools: [
        {
          name: "ping_tool",
          description: "Return pong.",
          input_schema: {
            type: "object",
            properties: {},
            additionalProperties: false
          }
        }
      ],
      tool_choice: { type: "tool", name: "ping_tool" }
    })
  });
  if (!response.ok) {
    warnings.push(`tool calling probe returned HTTP ${response.status}: ${(await readResponseText(response)).slice(0, 180)}`);
    return "unsupported";
  }
  const data = await response.json() as {
    content?: Array<{ type?: string }>;
  };
  return data.content?.some((block) => block.type === "tool_use") ? "supported" : "unknown";
}

async function probeAnthropicVision(
  endpoint: string,
  model: string,
  apiKey: string,
  warnings: string[]
): Promise<ProviderCapabilityStatus> {
  const response = await fetchWithTimeout(endpoint, {
    method: "POST",
    headers: anthropicHeaders(apiKey),
    body: JSON.stringify({
      model,
      max_tokens: 8,
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: "Reply with one word after inspecting the image." },
            {
              type: "image",
              source: {
                type: "base64",
                media_type: "image/png",
                data: TINY_PNG_BASE64
              }
            }
          ]
        }
      ]
    })
  });
  if (!response.ok) {
    warnings.push(`vision probe returned HTTP ${response.status}: ${(await readResponseText(response)).slice(0, 180)}`);
    return "unsupported";
  }
  const data = await response.json() as {
    content?: Array<{ type?: string; text?: string }>;
  };
  return data.content?.some((block) => block.type === "text" && block.text) ? "supported" : "unknown";
}

async function testOpenAI(
  endpoint: string,
  model: string,
  apiKey: string,
  input: SaveModelProviderInput
): Promise<TestConnectionResult> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), TEST_TIMEOUT_MS);
  const start = Date.now();
  const warnings: string[] = [];

  try {
    const response = await fetch(endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`
      },
      body: JSON.stringify({
        model,
        messages: [{ role: "user", content: "ping" }],
        temperature: 0,
        max_completion_tokens: 16,
        stream: false
      }),
      signal: controller.signal
    });

    const latencyMs = Date.now() - start;

    if (!response.ok) {
      const errorText = await response.text().catch(() => "");
      return {
        ok: false,
        errorType: classifyHttpError(response.status),
        error: `HTTP ${response.status}: ${errorText.slice(0, 300)}`
      };
    }

    const data = await response.json() as {
      choices?: Array<{ message?: { content?: string } }>;
    };

    if (!data.choices?.[0]?.message?.content) {
      return {
        ok: false,
        errorType: "RESPONSE_FORMAT_MISMATCH",
        error: "Response missing choices[0].message.content"
      };
    }

    const limits = getTestLimits(input);
    const streaming = input.supportsStreaming
      ? await probeCapability("streaming", warnings, () =>
          probeOpenAIStreaming(endpoint, model, apiKey, warnings)
        )
      : "unsupported";
    const jsonMode = await probeCapability("json mode", warnings, () =>
      probeOpenAIJsonMode(endpoint, model, apiKey, warnings)
    );
    const toolCalling = await probeCapability("tool calling", warnings, () =>
      probeOpenAIToolCalling(endpoint, model, apiKey, warnings)
    );
    const vision = input.supportsVision
      ? await probeCapability("vision", warnings, () =>
          probeOpenAIVision(endpoint, model, apiKey, warnings)
        )
      : "unsupported";
    const capabilities = createProbeCapabilities({
      supportsVision: input.supportsVision,
      supportsStreaming: input.supportsStreaming,
      limits,
      chat: "supported",
      streaming,
      vision,
      toolCalling,
      jsonMode,
      warnings
    });

    return {
      ok: true,
      latencyMs,
      model,
      capabilities,
      ...(warnings.length > 0 ? { warnings } : {})
    };
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") {
      return { ok: false, errorType: "NETWORK_ERROR", error: `Request timed out after ${TEST_TIMEOUT_MS / 1000}s` };
    }
    return {
      ok: false,
      errorType: "NETWORK_ERROR",
      error: error instanceof Error ? error.message : "Unknown network error"
    };
  } finally {
    clearTimeout(timeout);
  }
}

async function testAnthropic(
  endpoint: string,
  model: string,
  apiKey: string,
  input: SaveModelProviderInput
): Promise<TestConnectionResult> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), TEST_TIMEOUT_MS);
  const start = Date.now();
  const warnings: string[] = [];

  try {
    const response = await fetch(endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01"
      },
      body: JSON.stringify({
        model,
        max_tokens: 16,
        messages: [{ role: "user", content: "ping" }]
      }),
      signal: controller.signal
    });

    const latencyMs = Date.now() - start;

    if (!response.ok) {
      const errorText = await response.text().catch(() => "");
      return {
        ok: false,
        errorType: classifyHttpError(response.status),
        error: `HTTP ${response.status}: ${errorText.slice(0, 300)}`
      };
    }

    const data = await response.json() as {
      content?: Array<{ type?: string; text?: string }>;
    };

    if (!data.content?.[0]?.text) {
      return {
        ok: false,
        errorType: "RESPONSE_FORMAT_MISMATCH",
        error: "Response missing content[0].text"
      };
    }

    const limits = getTestLimits(input);
    const streaming = input.supportsStreaming
      ? await probeCapability("streaming", warnings, () =>
          probeAnthropicStreaming(endpoint, model, apiKey, warnings)
        )
      : "unsupported";
    const toolCalling = await probeCapability("tool calling", warnings, () =>
      probeAnthropicToolCalling(endpoint, model, apiKey, warnings)
    );
    const vision = input.supportsVision
      ? await probeCapability("vision", warnings, () =>
          probeAnthropicVision(endpoint, model, apiKey, warnings)
        )
      : "unsupported";
    warnings.push("json mode probe skipped: Anthropic Messages has no portable response_format field in AgentHub yet.");
    const capabilities = createProbeCapabilities({
      supportsVision: input.supportsVision,
      supportsStreaming: input.supportsStreaming,
      limits,
      chat: "supported",
      streaming,
      vision,
      toolCalling,
      jsonMode: "unknown",
      warnings
    });

    return {
      ok: true,
      latencyMs,
      model,
      capabilities,
      ...(warnings.length > 0 ? { warnings } : {})
    };
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") {
      return { ok: false, errorType: "NETWORK_ERROR", error: `Request timed out after ${TEST_TIMEOUT_MS / 1000}s` };
    }
    return {
      ok: false,
      errorType: "NETWORK_ERROR",
      error: error instanceof Error ? error.message : "Unknown network error"
    };
  } finally {
    clearTimeout(timeout);
  }
}

export async function testConnection(input: SaveModelProviderInput): Promise<TestConnectionResult> {
  const endpoint = resolveEndpoint({
    apiFormat: input.apiFormat,
    baseUrl: input.baseUrl,
    isFullUrl: input.isFullUrl
  });

  const apiKey = input.apiKey ?? "";

  if (!apiKey) {
    // Try to get the existing key if this is an update
    if (input.id) {
      const existingKey = resolveApiKey(`secret:provider:${input.id}`, input.id);
      if (existingKey) {
        return input.apiFormat === "openai_chat_completions"
          ? testOpenAI(endpoint, input.model, existingKey, input)
          : testAnthropic(endpoint, input.model, existingKey, input);
      }
    }
    return { ok: false, errorType: "UNAUTHORIZED", error: "API key is required" };
  }

  return input.apiFormat === "openai_chat_completions"
    ? testOpenAI(endpoint, input.model, apiKey, input)
    : testAnthropic(endpoint, input.model, apiKey, input);
}
