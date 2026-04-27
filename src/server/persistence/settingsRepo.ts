/**
 * @packageDocumentation
 * Repository for reading and writing application settings.
 */

import os from "node:os";
import { join } from "node:path";
import type { AppSettings } from "@shared/types.js";
import { getDb } from "./db";

const DEFAULT_SETTINGS: AppSettings = {
  serverPort: 11435,
  modelsPath: join(os.homedir(), "Models"),
  theme: "system",
  accentColor: "oklch(65% 0.18 280)",
  fontSize: 14,
  chatBubbleStyle: "bubble",
  autonameEnabled: true,
  autoloadLastModel: true,
  llamaPortRangeMin: 12000,
  llamaPortRangeMax: 13000,
  requestTimeoutSeconds: 60,
  logLevel: "info",
  showConsoleOnStartup: false,
};

/**
 * Loads application settings from the database.
 *
 * @returns A promise resolving to the {@link AppSettings} object. Returns defaults if no settings are persisted.
 */
// S4 fix: in-memory settings cache to avoid DB read on every API call
let _cachedSettings: AppSettings | null = null;

export async function loadSettings(): Promise<AppSettings> {
  if (_cachedSettings) return { ..._cachedSettings };

  const db = getDb();
  const stmt = db.prepare<{ settings_json: string }, []>(
    "SELECT settings_json FROM settings WHERE id = 1",
  );
  const row = stmt.get();

  if (!row) {
    _cachedSettings = { ...DEFAULT_SETTINGS };
    return { ...DEFAULT_SETTINGS };
  }

  try {
    const parsed = JSON.parse(row.settings_json);
    _cachedSettings = { ...DEFAULT_SETTINGS, ...parsed };
    return { ..._cachedSettings };
  } catch (_err) {
    _cachedSettings = { ...DEFAULT_SETTINGS };
    return { ...DEFAULT_SETTINGS };
  }
}

let settingsLock = Promise.resolve();

function assertPlainObject(value: unknown): asserts value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("Settings updates must be an object.");
  }
}

/**
 * Persists application settings to the database.
 *
 * @param updates - Partial object containing settings fields to update.
 */
export async function saveSettings(updates: Partial<AppSettings>): Promise<void> {
  assertPlainObject(updates);

  const run = async () => {
    // S3 fix (settingsLock): catch and reset the lock to prevent cascading failures
    try {
      await settingsLock;
    } catch {
      // Previous lock rejected — ignore the stale error and proceed
    }
    // S4 fix: invalidate cache before loading so we read fresh data
    _cachedSettings = null;
    const current = await loadSettings();
    const merged = { ...current, ...updates };

    const db = getDb();
    const stmt = db.prepare("INSERT OR REPLACE INTO settings (id, settings_json) VALUES (1, ?)");
    stmt.run(JSON.stringify(merged));
    // Update cache with the merged result
    _cachedSettings = merged;
  };

  settingsLock = run();
  return settingsLock;
}
