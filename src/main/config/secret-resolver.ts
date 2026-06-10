import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { safeStorage } from "electron";

const CONFIG_DIR = path.join(os.homedir(), ".agenthub");
const SECRETS_FILE = path.join(CONFIG_DIR, "secrets.enc");

let cachedSecrets: Record<string, string> | null = null;

function isEncryptionAvailable(): boolean {
  return safeStorage?.isEncryptionAvailable?.() === true;
}

function ensureConfigDir(): void {
  if (!fs.existsSync(CONFIG_DIR)) {
    fs.mkdirSync(CONFIG_DIR, { recursive: true });
  }
}

export function loadSecrets(): Record<string, string> {
  if (cachedSecrets) {
    return cachedSecrets;
  }

  if (!fs.existsSync(SECRETS_FILE)) {
    cachedSecrets = {};
    return cachedSecrets;
  }

  try {
    const encryptedBase64 = fs.readFileSync(SECRETS_FILE, "utf-8");
    const encryptedBuffer = Buffer.from(encryptedBase64, "base64");

    if (isEncryptionAvailable()) {
      const decrypted = safeStorage.decryptString(encryptedBuffer);
      cachedSecrets = JSON.parse(decrypted);
    } else {
      console.warn("[AgentHub] safeStorage encryption not available, secrets cannot be loaded.");
      cachedSecrets = {};
    }
  } catch (error) {
    console.warn("[AgentHub] Failed to load secrets:", error);
    cachedSecrets = {};
  }

  return cachedSecrets!;
}

export function saveSecrets(secrets: Record<string, string>): void {
  ensureConfigDir();
  cachedSecrets = secrets;

  if (!isEncryptionAvailable()) {
    throw new Error("safeStorage encryption is not available on this system.");
  }

  const encrypted = safeStorage.encryptString(JSON.stringify(secrets));
  fs.writeFileSync(SECRETS_FILE, encrypted.toString("base64"), "utf-8");
}

export function setSecret(key: string, value: string): void {
  const secrets = loadSecrets();
  secrets[key] = value;
  saveSecrets(secrets);
}

export function getSecret(key: string): string | undefined {
  const secrets = loadSecrets();
  return secrets[key];
}

export function deleteSecret(key: string): void {
  const secrets = loadSecrets();
  if (!(key in secrets)) return;

  delete secrets[key];
  saveSecrets(secrets);
}

export function resolveApiKey(
  apiKeyRef: string | undefined,
  providerId?: string
): string | undefined {
  if (!apiKeyRef && !providerId) {
    return undefined;
  }

  // Direct reference: "secret:provider-id"
  if (apiKeyRef?.startsWith("secret:")) {
    const secretKey = apiKeyRef.slice("secret:".length);
    return getSecret(secretKey);
  }

  // Environment variable reference: "env:VAR_NAME"
  if (apiKeyRef?.startsWith("env:")) {
    const envVar = apiKeyRef.slice("env:".length);
    return process.env[envVar];
  }

  // If apiKeyRef looks like a direct API key string (legacy compat)
  if (apiKeyRef && !apiKeyRef.includes(":")) {
    return apiKeyRef;
  }

  // Fallback: try to find by providerId in secrets
  if (providerId) {
    const secret = getSecret(`provider:${providerId}`);
    if (secret) return secret;
  }

  return apiKeyRef;
}

export function migratePlaintextApiKey(
  apiKey: string,
  providerId: string
): void {
  if (!apiKey || apiKey.trim().length === 0) return;
  setSecret(`provider:${providerId}`, apiKey);
}
