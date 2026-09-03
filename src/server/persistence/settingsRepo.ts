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
  accentColor: "#7b6ef6",
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

/**
 * Clamps a numeric value to an inclusive integer range.
 *
 * @param value - Raw numeric value to clamp.
 * @param min - Minimum allowed integer.
 * @param max - Maximum allowed integer.
 * @returns Clamped integer value.
 */
function clampInteger(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, Math.trunc(value)));
}

/**
 * Normalizes an optional port value against the allowed TCP port range.
 *
 * @param value - Raw port candidate.
 * @param fallback - Fallback port used when the input is absent or invalid.
 * @returns A valid port number, or the fallback when normalization fails.
 */
function normalizeOptionalPort(value: unknown, fallback: number | undefined): number | undefined {
  if (value === undefined) return fallback;
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  return clampInteger(value, MIN_PORT, MAX_PORT);
}

/**
 * Normalizes a positive numeric setting value.
 *
 * @param value - Raw numeric candidate.
 * @param fallback - Fallback value used when the candidate is invalid.
 * @returns A valid positive number.
 */
function normalizePositiveNumber(value: unknown, fallback: number): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    return fallback;
  }
  return value;
}

const HEX_ACCENT_COLOR = /^#[0-9A-Fa-f]{6}$/;

/**
 * Coerces a stored accent colour to `#rrggbb` so `<input type="color">` can consume it.
 *
 * @param value - Raw accent colour from settings.
 * @returns A six-digit hex colour.
 */
function normalizeAccentColor(value: string | undefined): string {
  if (typeof value === "string" && HEX_ACCENT_COLOR.test(value)) {
    return value;
  }
  return DEFAULT_SETTINGS.accentColor;
}

/**
 * Merges persisted settings with defaults and applies value normalization rules.
 *
 * @param raw - Partial settings payload loaded from persistence or request input.
 * @returns Fully normalized application settings.
 */
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
    accentColor: normalizeAccentColor(raw.accentColor ?? merged.accentColor),
  };

  return normalizedServerPort === undefined
    ? normalizedSettings
    : { ...normalizedSettings, serverPort: normalizedServerPort };
}

/**
 * Validates that a settings field contains a finite number within the configured bounds.
 *
 * @param name - Settings field name used in validation errors.
 * @param value - Raw value to validate.
 * @param options - Numeric validation constraints.
 * @returns No return value.
 * @throws {InvalidSettingsError} If the value is missing, non-finite, or outside the allowed range.
 */
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

/**
 * Validates a fully merged settings object before persistence.
 *
 * @param settings - Settings object after defaults and normalization are applied.
 * @returns No return value.
 * @throws {InvalidSettingsError} If the merged settings contain invalid numeric or port-range values.
 */
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
  assertFiniteNumber("requestTimeoutSeconds", settings.requestTimeoutSeconds, { min: 0 });

  if (settings.llamaPortRangeMin > settings.llamaPortRangeMax) {
    throw new InvalidSettingsError("llamaPortRangeMin cannot be greater than llamaPortRangeMax.");
  }

  const themes = new Set(["dark", "light", "system"]);
  if (!themes.has(settings.theme)) {
    throw new InvalidSettingsError("theme must be dark, light, or system.");
  }
  const logLevels = new Set(["off", "error", "warn", "info", "debug", "verbose"]);
  if (!logLevels.has(settings.logLevel)) {
    throw new InvalidSettingsError("logLevel must be a known logging level.");
  }
  const bubbleStyles = new Set(["bubble", "flat", "compact"]);
  if (!bubbleStyles.has(settings.chatBubbleStyle)) {
    throw new InvalidSettingsError("chatBubbleStyle must be bubble, flat, or compact.");
  }

  const stringFields: Array<keyof AppSettings> = [
    "modelsPath",
    "llamaServerPath",
    "nvidiaSmiPath",
    "rocmSmiPath",
    "sysctlPath",
    "systemProfilerPath",
    "powershellPath",
    "accentColor",
  ];
  for (const field of stringFields) {
    const value = settings[field];
    if (value !== undefined && typeof value !== "string") {
      throw new InvalidSettingsError(`${String(field)} must be a string.`);
    }
  }
}

// S4 fix: in-memory settings cache to avoid DB read on every API call
let _cachedSettings: AppSettings | null = null;
let _cachedSettingsGeneration: number | null = null;

/**
 * Determines whether the process should reuse the in-memory settings cache.
 *
 * @returns `true` when settings caching is enabled for the current runtime.
 */
function shouldUseSettingsCache(): boolean {
  return Bun.env.NODE_ENV !== "test";
}

/**
 * Loads application settings from the database, falling back to defaults when necessary.
 *
 * @returns A promise resolving to the normalized application settings.
 */
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

/**
 * Ensures that settings update payloads are plain JSON objects.
 *
 * @param value - Unknown settings update payload.
 * @returns No return value.
 * @throws {Error} If the payload is not a plain object.
 */
function assertPlainObject(value: unknown): asserts value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("Settings updates must be an object.");
  }
}

/**
 * Persists application settings to the database.
 *
 * @param updates - Partial object containing settings fields to update.
 * @returns A promise that resolves once the settings row has been written and caches updated.
 */
export async function saveSettings(updates: Partial<AppSettings>): Promise<void> {
  assertPlainObject(updates);

  /**
   * Serializes settings writes so overlapping updates always merge against the latest stored state.
   *
   * @returns A promise that resolves once the current settings update has been persisted.
   */
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
