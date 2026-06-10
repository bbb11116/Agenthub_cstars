import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import type {
  GlobalSettings,
  WorkspaceSettings,
  WorkspaceLocalSettings,
  AgentFileDefinition,
  ModelProviderConfig
} from "./agenthub-config-schema";
import { resolveApiKey, migratePlaintextApiKey } from "./secret-resolver";
import { createWorkspacePathGuard } from "../utils/pathGuard";
import {
  createConfiguredProviderCapabilities,
  createModelProviderLimits,
  normalizeModelProviderLimits,
  normalizeProviderCapabilities
} from "../../shared/modelProvider";
import { AGENT_EXECUTION_LIMITS } from "../../shared/agentExecution";

const GLOBAL_CONFIG_DIR = path.join(os.homedir(), ".agenthub");
const GLOBAL_SETTINGS_FILE = path.join(GLOBAL_CONFIG_DIR, "settings.json");
const LEGACY_CONFIG_FILE = path.join(GLOBAL_CONFIG_DIR, "config.json");

function readJsonFile(filePath: string): unknown | null {
  if (!fs.existsSync(filePath)) return null;
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf-8"));
  } catch {
    console.warn(`[AgentHub] Failed to parse ${filePath}`);
    return null;
  }
}

function writeJsonFile(filePath: string, data: unknown): void {
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2) + "\n", "utf-8");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const DEFAULT_GLOBAL_SETTINGS: GlobalSettings = {
  version: 1,
  modelProviders: [],
  defaults: {}
};

const DEFAULT_WORKSPACE_SETTINGS: WorkspaceSettings = {
  version: 1,
  workspace: {},
  mainAgent: {},
  groupChat: {
    executionMode: "sequential",
    maxRecentMessages: 20,
    mainAgentCanWriteFiles: false,
    continueOnAgentFailure: true,
    subagentMaxIterations: AGENT_EXECUTION_LIMITS.groupSubagentMaxIterations,
    maxRedispatchRounds: AGENT_EXECUTION_LIMITS.groupMaxRedispatchRounds,
    maxAgentsPerRound: AGENT_EXECUTION_LIMITS.groupMaxAgentsPerRound,
    orchestratorReviewMaxIterations:
      AGENT_EXECUTION_LIMITS.orchestratorReviewMaxIterations
  },
  agentDefaults: {
    provider: "codex_local",
    tools: ["read_file", "write_diff", "preview_artifact"],
    requireDiffProposal: false,
    requireUserConfirmBeforeApply: false
  }
};

function migrateProviderFields(raw: Record<string, unknown>): {
  settings: GlobalSettings;
  changed: boolean;
} {
  const settings = { ...raw } as Record<string, unknown>;
  let changed = false;

  if (!Array.isArray(settings.modelProviders)) {
    return {
      settings: settings as unknown as GlobalSettings,
      changed
    };
  }

  const defaults = isRecord(settings.defaults) ? settings.defaults as Record<string, unknown> : {};
  const defaultProviderId = typeof defaults.mainAgentProviderId === "string"
    ? defaults.mainAgentProviderId
    : undefined;

  const migratedProviders: ModelProviderConfig[] = (settings.modelProviders as Array<Record<string, unknown>>).map((p) => {
    const provider = { ...p };

    // Migrate type -> apiFormat
    if (typeof provider.type === "string" && typeof provider.apiFormat !== "string") {
      const typeMap: Record<string, string> = {
        openai_compatible: "openai_chat_completions",
        anthropic_compatible: "anthropic_messages"
      };
      provider.apiFormat = typeMap[provider.type] ?? provider.type;
      delete provider.type;
      changed = true;
    }

    // Migrate defaultModel -> model
    if (typeof provider.defaultModel === "string" && typeof provider.model !== "string") {
      provider.model = provider.defaultModel;
      delete provider.defaultModel;
      changed = true;
    }

    // Migrate legacy plaintext apiKey
    if (typeof provider.apiKey === "string" && provider.apiKey.length > 0) {
      const id = typeof provider.id === "string" ? provider.id : "unknown";
      migratePlaintextApiKey(provider.apiKey as string, id);
      provider.apiKeyRef = `secret:provider:${id}`;
      delete provider.apiKey;
      changed = true;
    }

    // Set defaults for new fields
    if (typeof provider.name !== "string") {
      provider.name = typeof provider.id === "string" ? provider.id : "default";
      changed = true;
    }
    if (typeof provider.isFullUrl !== "boolean") {
      provider.isFullUrl = false;
      changed = true;
    }
    if (typeof provider.supportsVision !== "boolean") {
      provider.supportsVision = false;
      changed = true;
    }
    if (typeof provider.supportsStreaming !== "boolean") {
      provider.supportsStreaming = true;
      changed = true;
    }
    if (typeof provider.isDefaultForMainAgent !== "boolean") {
      provider.isDefaultForMainAgent = provider.id === defaultProviderId;
      changed = true;
    }
    if (typeof provider.apiKeyRef !== "string") {
      provider.apiKeyRef = "";
      changed = true;
    }
    if (typeof provider.createdAt !== "string") {
      provider.createdAt = new Date().toISOString();
      changed = true;
    }
    if (typeof provider.updatedAt !== "string") {
      provider.updatedAt = new Date().toISOString();
      changed = true;
    }
    const normalizedLimits = normalizeModelProviderLimits(
      isRecord(provider.limits)
        ? provider.limits
        : undefined
    );
    if (
      !isRecord(provider.limits) ||
      provider.limits.contextWindowTokens !== normalizedLimits.contextWindowTokens ||
      provider.limits.maxOutputTokens !== normalizedLimits.maxOutputTokens ||
      provider.limits.hardMaxOutputTokens !== normalizedLimits.hardMaxOutputTokens ||
      provider.limits.source !== normalizedLimits.source
    ) {
      provider.limits = normalizedLimits;
      changed = true;
    }
    const normalizedCapabilities = normalizeProviderCapabilities(
      isRecord(provider.capabilities)
        ? provider.capabilities
        : createConfiguredProviderCapabilities({
            supportsVision: provider.supportsVision === true,
            supportsStreaming: provider.supportsStreaming !== false,
            limits: normalizedLimits
          }),
      {
        supportsVision: provider.supportsVision === true,
        supportsStreaming: provider.supportsStreaming !== false,
        limits: normalizedLimits
      }
    );
    if (
      !isRecord(provider.capabilities) ||
      provider.capabilities.chat !== normalizedCapabilities.chat ||
      provider.capabilities.streaming !== normalizedCapabilities.streaming ||
      provider.capabilities.vision !== normalizedCapabilities.vision ||
      provider.capabilities.toolCalling !== normalizedCapabilities.toolCalling ||
      provider.capabilities.jsonMode !== normalizedCapabilities.jsonMode ||
      provider.capabilities.contextWindowTokens !== normalizedCapabilities.contextWindowTokens ||
      provider.capabilities.maxOutputTokens !== normalizedCapabilities.maxOutputTokens ||
      provider.capabilities.source !== normalizedCapabilities.source
    ) {
      provider.capabilities = normalizedCapabilities;
      changed = true;
    }

    return provider as unknown as ModelProviderConfig;
  });

  return {
    settings: {
      version: 1,
      modelProviders: migratedProviders,
      defaults: settings.defaults as GlobalSettings["defaults"]
    },
    changed
  };
}

export function loadGlobalSettings(): GlobalSettings {
  const raw = readJsonFile(GLOBAL_SETTINGS_FILE);

  if (raw && isRecord(raw) && raw.version === 1) {
    const migrated = migrateProviderFields(raw);
    if (migrated.changed) {
      writeJsonFile(GLOBAL_SETTINGS_FILE, migrated.settings);
    }
    return migrated.settings;
  }

  // Fall back to legacy config.json
  const legacy = readJsonFile(LEGACY_CONFIG_FILE);
  if (legacy && isRecord(legacy) && "mainAgent" in legacy) {
    const mainAgent = legacy.mainAgent;
    if (isRecord(mainAgent) && typeof mainAgent.provider === "string" && typeof mainAgent.apiKey === "string") {
      const providerId = `legacy-${mainAgent.provider}`;
      migratePlaintextApiKey(mainAgent.apiKey, providerId);

      const apiFormat = mainAgent.provider === "anthropic_compatible"
        ? "anthropic_messages"
        : "openai_chat_completions";

      const migrated: GlobalSettings = {
        version: 1,
        modelProviders: [
          {
            id: providerId,
            name: providerId,
            apiFormat,
            baseUrl: typeof mainAgent.baseUrl === "string" ? mainAgent.baseUrl : "",
            isFullUrl: false,
            apiKeyRef: `secret:provider:${providerId}`,
            model: typeof mainAgent.model === "string" ? mainAgent.model : "",
            supportsVision: false,
            supportsStreaming: true,
            isDefaultForMainAgent: true,
            limits: createModelProviderLimits(false),
            capabilities: createConfiguredProviderCapabilities({
              supportsVision: false,
              supportsStreaming: true,
              limits: createModelProviderLimits(false)
            }),
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString()
          }
        ],
        defaults: {
          mainAgentProviderId: providerId
        }
      };

      writeJsonFile(GLOBAL_SETTINGS_FILE, migrated);
      return migrated;
    }
  }

  // No config found — auto-generate default
  writeJsonFile(GLOBAL_SETTINGS_FILE, DEFAULT_GLOBAL_SETTINGS);
  return DEFAULT_GLOBAL_SETTINGS;
}

export function saveGlobalSettings(settings: GlobalSettings): void {
  writeJsonFile(GLOBAL_SETTINGS_FILE, settings);
}

export function loadWorkspaceSettings(rootPath: string): WorkspaceSettings {
  const filePath = path.join(rootPath, ".agenthub", "settings.json");
  const raw = readJsonFile(filePath);

  if (raw && isRecord(raw) && raw.version === 1) {
    return raw as WorkspaceSettings;
  }

  writeJsonFile(filePath, DEFAULT_WORKSPACE_SETTINGS);
  return DEFAULT_WORKSPACE_SETTINGS;
}

export function loadWorkspaceLocalSettings(rootPath: string): WorkspaceLocalSettings {
  const filePath = path.join(rootPath, ".agenthub", "settings.local.json");
  const raw = readJsonFile(filePath);

  if (raw && isRecord(raw)) {
    return raw as WorkspaceLocalSettings;
  }

  return {};
}

export function loadAgentFilesFromWorkspace(rootPath: string): AgentFileDefinition[] {
  const agentsDir = path.join(rootPath, ".agenthub", "agents");

  if (!fs.existsSync(agentsDir)) return [];

  const files = fs.readdirSync(agentsDir).filter((f) => f.endsWith(".agent.json"));
  const agents: AgentFileDefinition[] = [];

  for (const file of files) {
    const filePath = path.join(agentsDir, file);
    const raw = readJsonFile(filePath);
    if (!raw || !isRecord(raw)) continue;

    if (typeof raw.name !== "string" || raw.name.trim().length === 0) continue;
    if (typeof raw.provider !== "string") continue;

    let systemPrompt: string | undefined;
    if (typeof raw.systemPrompt === "string") {
      systemPrompt = raw.systemPrompt;
    } else if (typeof raw.systemPromptPath === "string") {
      systemPrompt = loadPromptFile(raw.systemPromptPath, rootPath);
    }

    agents.push({
      version: 1,
      name: raw.name.trim(),
      type: "specialist",
      provider: raw.provider as AgentFileDefinition["provider"],
      description: typeof raw.description === "string" ? raw.description : undefined,
      systemPromptPath: typeof raw.systemPromptPath === "string" ? raw.systemPromptPath : undefined,
      systemPrompt,
      tools: Array.isArray(raw.tools) ? raw.tools : [],
      capabilityTags: Array.isArray(raw.capabilityTags) ? raw.capabilityTags : undefined,
      requireDiffProposal: raw.requireDiffProposal === true
    });
  }

  return agents;
}

export function loadPromptFile(promptPath: string, rootPath: string): string | undefined {
  let fullPath: string;

  try {
    const guard = createWorkspacePathGuard(rootPath);
    fullPath = guard.resolve(promptPath).absolutePath;
    guard.assertInside(fullPath);
  } catch {
    console.warn(`[AgentHub] Refusing to load prompt outside workspace: ${promptPath}`);
    return undefined;
  }

  if (!fs.existsSync(fullPath)) return undefined;

  try {
    return fs.readFileSync(fullPath, "utf-8").trim();
  } catch {
    return undefined;
  }
}

export function resolveProviderApiKey(
  providerId: string | undefined,
  modelProviders: ModelProviderConfig[]
): string | undefined {
  if (!providerId) return undefined;

  const provider = modelProviders.find((p) => p.id === providerId);
  if (!provider) return undefined;

  return resolveApiKey(provider.apiKeyRef, provider.id);
}
