/**
 * @packageDocumentation
 * Preset repository — CRUD operations for load, inference, and system presets.
 */

import type {
  InferencePreset,
  LoadPreset,
  ModelLoadConfig,
  SystemPromptPreset,
} from "../../shared/types";
import { DEFAULT_IMAGE_MAX_TOKENS, defaultBatchingForImageTokens } from "../../shared/imageTokens";
import { detectThinkingConfig } from "../../shared/thinkingTags";
import { logWarn } from "../logger";
import { getDb } from "./db";

/** Thrown when a load-preset payload cannot be persisted. */
export class PresetValidationError extends Error {
  /**
   * Creates a validation error for load-preset create/update requests.
   *
   * @param message - Human-readable reason the payload was rejected.
   */
  constructor(message: string) {
    super(message);
    this.name = "PresetValidationError";
  }
}

const LOAD_CONFIG_KEYS = new Set([
  "modelPath",
  "mmProjPath",
  "specType",
  "specDraftModelPath",
  "specDraftNMax",
  "specDraftNMin",
  "specDraftPMin",
  "contextSize",
  "contextShift",
  "gpuLayers",
  "threads",
  "batchSize",
  "microBatchSize",
  "threadsBatch",
  "ropeScaling",
  "ropeFreqBase",
  "ropeFreqScale",
  "kvCacheTypeK",
  "kvCacheTypeV",
  "kvUnified",
  "mlock",
  "noMmap",
  "contBatching",
  "flashAttn",
  "swaFull",
  "noKvOffload",
  "cacheReuse",
  "contextCheckpoints",
  "mainGpu",
  "tensorSplit",
  "numa",
  "logLevel",
  "seedOverride",
  "chatTemplateContent",
  "imageMaxTokens",
  "imageMinTokens",
  "presetId",
]);

const KV_CACHE_TYPES = new Set([
  "f16",
  "f32",
  "bf16",
  "q8_0",
  "q4_0",
  "q4_1",
  "iq4_nl",
  "q5_0",
  "q5_1",
]);
const ROPE_SCALING_TYPES = new Set(["none", "linear", "yarn"]);
const FLASH_ATTN_TYPES = new Set(["on", "off", "auto"]);
const SPEC_TYPES = new Set(["off", "draft-mtp", "draft-simple", "draft-eagle3"]);
const NUMA_TYPES = new Set(["distribute", "isolate", "numactl"]);

type ParsedLoadPresetPayload = {
  config: LoadPreset["config"];
  chatTemplateOverride?: string;
  thinkingTagOverride?: LoadPreset["thinkingTagOverride"];
};

/**
 * Checks whether an unknown value matches the thinking-tag override shape stored with load presets.
 *
 * @param value - Unknown payload candidate.
 * @returns `true` when the value is a valid thinking-tag override object.
 */
function isThinkingTagOverride(
  value: unknown,
): value is NonNullable<LoadPreset["thinkingTagOverride"]> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }

  const candidate = value as Record<string, unknown>;
  return (
    typeof candidate["openTag"] === "string" &&
    typeof candidate["closeTag"] === "string" &&
    (candidate["enableToken"] === undefined || typeof candidate["enableToken"] === "string")
  );
}

/**
 * Normalizes legacy and current flash-attention fields into the modern preset representation.
 *
 * @param rawConfig - Raw parsed preset config object.
 * @returns Normalized flash-attention value, or `undefined` when none is present.
 */
function normalizeFlashAttnValue(
  rawConfig: Record<string, unknown>,
): LoadPreset["config"]["flashAttn"] | undefined {
  const flashAttn = rawConfig["flashAttn"];
  if (flashAttn === "on" || flashAttn === "off" || flashAttn === "auto") {
    return flashAttn;
  }

  const legacyFlashAttention = rawConfig["flashAttention"];
  if (typeof legacyFlashAttention === "boolean") {
    return legacyFlashAttention ? "on" : "off";
  }

  return undefined;
}

/**
 * Reads a finite number field from a load-preset config.
 *
 * @param value - Raw field value.
 * @param field - Field name used in error messages.
 * @param options - Integer/range constraints and whether invalid values throw.
 * @returns The coerced number, or `undefined` when the field is absent or dropped.
 */
function readNumberField(
  value: unknown,
  field: string,
  options: { integer?: boolean; min?: number; max?: number; strict: boolean },
): number | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "number" || !Number.isFinite(value)) {
    if (options.strict) {
      throw new PresetValidationError(
        `Load preset config field "${field}" must be a finite number.`,
      );
    }
    return undefined;
  }
  const numeric = options.integer ? Math.trunc(value) : value;
  if (options.min !== undefined && numeric < options.min) {
    if (options.strict) {
      throw new PresetValidationError(
        `Load preset config field "${field}" must be >= ${options.min}.`,
      );
    }
    return undefined;
  }
  if (options.max !== undefined && numeric > options.max) {
    if (options.strict) {
      throw new PresetValidationError(
        `Load preset config field "${field}" must be <= ${options.max}.`,
      );
    }
    return undefined;
  }
  return numeric;
}

/**
 * Reads a boolean field from a load-preset config.
 *
 * @param value - Raw field value.
 * @param field - Field name used in error messages.
 * @param strict - Whether invalid types throw instead of being dropped.
 * @returns The boolean, or `undefined` when absent or dropped.
 */
function readBooleanField(value: unknown, field: string, strict: boolean): boolean | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "boolean") {
    if (strict) {
      throw new PresetValidationError(`Load preset config field "${field}" must be a boolean.`);
    }
    return undefined;
  }
  return value;
}

/**
 * Reads a string field from a load-preset config.
 *
 * @param value - Raw field value.
 * @param field - Field name used in error messages.
 * @param strict - Whether invalid types throw instead of being dropped.
 * @returns The string, or `undefined` when absent or dropped.
 */
function readStringField(value: unknown, field: string, strict: boolean): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string") {
    if (strict) {
      throw new PresetValidationError(`Load preset config field "${field}" must be a string.`);
    }
    return undefined;
  }
  return value;
}

/**
 * Reads a string-union field from a load-preset config.
 *
 * @param value - Raw field value.
 * @param field - Field name used in error messages.
 * @param allowed - Allowed string values.
 * @param strict - Whether invalid values throw instead of being dropped.
 * @returns The allowed string, or `undefined` when absent or dropped.
 */
function readEnumField<T extends string>(
  value: unknown,
  field: string,
  allowed: Set<string>,
  strict: boolean,
): T | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string" || !allowed.has(value)) {
    if (strict) {
      throw new PresetValidationError(
        `Load preset config field "${field}" must be one of: ${[...allowed].join(", ")}.`,
      );
    }
    return undefined;
  }
  return value as T;
}

/**
 * Reads a tensor-split array from a load-preset config.
 *
 * @param value - Raw field value.
 * @param strict - Whether invalid values throw instead of being dropped.
 * @returns Finite number array, or `undefined` when absent or dropped.
 */
function readTensorSplit(value: unknown, strict: boolean): number[] | undefined {
  if (value === undefined || value === null) return undefined;
  if (
    !Array.isArray(value) ||
    value.some((entry) => typeof entry !== "number" || !Number.isFinite(entry))
  ) {
    if (strict) {
      throw new PresetValidationError(
        'Load preset config field "tensorSplit" must be an array of finite numbers.',
      );
    }
    return undefined;
  }
  return value as number[];
}

/**
 * Copies known load-preset config fields with type coercion.
 *
 * @param rawConfig - Raw parsed config object.
 * @param strict - When true, unknown keys and malformed values throw.
 * @returns Whitelisted load preset configuration.
 */
function normalizeLoadPresetConfig(
  rawConfig: Record<string, unknown>,
  strict = false,
): LoadPreset["config"] {
  if (strict) {
    const unknownKeys = Object.keys(rawConfig).filter(
      (key) => key !== "flashAttention" && !LOAD_CONFIG_KEYS.has(key),
    );
    if (unknownKeys.length > 0) {
      throw new PresetValidationError(
        `Unknown load preset config fields: ${unknownKeys.join(", ")}.`,
      );
    }
  }

  const flashAttn =
    normalizeFlashAttnValue(rawConfig) ??
    readEnumField<NonNullable<ModelLoadConfig["flashAttn"]>>(
      rawConfig["flashAttn"],
      "flashAttn",
      FLASH_ATTN_TYPES,
      strict,
    );

  const config: Record<string, unknown> = {};
  const assign = (key: string, value: unknown) => {
    if (value !== undefined) config[key] = value;
  };

  assign("modelPath", readStringField(rawConfig["modelPath"], "modelPath", strict));
  assign("mmProjPath", readStringField(rawConfig["mmProjPath"], "mmProjPath", strict));
  assign(
    "specType",
    readEnumField<NonNullable<ModelLoadConfig["specType"]>>(
      rawConfig["specType"],
      "specType",
      SPEC_TYPES,
      strict,
    ),
  );
  assign(
    "specDraftModelPath",
    readStringField(rawConfig["specDraftModelPath"], "specDraftModelPath", strict),
  );
  assign(
    "specDraftNMax",
    readNumberField(rawConfig["specDraftNMax"], "specDraftNMax", {
      integer: true,
      min: 1,
      max: 1024,
      strict,
    }),
  );
  assign(
    "specDraftNMin",
    readNumberField(rawConfig["specDraftNMin"], "specDraftNMin", {
      integer: true,
      min: 0,
      max: 1024,
      strict,
    }),
  );
  assign(
    "specDraftPMin",
    readNumberField(rawConfig["specDraftPMin"], "specDraftPMin", {
      min: 0,
      max: 1,
      strict,
    }),
  );
  assign(
    "contextSize",
    readNumberField(rawConfig["contextSize"], "contextSize", {
      integer: true,
      min: 1,
      max: 16_777_216,
      strict,
    }),
  );
  assign("contextShift", readBooleanField(rawConfig["contextShift"], "contextShift", strict));
  assign(
    "gpuLayers",
    readNumberField(rawConfig["gpuLayers"], "gpuLayers", {
      integer: true,
      min: -1,
      max: 10_000,
      strict,
    }),
  );
  assign(
    "threads",
    readNumberField(rawConfig["threads"], "threads", { integer: true, min: 1, max: 512, strict }),
  );
  assign(
    "batchSize",
    readNumberField(rawConfig["batchSize"], "batchSize", {
      integer: true,
      min: 1,
      max: 1_048_576,
      strict,
    }),
  );
  assign(
    "microBatchSize",
    readNumberField(rawConfig["microBatchSize"], "microBatchSize", {
      integer: true,
      min: 1,
      max: 1_048_576,
      strict,
    }),
  );
  assign(
    "threadsBatch",
    readNumberField(rawConfig["threadsBatch"], "threadsBatch", {
      integer: true,
      min: 1,
      max: 512,
      strict,
    }),
  );
  assign(
    "ropeScaling",
    readEnumField<ModelLoadConfig["ropeScaling"]>(
      rawConfig["ropeScaling"],
      "ropeScaling",
      ROPE_SCALING_TYPES,
      strict,
    ),
  );
  assign(
    "ropeFreqBase",
    readNumberField(rawConfig["ropeFreqBase"], "ropeFreqBase", { min: 0, max: 10_000_000, strict }),
  );
  assign(
    "ropeFreqScale",
    readNumberField(rawConfig["ropeFreqScale"], "ropeFreqScale", { min: 0, max: 1000, strict }),
  );
  assign(
    "kvCacheTypeK",
    readEnumField<ModelLoadConfig["kvCacheTypeK"]>(
      rawConfig["kvCacheTypeK"],
      "kvCacheTypeK",
      KV_CACHE_TYPES,
      strict,
    ),
  );
  assign(
    "kvCacheTypeV",
    readEnumField<ModelLoadConfig["kvCacheTypeV"]>(
      rawConfig["kvCacheTypeV"],
      "kvCacheTypeV",
      KV_CACHE_TYPES,
      strict,
    ),
  );
  assign("kvUnified", readBooleanField(rawConfig["kvUnified"], "kvUnified", strict));
  assign("mlock", readBooleanField(rawConfig["mlock"], "mlock", strict));
  assign("noMmap", readBooleanField(rawConfig["noMmap"], "noMmap", strict));
  assign("contBatching", readBooleanField(rawConfig["contBatching"], "contBatching", strict));
  if (flashAttn) assign("flashAttn", flashAttn);
  assign("swaFull", readBooleanField(rawConfig["swaFull"], "swaFull", strict));
  assign("noKvOffload", readBooleanField(rawConfig["noKvOffload"], "noKvOffload", strict));
  assign(
    "cacheReuse",
    readNumberField(rawConfig["cacheReuse"], "cacheReuse", {
      integer: true,
      min: 0,
      max: 1_048_576,
      strict,
    }),
  );
  assign(
    "contextCheckpoints",
    readNumberField(rawConfig["contextCheckpoints"], "contextCheckpoints", {
      integer: true,
      min: 0,
      max: 4096,
      strict,
    }),
  );
  assign(
    "mainGpu",
    readNumberField(rawConfig["mainGpu"], "mainGpu", { integer: true, min: 0, max: 256, strict }),
  );
  assign("tensorSplit", readTensorSplit(rawConfig["tensorSplit"], strict));
  assign(
    "numa",
    readEnumField<NonNullable<ModelLoadConfig["numa"]>>(
      rawConfig["numa"],
      "numa",
      NUMA_TYPES,
      strict,
    ),
  );
  assign(
    "logLevel",
    readNumberField(rawConfig["logLevel"], "logLevel", { integer: true, min: 0, max: 10, strict }),
  );
  assign(
    "seedOverride",
    readNumberField(rawConfig["seedOverride"], "seedOverride", {
      integer: true,
      min: -1,
      max: 2_147_483_647,
      strict,
    }),
  );
  assign(
    "chatTemplateContent",
    readStringField(rawConfig["chatTemplateContent"], "chatTemplateContent", strict),
  );
  assign(
    "imageMaxTokens",
    readNumberField(rawConfig["imageMaxTokens"], "imageMaxTokens", {
      integer: true,
      min: 1,
      max: 1_048_576,
      strict,
    }),
  );
  assign(
    "imageMinTokens",
    readNumberField(rawConfig["imageMinTokens"], "imageMinTokens", {
      integer: true,
      min: 1,
      max: 1_048_576,
      strict,
    }),
  );
  assign("presetId", readStringField(rawConfig["presetId"], "presetId", strict));

  return config as unknown as LoadPreset["config"];
}

/**
 * Rejects unknown or malformed load-preset config objects on write paths.
 *
 * @param config - Candidate config payload from an HTTP body.
 * @returns No return value.
 * @throws {PresetValidationError} If the config is not a plain object or fails validation.
 */
export function assertWritableLoadPresetConfig(config: unknown): void {
  if (typeof config !== "object" || config === null || Array.isArray(config)) {
    throw new PresetValidationError("Load preset config must be a JSON object.");
  }
  normalizeLoadPresetConfig(config as Record<string, unknown>, true);
}

/**
 * Rejects unknown or malformed load-preset create payloads.
 *
 * @param body - Parsed JSON request body.
 * @returns No return value.
 * @throws {PresetValidationError} If required fields are missing or config is invalid.
 */
export function assertWritableLoadPreset(body: unknown): void {
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    throw new PresetValidationError("Load preset must be a JSON object.");
  }
  const record = body as Record<string, unknown>;
  if (typeof record["name"] !== "string" || record["name"].length === 0) {
    throw new PresetValidationError("Preset creation requires a name.");
  }
  if (record["config"] === undefined) {
    throw new PresetValidationError("Load preset creation requires a config object.");
  }
  assertWritableLoadPresetConfig(record["config"]);
}

/**
 * Parses the stored JSON payload for a load preset.
 *
 * @param configJson - JSON payload stored in the database.
 * @returns Parsed load preset config plus optional template overrides.
 */
function parseLoadPresetPayload(configJson: string): ParsedLoadPresetPayload {
  const parsed = safeParse<Record<string, unknown>>(configJson, {});
  const parsedConfig = parsed["config"];
  const rawConfig =
    typeof parsedConfig === "object" && parsedConfig !== null && !Array.isArray(parsedConfig)
      ? (parsedConfig as Record<string, unknown>)
      : parsed;
  const chatTemplateOverride = parsed["chatTemplateOverride"];
  const thinkingTagOverride = parsed["thinkingTagOverride"];

  return {
    config: normalizeLoadPresetConfig(rawConfig),
    ...(typeof chatTemplateOverride === "string" ? { chatTemplateOverride } : {}),
    ...(isThinkingTagOverride(thinkingTagOverride) ? { thinkingTagOverride } : {}),
  };
}

/**
 * Serializes a load preset payload into the database JSON format.
 *
 * @param payload - Parsed load preset payload.
 * @returns JSON text ready for persistence.
 */
function serializeLoadPresetPayload(payload: ParsedLoadPresetPayload): string {
  return JSON.stringify({
    config: normalizeLoadPresetConfig(payload.config as unknown as Record<string, unknown>),
    ...(payload.chatTemplateOverride !== undefined
      ? { chatTemplateOverride: payload.chatTemplateOverride }
      : {}),
    ...(payload.thinkingTagOverride !== undefined
      ? { thinkingTagOverride: payload.thinkingTagOverride }
      : {}),
  });
}

/**
 * Parses JSON safely while logging malformed preset payloads.
 *
 * @param json - Raw JSON string from persistence.
 * @param fallback - Fallback value returned when parsing fails.
 * @returns Parsed JSON value or the provided fallback.
 */
function safeParse<T>(json: string, fallback: T): T {
  try {
    return JSON.parse(json) as T;
  } catch (err) {
    logWarn("[presetRepo] Failed to parse preset config JSON", {
      error: err instanceof Error ? err.message : String(err),
      snippet: json.slice(0, 160),
    });
    return fallback;
  }
}

/**
 * Retrieves all saved model load presets from the database.
 *
 * @returns A promise resolving to an array of {@link LoadPreset}.
 */
export async function getLoadPresets(): Promise<LoadPreset[]> {
  const rows = getDb()
    .query<
      {
        id: string;
        name: string;
        model_path: string;
        is_default: number;
        is_readonly: number;
        config_json: string;
        created_at: number;
        updated_at: number;
      },
      []
    >("SELECT * FROM load_presets")
    .all();
  return rows.map((r) => {
    const parsed = parseLoadPresetPayload(r.config_json);
    return {
      id: r.id,
      name: r.name,
      modelPath: r.model_path,
      isDefault: Boolean(r.is_default),
      isReadonly: Boolean(r.is_readonly),
      config: parsed.config,
      ...(parsed.chatTemplateOverride !== undefined
        ? { chatTemplateOverride: parsed.chatTemplateOverride }
        : {}),
      ...(parsed.thinkingTagOverride !== undefined
        ? { thinkingTagOverride: parsed.thinkingTagOverride }
        : {}),
      createdAt: r.created_at,
      updatedAt: r.updated_at,
    };
  });
}

/**
 * Retrieves all saved inference presets from the database.
 *
 * @returns A promise resolving to an array of {@link InferencePreset}.
 */
export async function getInferencePresets(): Promise<InferencePreset[]> {
  const rows = getDb()
    .query<
      {
        id: string;
        name: string;
        source_model_path: string | null;
        is_default: number;
        config_json: string;
        created_at: number;
        updated_at: number;
      },
      []
    >("SELECT * FROM inference_presets")
    .all();
  return rows.map((r) => {
    const config = safeParse<Record<string, unknown>>(r.config_json, {});
    return {
      id: r.id,
      name: r.name,
      sourceModelPath: r.source_model_path || undefined,
      isDefault: Boolean(r.is_default),
      ...config,
      createdAt: r.created_at,
      updatedAt: r.updated_at,
    } as InferencePreset;
  });
}

/**
 * Retrieves all saved system prompt presets from the database.
 *
 * @returns A promise resolving to an array of {@link SystemPromptPreset}.
 */
export async function getSystemPresets(): Promise<SystemPromptPreset[]> {
  const rows = getDb()
    .query<
      { id: string; name: string; content: string; created_at: number; updated_at: number },
      []
    >("SELECT * FROM system_presets")
    .all();
  return rows.map((r) => ({
    id: r.id,
    name: r.name,
    content: r.content,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  }));
}

/**
 * Persists a new load preset to the database.
 *
 * @param preset - Load preset to persist.
 * @returns A promise that resolves once the preset row has been inserted.
 */
export async function createLoadPreset(preset: LoadPreset): Promise<void> {
  const db = getDb();
  let {
    id,
    name,
    isDefault,
    isReadonly,
    modelPath,
    createdAt,
    updatedAt,
    config,
    chatTemplateOverride,
    thinkingTagOverride,
  } = preset;
  if (!id) id = Bun.randomUUIDv7();
  if (!createdAt) createdAt = Date.now();
  if (!updatedAt) updatedAt = createdAt;

  const configJson = serializeLoadPresetPayload({
    config,
    ...(chatTemplateOverride !== undefined ? { chatTemplateOverride } : {}),
    ...(thinkingTagOverride !== undefined ? { thinkingTagOverride } : {}),
  });
  db.prepare(
    `INSERT INTO load_presets (id, name, model_path, is_default, is_readonly, config_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    name,
    modelPath || config.modelPath || null,
    isDefault ? 1 : 0,
    isReadonly ? 1 : 0,
    configJson,
    createdAt,
    updatedAt,
  );
}

export type PresetMutationResult = "updated" | "deleted" | "not_found" | "protected";

/**
 * Updates an existing load preset in the database.
 *
 * @param id - Identifier of the preset to update.
 * @param updates - Partial load preset fields to merge into the existing row.
 * @returns Whether the row was updated or missing.
 */
export async function updateLoadPreset(
  id: string,
  updates: Partial<LoadPreset>,
): Promise<Exclude<PresetMutationResult, "deleted" | "protected">> {
  const db = getDb();
  const existing = db
    .query<{ config_json: string; name: string; model_path: string | null }, [string]>(
      "SELECT config_json, name, model_path FROM load_presets WHERE id = ?",
    )
    .get(id);
  if (!existing) return "not_found";
  const currentConfig = parseLoadPresetPayload(existing.config_json);

  const newConfigJson = serializeLoadPresetPayload({
    config: updates.config ?? currentConfig.config,
    ...((updates.chatTemplateOverride !== undefined
      ? updates.chatTemplateOverride
      : currentConfig.chatTemplateOverride) !== undefined
      ? {
          chatTemplateOverride:
            updates.chatTemplateOverride !== undefined
              ? updates.chatTemplateOverride
              : currentConfig.chatTemplateOverride,
        }
      : {}),
    ...((updates.thinkingTagOverride !== undefined
      ? updates.thinkingTagOverride
      : currentConfig.thinkingTagOverride) !== undefined
      ? {
          thinkingTagOverride:
            updates.thinkingTagOverride !== undefined
              ? updates.thinkingTagOverride
              : currentConfig.thinkingTagOverride,
        }
      : {}),
  });

  const newName = updates.name ?? existing.name;
  const newModelPath = updates.modelPath ?? updates.config?.modelPath ?? existing.model_path;
  db.prepare(
    "UPDATE load_presets SET name = ?, model_path = ?, config_json = ?, updated_at = ? WHERE id = ?",
  ).run(newName, newModelPath ?? null, newConfigJson, Date.now(), id);
  return "updated";
}

/**
 * Deletes a mutable load preset.
 *
 * @param id - Identifier of the load preset to remove.
 * @returns A promise that resolves once the delete statement has completed.
 */
export async function deleteLoadPreset(id: string): Promise<PresetMutationResult> {
  const db = getDb();
  const existing = db
    .query<{ is_readonly: number }, [string]>("SELECT is_readonly FROM load_presets WHERE id = ?")
    .get(id);
  if (!existing) return "not_found";
  if (existing.is_readonly) return "protected";
  db.prepare("DELETE FROM load_presets WHERE id = ?").run(id);
  return "deleted";
}

/**
 * Persists a new inference preset to the database.
 *
 * @param preset - Inference preset to persist.
 * @returns A promise that resolves once the preset row has been inserted.
 */
export async function createInferencePreset(preset: InferencePreset): Promise<void> {
  const db = getDb();
  let { id, name, sourceModelPath, isDefault, createdAt, updatedAt, ...config } = preset;

  if (!id) id = Bun.randomUUIDv7();
  if (!createdAt) createdAt = Date.now();
  if (!updatedAt) updatedAt = createdAt;

  if (config.structuredOutput) {
    config.structuredOutput = { ...config.structuredOutput, grammar: undefined };
  }

  const configJson = JSON.stringify(config);
  db.prepare(
    `INSERT INTO inference_presets (id, name, source_model_path, is_default, config_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(id, name, sourceModelPath || null, isDefault ? 1 : 0, configJson, createdAt, updatedAt);
}

/**
 * Updates an existing inference preset in the database.
 *
 * @param id - Identifier of the inference preset to update.
 * @param updates - Partial inference preset fields to merge into the existing row.
 * @returns A promise that resolves once the preset row has been updated.
 */
export async function updateInferencePreset(
  id: string,
  updates: Partial<InferencePreset>,
): Promise<Exclude<PresetMutationResult, "deleted" | "protected">> {
  const db = getDb();
  const existingRow = db
    .query<{ config_json: string; name: string }, [string]>(
      "SELECT config_json, name FROM inference_presets WHERE id = ?",
    )
    .get(id);
  if (!existingRow) return "not_found";

  const currentConfig = safeParse<Record<string, unknown>>(existingRow.config_json, {});
  const {
    name,
    sourceModelPath,
    isDefault,
    createdAt,
    updatedAt,
    id: _id,
    ...configUpdates
  } = updates;

  const newConfig = { ...currentConfig, ...configUpdates };

  if (
    newConfig.structuredOutput &&
    typeof newConfig.structuredOutput === "object" &&
    newConfig.structuredOutput !== null
  ) {
    newConfig.structuredOutput = { ...newConfig.structuredOutput, grammar: undefined };
  }

  const newName = name ?? existingRow.name;

  db.prepare(
    "UPDATE inference_presets SET name = ?, config_json = ?, updated_at = ? WHERE id = ?",
  ).run(newName, JSON.stringify(newConfig), Date.now(), id);
  return "updated";
}

/**
 * Deletes a mutable inference preset.
 *
 * @param id - Identifier of the inference preset to remove.
 * @returns A promise that resolves once the delete statement has completed.
 */
export async function deleteInferencePreset(id: string): Promise<PresetMutationResult> {
  const db = getDb();
  const existing = db
    .query<{ is_default: number }, [string]>(
      "SELECT is_default FROM inference_presets WHERE id = ?",
    )
    .get(id);
  if (!existing) return "not_found";
  if (existing.is_default) return "protected";
  db.prepare("DELETE FROM inference_presets WHERE id = ?").run(id);
  return "deleted";
}

/**
 * Persists a new system prompt preset to the database.
 *
 * @param preset - System prompt preset to persist.
 * @returns A promise that resolves once the preset row has been inserted.
 */
export async function createSystemPreset(preset: SystemPromptPreset): Promise<void> {
  const db = getDb();
  let { id, name, content, createdAt, updatedAt } = preset;
  if (!id) id = Bun.randomUUIDv7();
  if (!createdAt) createdAt = Date.now();
  if (!updatedAt) updatedAt = createdAt;

  db.prepare(
    `INSERT INTO system_presets (id, name, content, created_at, updated_at) VALUES (?, ?, ?, ?, ?)`,
  ).run(id, name, content, createdAt, updatedAt);
}

/**
 * Updates an existing system prompt preset in the database.
 *
 * @param id - Identifier of the system prompt preset to update.
 * @param updates - Partial system preset fields to merge into the existing row.
 * @returns A promise that resolves once the preset row has been updated.
 */
export async function updateSystemPreset(
  id: string,
  updates: Partial<SystemPromptPreset>,
): Promise<Exclude<PresetMutationResult, "deleted" | "protected">> {
  const db = getDb();
  const existing = db
    .query<{ id: string }, [string]>("SELECT id FROM system_presets WHERE id = ?")
    .get(id);
  if (!existing) return "not_found";
  const setStmts: string[] = [];
  const args: (string | number)[] = [];
  if (updates.name !== undefined) {
    setStmts.push("name = ?");
    args.push(updates.name);
  }
  if (updates.content !== undefined) {
    setStmts.push("content = ?");
    args.push(updates.content);
  }
  if (setStmts.length === 0) return "updated";

  setStmts.push("updated_at = ?");
  args.push(Date.now());
  args.push(id);

  db.prepare(`UPDATE system_presets SET ${setStmts.join(", ")} WHERE id = ?`).run(...args);
  return "updated";
}

/**
 * Deletes a system prompt preset.
 *
 * @param id - Identifier of the system prompt preset to remove.
 * @returns A promise that resolves once the delete statement has completed.
 */
export async function deleteSystemPreset(id: string): Promise<PresetMutationResult> {
  const db = getDb();
  const existing = db
    .query<{ id: string }, [string]>("SELECT id FROM system_presets WHERE id = ?")
    .get(id);
  if (!existing) return "not_found";
  db.prepare("DELETE FROM system_presets WHERE id = ?").run(id);
  return "deleted";
}

/**
 * Ensures each discovered model has default load and inference presets derived from GGUF metadata.
 *
 * @param models - Models discovered during the current model scan.
 * @returns A promise that resolves once any missing default presets have been created.
 */
export async function ensureModelDefaultPresets(
  models: import("../../shared/types").ModelEntry[],
): Promise<void> {
  const loadPresets = await getLoadPresets();
  const infPresets = await getInferencePresets();

  const existingLoadPaths = new Set(loadPresets.map((p) => p.modelPath));
  const existingInfPaths = new Set(infPresets.map((p) => p.sourceModelPath));
  let hasDefaultLoad = loadPresets.some((p) => p.isDefault);
  let hasDefaultInf = infPresets.some((p) => p.isDefault);

  for (const m of models) {
    if (!m.metadata) continue;

    // Default Load Preset
    if (!existingLoadPaths.has(m.primaryPath)) {
      const newLoadPreset: LoadPreset = {
        id: Bun.randomUUIDv7(),
        name: `Default (from GGUF) for ${m.modelName}`,
        modelPath: m.primaryPath,
        isDefault: !hasDefaultLoad,
        isReadonly: false,
        chatTemplateOverride: m.metadata.chatTemplate ?? undefined,
        thinkingTagOverride: detectThinkingConfig(m.metadata.architecture),
        config: {
          modelPath: m.primaryPath,
          mmProjPath: m.mmProjPath,
          contextSize: m.metadata.contextLength || 4096,
          contextShift: false,
          gpuLayers: 0,
          threads: 4,
          ...defaultBatchingForImageTokens(DEFAULT_IMAGE_MAX_TOKENS),
          ropeScaling: "none",
          ropeFreqBase: 0,
          ropeFreqScale: 0.0,
          kvCacheTypeK: "f16",
          kvCacheTypeV: "f16",
          mlock: true,
          noMmap: false,
          contBatching: true,
          flashAttn: "auto",
          swaFull: false,
          kvUnified: true,
          noKvOffload: false,
          cacheReuse: 0,
          contextCheckpoints: 32,
          imageMaxTokens: DEFAULT_IMAGE_MAX_TOKENS,
        },
        createdAt: Date.now(),
        updatedAt: Date.now(),
      };
      await createLoadPreset(newLoadPreset);
      existingLoadPaths.add(m.primaryPath);
      if (newLoadPreset.isDefault) hasDefaultLoad = true;
    }

    // Default Inference Preset
    if (!existingInfPaths.has(m.primaryPath)) {
      const hasCoreSamplingParams =
        m.metadata.defaultTemperature !== undefined &&
        m.metadata.defaultTopK !== undefined &&
        m.metadata.defaultTopP !== undefined;

      const newInfPreset: import("../../shared/types").InferencePreset = {
        id: Bun.randomUUIDv7(),
        name: `Default (from GGUF) for ${m.modelName}`,
        sourceModelPath: m.primaryPath,
        isDefault: !hasDefaultInf,
        temperature: m.metadata.defaultTemperature ?? 0.8,
        topK: m.metadata.defaultTopK ?? 40,
        topP: m.metadata.defaultTopP ?? 0.95,
        minP: m.metadata.defaultMinP ?? (hasCoreSamplingParams ? 0 : 0.05),
        repeatPenalty: m.metadata.defaultRepeatPenalty ?? (hasCoreSamplingParams ? 1.0 : 1.1),
        repeatLastN: 64,

        typicalP: 1.0,
        presencePenalty: 0.0,
        frequencyPenalty: 0.0,
        mirostat: 0,
        mirostatTau: 5.0,
        mirostatEta: 0.1,
        dynaTempRange: 0.0,
        dynaTempExponent: 1.0,
        seed: -1,
        maxTokens: -1,
        stopStrings: [],
        thinkingEnabled: true,
        toolCallsEnabled: false,
        tools: [],
        structuredOutput: undefined,
        contextOverflowPolicy: "TruncateMiddle",
        createdAt: Date.now(),
        updatedAt: Date.now(),
      };
      await createInferencePreset(newInfPreset);
      existingInfPaths.add(m.primaryPath);
      if (newInfPreset.isDefault) hasDefaultInf = true;
    }
  }
}
