/**
 * @packageDocumentation
 * Preset repository — CRUD operations for load, inference, and system presets.
 */

import type { InferencePreset, LoadPreset, SystemPromptPreset } from "../../shared/types";
import { detectThinkingConfig } from "../chatTemplateEngine";
import { logWarn } from "../logger";
import { generateGrammarFromSchema } from "../tools";
import { getDb } from "./db";

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
 * Normalizes a raw load-preset config object into the stored load config shape.
 *
 * @param rawConfig - Raw parsed config payload.
 * @returns Normalized load preset configuration.
 */
function normalizeLoadPresetConfig(rawConfig: Record<string, unknown>): LoadPreset["config"] {
  const configWithoutLegacy: Record<string, unknown> = { ...rawConfig };
  delete configWithoutLegacy["flashAttention"];
  const flashAttn = normalizeFlashAttnValue(rawConfig);

  return {
    ...(configWithoutLegacy as unknown as LoadPreset["config"]),
    ...(flashAttn ? { flashAttn } : {}),
  };
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
  if (!id) id = crypto.randomUUID();
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

/**
 * Updates an existing load preset in the database.
 *
 * @param id - Identifier of the preset to update.
 * @param updates - Partial load preset fields to merge into the existing row.
 * @returns A promise that resolves once the preset row has been updated.
 */
export async function updateLoadPreset(id: string, updates: Partial<LoadPreset>): Promise<void> {
  const db = getDb();
  const existing = db
    .query<
      { config_json: string; name: string; model_path: string | null },
      [string]
    >("SELECT config_json, name, model_path FROM load_presets WHERE id = ?")
    .get(id);
  if (!existing) return;
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
}

/**
 * Deletes a mutable load preset.
 *
 * @param id - Identifier of the load preset to remove.
 * @returns A promise that resolves once the delete statement has completed.
 */
export async function deleteLoadPreset(id: string): Promise<void> {
  getDb().prepare("DELETE FROM load_presets WHERE id = ? AND is_readonly = 0").run(id);
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

  if (!id) id = crypto.randomUUID();
  if (!createdAt) createdAt = Date.now();
  if (!updatedAt) updatedAt = createdAt;

  if (config.structuredOutput?.enabled && config.structuredOutput.schema) {
    config.structuredOutput.grammar = generateGrammarFromSchema(
      config.structuredOutput.schema as Record<string, unknown>,
    );
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
): Promise<void> {
  const db = getDb();
  const existingRow = db
    .query<
      { config_json: string; name: string },
      [string]
    >("SELECT config_json, name FROM inference_presets WHERE id = ?")
    .get(id);
  if (!existingRow) return;

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

  if (newConfig.structuredOutput?.enabled && newConfig.structuredOutput.schema) {
    if (configUpdates.structuredOutput?.schema) {
      newConfig.structuredOutput.grammar = generateGrammarFromSchema(
        configUpdates.structuredOutput.schema as Record<string, unknown>,
      );
    } else if (!newConfig.structuredOutput.grammar) {
      newConfig.structuredOutput.grammar = generateGrammarFromSchema(
        newConfig.structuredOutput.schema as Record<string, unknown>,
      );
    }
  }

  const newName = name ?? existingRow.name;

  db.prepare(
    "UPDATE inference_presets SET name = ?, config_json = ?, updated_at = ? WHERE id = ?",
  ).run(newName, JSON.stringify(newConfig), Date.now(), id);
}

/**
 * Deletes a mutable inference preset.
 *
 * @param id - Identifier of the inference preset to remove.
 * @returns A promise that resolves once the delete statement has completed.
 */
export async function deleteInferencePreset(id: string): Promise<void> {
  getDb().prepare("DELETE FROM inference_presets WHERE id = ? AND is_default = 0").run(id);
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
  if (!id) id = crypto.randomUUID();
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
): Promise<void> {
  const db = getDb();
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
  if (setStmts.length === 0) return;

  setStmts.push("updated_at = ?");
  args.push(Date.now());
  args.push(id);

  db.prepare(`UPDATE system_presets SET ${setStmts.join(", ")} WHERE id = ?`).run(...args);
}

/**
 * Deletes a system prompt preset.
 *
 * @param id - Identifier of the system prompt preset to remove.
 * @returns A promise that resolves once the delete statement has completed.
 */
export async function deleteSystemPreset(id: string): Promise<void> {
  getDb().prepare("DELETE FROM system_presets WHERE id = ?").run(id);
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

  for (const m of models) {
    if (!m.metadata) continue;

    // Default Load Preset
    if (!existingLoadPaths.has(m.primaryPath)) {
      const newLoadPreset: LoadPreset = {
        id: Bun.randomUUIDv7(),
        name: "Default (from GGUF)",
        modelPath: m.primaryPath,
        isDefault: true,
        isReadonly: true,
        chatTemplateOverride: m.metadata.chatTemplate ?? undefined,
        thinkingTagOverride: detectThinkingConfig(m.metadata.architecture),
        config: {
          modelPath: m.primaryPath,
          mmProjPath: m.mmProjPath,
          contextSize: m.metadata.contextLength || 4096,
          contextShift: false,
          gpuLayers: -1,
          threads: -1,
          batchSize: 2048,
          microBatchSize: 512,
          ropeScaling: "none",
          ropeFreqBase: 0,
          ropeFreqScale: 0.0,
          kvCacheTypeK: "f16",
          kvCacheTypeV: "f16",
          mlock: false,
          noMmap: false,
          contBatching: true,
          flashAttn: "auto",
          swaFull: false,
          kvUnified: true,
          noKvOffload: false,
          cacheReuse: 0,
          imageMaxTokens: 560,
        },
        createdAt: Date.now(),
        updatedAt: Date.now(),
      };
      await createLoadPreset(newLoadPreset);
      existingLoadPaths.add(m.primaryPath);
    }

    // Default Inference Preset
    if (!existingInfPaths.has(m.primaryPath)) {
      const newInfPreset: import("../../shared/types").InferencePreset = {
        id: Bun.randomUUIDv7(),
        name: "Default (from GGUF)",
        sourceModelPath: m.primaryPath,
        isDefault: true,
        temperature: m.metadata.defaultTemperature ?? 0.8,
        topK: m.metadata.defaultTopK ?? 40,
        topP: m.metadata.defaultTopP ?? 0.95,
        minP: m.metadata.defaultMinP ?? 0.05,
        repeatPenalty: m.metadata.defaultRepeatPenalty ?? 1.1,
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
    }
  }
}
