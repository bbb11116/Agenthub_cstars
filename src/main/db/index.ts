import Database from "better-sqlite3";
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import type { App } from "electron";
import { initializeSchema } from "./schema";

export type AgentHubDatabase = ReturnType<typeof Database>;

type InitializeDatabaseOptions = {
  dbPath?: string;
};

export class DatabaseInitializationError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "DatabaseInitializationError";
  }
}

let currentDatabase: AgentHubDatabase | null = null;
const require = createRequire(import.meta.url);

function getElectronApp(): App {
  const electronModule = require("electron") as { app?: App };

  if (!electronModule.app) {
    throw new DatabaseInitializationError("Electron app is unavailable for database path lookup");
  }

  return electronModule.app;
}

export function getDefaultDatabasePath(): string {
  return path.join(getElectronApp().getPath("userData"), "agenthub.db");
}

export function initializeDatabase(options: InitializeDatabaseOptions = {}): AgentHubDatabase {
  const dbPath = options.dbPath ?? getDefaultDatabasePath();

  if (currentDatabase?.open && currentDatabase.name === dbPath) {
    return currentDatabase;
  }

  if (currentDatabase?.open) {
    currentDatabase.close();
    currentDatabase = null;
  }

  try {
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    const database = new Database(dbPath);

    database.pragma("journal_mode = WAL");
    database.pragma("foreign_keys = ON");
    initializeSchema(database);

    currentDatabase = database;
    return database;
  } catch (error) {
    throw new DatabaseInitializationError(`Failed to initialize SQLite database at ${dbPath}`, {
      cause: error
    });
  }
}

export function getDatabase(): AgentHubDatabase {
  return currentDatabase?.open ? currentDatabase : initializeDatabase();
}

export function closeDatabase(): void {
  if (currentDatabase?.open) {
    currentDatabase.close();
  }

  currentDatabase = null;
}

export function stringifyJsonField(value: unknown): string {
  return JSON.stringify(value ?? null);
}

export function parseJsonField<T>(value: string, fallback: T, label: string): T {
  try {
    return JSON.parse(value) as T;
  } catch (error) {
    console.warn(`Failed to parse JSON field "${label}". Using fallback value.`, error);
    return fallback;
  }
}
