/**
 * @packageDocumentation
 * Initialises the SQLite database used for persisting all application state.
 * Uses bun:sqlite for zero-dependency, high-performance SQLite access.
 */
import { Database } from "bun:sqlite";
import fs from "node:fs";
import os from "node:os";
import { join } from "node:path";
import { logError, logInfo, logWarn } from "../logger";

let _db: Database | null = null;
let _dbPath: string | null = null;
let _vacuumInterval: ReturnType<typeof setInterval> | null = null;

function resolveDbPath(path?: string): string {
  if (path === ":memory:") {
    return path;
  }

  if (path) return path;

  const appData = join(os.homedir(), ".llamaforge");
  if (!fs.existsSync(appData)) {
    fs.mkdirSync(appData, { recursive: true });
  }
  return join(appData, "llamaforge.db");
}

/**
 * Closes and clears the current singleton database instance.
 */
export function resetDb(): void {
  // S3 fix: clear the incremental vacuum interval to prevent leaks
  if (_vacuumInterval !== null) {
    clearInterval(_vacuumInterval);
    _vacuumInterval = null;
  }
  if (_db) {
    _db.close();
    _db = null;
    _dbPath = null;
  }
}

/**
 * Returns the singleton Database instance, creating it if necessary.
 *
 * @param path - Optional explicit database file path. Defaults to `{USER_HOME}/.llamaforge/llamaforge.db`.
 * @returns The active {@link Database} instance.
 */
export function getDb(path?: string): Database {
  const resolvedPath = resolveDbPath(path);

  if (_db) {
    if (path === undefined) {
      return _db;
    }
    if (_dbPath === resolvedPath) {
      return _db;
    }
    resetDb();
  }

  // M5 fix: graceful handling of DB corruption — attempt recovery instead of dying
  try {
    _db = new Database(resolvedPath);
  } catch (err) {
    if (resolvedPath === ":memory:") {
      throw err; // Can't recover in-memory DBs
    }
    logError(
      `[db] Failed to open database at ${resolvedPath}. ` +
        `The file may be corrupted. Attempting recovery by creating a fresh database.`,
      err,
    );
    // Rename the corrupt file so the user can inspect it later
    const corruptPath = `${resolvedPath}.corrupt.${Date.now()}`;
    try {
      fs.renameSync(resolvedPath, corruptPath);
      logWarn(`[db] Corrupt database renamed to: ${corruptPath}`);
    } catch (renameErr) {
      logError(`[db] Could not rename corrupt database file:`, renameErr);
      throw new Error(
        `Database file is corrupted and cannot be recovered automatically. ` +
          `Original error: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    _db = new Database(resolvedPath);
  }
  _dbPath = resolvedPath;
  // Enable WAL mode for better concurrency and foreign keys
  _db.exec("PRAGMA journal_mode = WAL;");
  _db.exec("PRAGMA foreign_keys = ON;");
  _db.exec("PRAGMA busy_timeout = 5000;");
  _db.exec("PRAGMA auto_vacuum = INCREMENTAL;");
  _db.exec("PRAGMA incremental_vacuum;");

  // Every 10 minutes, vacuum 200 unused pages to reclaim space
  // S3 fix: store interval ID so resetDb() can clear it
  _vacuumInterval = setInterval(
    () => {
      if (_db) {
        try {
          _db.exec("PRAGMA incremental_vacuum(200)");
        } catch (err) {
          logError("Incremental vacuum failed:", err);
        }
      }
    },
    10 * 60 * 1000,
  );

  const currentVersion = _db.query<any, []>("PRAGMA user_version").get().user_version;
  const LATEST_DB_VERSION = 1;
  const MIGRATIONS: Array<(d: Database) => void> = [
    (_d: Database) => {
      // v0 -> v1: initial schema creation is handled by initDbSchema.
    },
  ];

  if (currentVersion > LATEST_DB_VERSION) {
    logWarn(
      `Database schema version ${currentVersion} is newer than supported version ${LATEST_DB_VERSION}. ` +
        "Proceeding in read-only compatibility mode.",
    );
    return _db;
  }

  if (currentVersion < LATEST_DB_VERSION) {
    logInfo(`Migrating database from version ${currentVersion} to ${LATEST_DB_VERSION}...`);
    try {
      _db.exec("BEGIN TRANSACTION;");
      for (let i = currentVersion; i < LATEST_DB_VERSION; i++) {
        if (MIGRATIONS[i]) MIGRATIONS[i](_db);
      }
      _db.exec(`PRAGMA user_version = ${LATEST_DB_VERSION};`);
      _db.exec("COMMIT;");
      logInfo(`Migration to version ${LATEST_DB_VERSION} complete.`);
    } catch (e) {
      _db.exec("ROLLBACK;");
      logError("Database migration failed:", e);
      throw e;
    }
  }

  return _db;
}

/**
 * Validates and initialises the database schema without caching the singleton instance.
 *
 * @param db - The {@link Database} instance to initialise.
 */
export function initDbSchema(db: Database): void {
  // Chat sessions
  db.run(`
    CREATE TABLE IF NOT EXISTS chats (
      id          TEXT PRIMARY KEY,
      name        TEXT NOT NULL DEFAULT 'New Chat',
      created_at  INTEGER NOT NULL,
      updated_at  INTEGER NOT NULL,
      parent_id   TEXT REFERENCES chats(id),
      is_branch   INTEGER NOT NULL DEFAULT 0,
      model_path  TEXT,
      system_preset_id TEXT,
      inference_preset_id TEXT
    );
  `);

  // Messages within a chat
  db.run(`
    CREATE TABLE IF NOT EXISTS messages (
      id              TEXT PRIMARY KEY,
      chat_id         TEXT NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
      role            TEXT NOT NULL CHECK(role IN ('system','user','assistant','tool')),
      content         TEXT NOT NULL,
      raw_content     TEXT NOT NULL,
      thinking_content TEXT,
      position        INTEGER NOT NULL,
      created_at      INTEGER NOT NULL,
      tool_call_id    TEXT,
      tool_calls_json TEXT
    );
  `);

  // Attachments
  db.run(`
    CREATE TABLE IF NOT EXISTS attachments (
      id          TEXT PRIMARY KEY,
      message_id  TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
      mime_type   TEXT NOT NULL,
      file_path   TEXT NOT NULL,
      file_name   TEXT NOT NULL,
      vir_budget  INTEGER,
      created_at  INTEGER NOT NULL
    );
  `);

  // Load presets
  db.run(`
    CREATE TABLE IF NOT EXISTS load_presets (
      id            TEXT PRIMARY KEY,
      name          TEXT NOT NULL,
      model_path    TEXT NOT NULL,
      is_default    INTEGER NOT NULL DEFAULT 0,
      is_readonly   INTEGER NOT NULL DEFAULT 0,
      config_json   TEXT NOT NULL,
      created_at    INTEGER NOT NULL,
      updated_at    INTEGER NOT NULL
    );
  `);

  // Inference presets
  db.run(`
    CREATE TABLE IF NOT EXISTS inference_presets (
      id            TEXT PRIMARY KEY,
      name          TEXT NOT NULL,
      source_model_path TEXT,
      is_default    INTEGER NOT NULL DEFAULT 0,
      config_json   TEXT NOT NULL,
      created_at    INTEGER NOT NULL,
      updated_at    INTEGER NOT NULL
    );
  `);

  // System prompt presets
  db.run(`
    CREATE TABLE IF NOT EXISTS system_presets (
      id          TEXT PRIMARY KEY,
      name        TEXT NOT NULL,
      content     TEXT NOT NULL,
      created_at  INTEGER NOT NULL,
      updated_at  INTEGER NOT NULL
    );
  `);

  // GGUF metadata cache
  db.run(`
    CREATE TABLE IF NOT EXISTS model_cache (
      file_path   TEXT NOT NULL,
      mtime       INTEGER NOT NULL,
      metadata_json TEXT NOT NULL,
      PRIMARY KEY (file_path, mtime)
    );
  `);

  // Application settings (single row)
  db.run(`
    CREATE TABLE IF NOT EXISTS settings (
      id            INTEGER PRIMARY KEY CHECK(id = 1),
      settings_json TEXT NOT NULL
    );
  `);

  // Indexes for performance
  db.run("CREATE INDEX IF NOT EXISTS idx_messages_chat_id ON messages(chat_id);");
  db.run("CREATE INDEX IF NOT EXISTS idx_messages_position ON messages(position);");
  db.run("CREATE INDEX IF NOT EXISTS idx_attachments_message_id ON attachments(message_id);");
  db.run("CREATE INDEX IF NOT EXISTS idx_chats_created_at ON chats(created_at);");
  db.run("CREATE INDEX IF NOT EXISTS idx_chats_updated_at ON chats(updated_at);");
}

/**
 * Initialises all database tables with `IF NOT EXISTS` guards and seeds default presets.
 *
 * @param path - Optional explicit database path (e.g., `":memory:"` for automated tests).
 */
export async function initDb(path?: string): Promise<void> {
  if (path === ":memory:") {
    resetDb();
  }

  const db = getDb(path);
  initDbSchema(db);

  // Seed default presets if empty
  const hasInference = db.prepare("SELECT 1 FROM inference_presets LIMIT 1").get();
  if (!hasInference) {
    const defaultInference = {
      id: Bun.randomUUIDv7(),
      name: "Standard",
      is_default: 1,
      config_json: JSON.stringify({
        temperature: 0.8,
        topP: 0.95,
        minP: 0.05,
        topK: 40,
        repeatPenalty: 1.1,
        maxTokens: -1,
        stopStrings: [],
        toolCallsEnabled: false,
        structuredOutput: { enabled: false },
        contextOverflowPolicy: "TruncateMiddle",
      }),
      created_at: Date.now(),
      updated_at: Date.now(),
    };
    db.prepare(
      "INSERT INTO inference_presets (id, name, is_default, config_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
    ).run(
      defaultInference.id,
      defaultInference.name,
      defaultInference.is_default,
      defaultInference.config_json,
      defaultInference.created_at,
      defaultInference.updated_at,
    );
  }

  const hasSystem = db.prepare("SELECT 1 FROM system_presets LIMIT 1").get();
  if (!hasSystem) {
    const defaultSystem = {
      id: Bun.randomUUIDv7(),
      name: "Vanilla",
      content: "You are a helpful assistant.",
      created_at: Date.now(),
      updated_at: Date.now(),
    };
    db.prepare(
      "INSERT INTO system_presets (id, name, content, created_at, updated_at) VALUES (?, ?, ?, ?, ?)",
    ).run(
      defaultSystem.id,
      defaultSystem.name,
      defaultSystem.content,
      defaultSystem.created_at,
      defaultSystem.updated_at,
    );
  }

  const hasLoad = db.prepare("SELECT 1 FROM load_presets LIMIT 1").get();
  if (!hasLoad) {
    const defaultLoad = {
      id: Bun.randomUUIDv7(),
      name: "Balanced Default",
      model_path: "",
      is_default: 1,
      is_readonly: 1,
      config_json: JSON.stringify({
        contextSize: 4096,
        contextShift: false,
        gpuLayers: 0,
        threads: 4,
        batchSize: 512,
        microBatchSize: 512,
        ropeScaling: "none",
        ropeFreqBase: 0,
        ropeFreqScale: 1,
        kvCacheTypeK: "f16",
        kvCacheTypeV: "f16",
        mlock: true,
        noMmap: false,
        flashAttention: true,
      }),
      created_at: Date.now(),
      updated_at: Date.now(),
    };
    db.prepare(
      "INSERT INTO load_presets (id, name, model_path, is_default, is_readonly, config_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
    ).run(
      defaultLoad.id,
      defaultLoad.name,
      defaultLoad.model_path,
      defaultLoad.is_default,
      defaultLoad.is_readonly,
      defaultLoad.config_json,
      defaultLoad.created_at,
      defaultLoad.updated_at,
    );
  }
}
