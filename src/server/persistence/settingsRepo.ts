/**
 * @packageDocumentation
 * Repository for reading and writing application settings.
 */

import os from "node:os";
import { join } from "node:path";
import type { AppSettings } from "../../shared/types";
import { getDb, getDbGeneration } from "./db";

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

const MIN_PORT = 1;
const MAX_PORT = 65535;

export class InvalidSettingsError extends Error {}

function clampInteger(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, Math.trunc(value)));
}

function normalizeOptionalPort(value: unknown, fallback: number | undefined): number | undefined {
  if (value === undefined) return fallback;
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  return clampInteger(value, MIN_PORT, MAX_PORT);
}

function normalizePositiveNumber(value: unknown, fallback: number): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    return fallback;
  }
  return value;
}

function normalizeSettings(raw: Partial<AppSettings>): AppSettings {
  const merged = { ...DEFAULT_SETTINGS, ...raw } as AppSettings;
  const normalizedServerPort = normalizeOptionalPort(raw.serverPort, DEFAULT_SETTINGS.serverPort);
  let llamaPortRangeMin = normalizeOptionalPort(
    raw.llamaPortRangeMin,
    DEFAULT_SETTINGS.llamaPortRangeMin,
  ) as number;
  let llamaPortRangeMax = normalizeOptionalPort(
    raw.llamaPortRangeMax,
    DEFAULT_SETTINGS.llamaPortRangeMax,
  ) as number;

  if (llamaPortRangeMin > llamaPortRangeMax) {
    [llamaPortRangeMin, llamaPortRangeMax] = [llamaPortRangeMax, llamaPortRangeMin];
  }

  const normalizedSettings: AppSettings = {
    ...merged,
    fontSize: clampInteger(
      normalizePositiveNumber(raw.fontSize, DEFAULT_SETTINGS.fontSize),
      10,
      32,
    ),
    llamaPortRangeMin,
    llamaPortRangeMax,
    requestTimeoutSeconds: normalizePositiveNumber(
      raw.requestTimeoutSeconds,
      DEFAULT_SETTINGS.requestTimeoutSeconds,
    ),
  };

  return normalizedServerPort === undefined
    ? normalizedSettings
    : { ...normalizedSettings, serverPort: normalizedServerPort };
}

function assertFiniteNumber(
  name: string,
  value: unknown,
  options: { integer?: boolean; min?: number; max?: number },
): void {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new InvalidSettingsError(`${name} must be a finite number.`);
  }
  if (options.integer && !Number.isInteger(value)) {
    throw new InvalidSettingsError(`${name} must be an integer.`);
  }
  if (options.min !== undefined && value < options.min) {
    throw new InvalidSettingsError(`${name} must be at least ${options.min}.`);
  }
  if (options.max !== undefined && value > options.max) {
    throw new InvalidSettingsError(`${name} must be at most ${options.max}.`);
  }
}

function validateMergedSettings(settings: AppSettings): void {
  if (settings.serverPort !== undefined) {
    assertFiniteNumber("serverPort", settings.serverPort, {
      integer: true,
      min: MIN_PORT,
      max: MAX_PORT,
    });
  }
  assertFiniteNumber("fontSize", settings.fontSize, { integer: true, min: 1 });
  assertFiniteNumber("llamaPortRangeMin", settings.llamaPortRangeMin, {
    integer: true,
    min: MIN_PORT,
    max: MAX_PORT,
  });
  assertFiniteNumber("llamaPortRangeMax", settings.llamaPortRangeMax, {
    integer: true,
    min: MIN_PORT,
    max: MAX_PORT,
  });
  assertFiniteNumber("requestTimeoutSeconds", settings.requestTimeoutSeconds, { min: 0.001 });

  if (settings.llamaPortRangeMin > settings.llamaPortRangeMax) {
    throw new InvalidSettingsError("llamaPortRangeMin cannot be greater than llamaPortRangeMax.");
  }
}

/**
 * Loads application settings from the database.
 *
 * @returns A promise resolving to the {@link AppSettings} object. Returns defaults if no settings are persisted.
 */
// S4 fix: in-memory settings cache to avoid DB read on every API call
let _cachedSettings: AppSettings | null = null;
let _cachedSettingsGeneration: number | null = null;

function shouldUseSettingsCache(): boolean {
  return Bun.env.NODE_ENV !== "test";
}

export async function loadSettings(): Promise<AppSettings> {
  const dbGeneration = getDbGeneration();
  if (shouldUseSettingsCache() && _cachedSettings && _cachedSettingsGeneration === dbGeneration) {
    return { ..._cachedSettings };
  }

  const db = getDb();
  const stmt = db.prepare<{ settings_json: string }, []>(
    "SELECT settings_json FROM settings WHERE id = 1",
  );
  const row = stmt.get();

  if (!row) {
    if (shouldUseSettingsCache()) {
      _cachedSettings = { ...DEFAULT_SETTINGS };
      _cachedSettingsGeneration = dbGeneration;
    }
    const { setConfiguredLogLevel } = await import("../logger");
    setConfiguredLogLevel(DEFAULT_SETTINGS.logLevel);
    return { ...DEFAULT_SETTINGS };
  }

  try {
    const parsed = JSON.parse(row.settings_json);
    const normalizedSettings = normalizeSettings(parsed as Partial<AppSettings>);
    if (shouldUseSettingsCache()) {
      _cachedSettings = normalizedSettings;
      _cachedSettingsGeneration = dbGeneration;
    }
    const { setConfiguredLogLevel } = await import("../logger");
    setConfiguredLogLevel(normalizedSettings.logLevel);
    return normalizedSettings;
  } catch (_err) {
    if (shouldUseSettingsCache()) {
      _cachedSettings = { ...DEFAULT_SETTINGS };
      _cachedSettingsGeneration = dbGeneration;
    }
    const { setConfiguredLogLevel } = await import("../logger");
    setConfiguredLogLevel(DEFAULT_SETTINGS.logLevel);
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
    _cachedSettingsGeneration = null;
    const current = await loadSettings();
    const merged = { ...current, ...updates } as AppSettings;
    validateMergedSettings(merged);
    const normalized = normalizeSettings(merged);

    const db = getDb();
    const stmt = db.prepare("INSERT OR REPLACE INTO settings (id, settings_json) VALUES (1, ?)");
    stmt.run(JSON.stringify(normalized));
    // Update cache with the merged result
    if (shouldUseSettingsCache()) {
      _cachedSettings = normalized;
      _cachedSettingsGeneration = getDbGeneration();
    }
    const { setConfiguredLogLevel } = await import("../logger");
    setConfiguredLogLevel(normalized.logLevel);
  };

  settingsLock = run();
  return settingsLock;
}
