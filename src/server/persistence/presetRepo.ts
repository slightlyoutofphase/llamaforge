/**
 * @packageDocumentation
 * Preset repository — CRUD operations for load, inference, and system presets.
 */

import type { InferencePreset, LoadPreset, SystemPromptPreset } from "@shared/types.js";
import { logWarn } from "../logger";
import { generateGrammarFromSchema } from "../tools";
import { getDb } from "./db";

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
    const parsed = safeParse<{ config: LoadPreset["config"]; chatTemplateOverride?: string }>(
      r.config_json,
      { config: {} as LoadPreset["config"] } as any,
    );
    return {
      id: r.id,
      name: r.name,
      modelPath: r.model_path,
      isDefault: Boolean(r.is_default),
      isReadonly: Boolean(r.is_readonly),
      config: parsed.config,
      chatTemplateOverride: parsed.chatTemplateOverride,
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
 * Inserts a newly configured hardware-load preset into the database natively.
 *
 * @param preset - The LoadPreset configuration.
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
  } = preset;
  if (!id) id = crypto.randomUUID();
  if (!createdAt) createdAt = Date.now();
  if (!updatedAt) updatedAt = createdAt;

  const configJson = JSON.stringify({
    config,
    chatTemplateOverride,
  });
  db.prepare(
    `INSERT INTO load_presets (id, name, model_path, is_default, is_readonly, config_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    name,
    modelPath || null,
    isDefault ? 1 : 0,
    isReadonly ? 1 : 0,
    configJson,
    createdAt,
    updatedAt,
  );
}

/**
 * Updates an existing load preset safely inside the database table.
 *
 * @param id - Specific identifier.
 * @param updates - Revisions to the LoadPreset property payload mappings.
 */
export async function updateLoadPreset(id: string, updates: Partial<LoadPreset>): Promise<void> {
  const db = getDb();
  const existing = db
    .query<
      { config_json: string; name: string },
      [string]
    >("SELECT config_json, name FROM load_presets WHERE id = ?")
    .get(id);
  if (!existing) return;
  const currentConfig = safeParse<{ config: LoadPreset["config"]; chatTemplateOverride?: string }>(
    existing.config_json,
    { config: {} as LoadPreset["config"] } as any,
  );

  const newConfigJson = JSON.stringify({
    config: updates.config ?? currentConfig.config,
    chatTemplateOverride:
      updates.chatTemplateOverride !== undefined
        ? updates.chatTemplateOverride
        : currentConfig.chatTemplateOverride,
  });

  const newName = updates.name ?? existing.name;
  db.prepare("UPDATE load_presets SET name = ?, config_json = ?, updated_at = ? WHERE id = ?").run(
    newName,
    newConfigJson,
    Date.now(),
    id,
  );
}

/**
 * Removes a hardware-load preset ensuring it is not globally marked as readonly.
 *
 * @param id - Targeted ID string.
 */
export async function deleteLoadPreset(id: string): Promise<void> {
  getDb().prepare("DELETE FROM load_presets WHERE id = ? AND is_readonly = 0").run(id);
}

/**
 * Submits inference and parsing configuration definitions into SQLite preset persistence.
 *
 * @param preset - Bound InferencePreset map structure.
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
 * Applies delta modifications to persistent config parameters for models running sampling templates.
 *
 * @param id - Unique record ID constraint.
 * @param updates - Shallow configurations for parsing and structuring inference settings.
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
 * Hard-deletes custom user inference settings, ensuring system default bounds are unharmed.
 *
 * @param id - Global unique identifier mapping to the model.
 */
export async function deleteInferencePreset(id: string): Promise<void> {
  getDb().prepare("DELETE FROM inference_presets WHERE id = ? AND is_default = 0").run(id);
}

/**
 * Generates custom system-prompt persistent presets mapping across multiple models natively.
 *
 * @param preset - Structure for mapping metadata contexts internally.
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
 * Synchronizes variable inputs against standard template prompts globally.
 *
 * @param id - System template mapped identity constraint string.
 * @param updates - Parameter contents overriding root mappings.
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
 * Scrub explicitly custom prompt boundaries across the UI configurations safely.
 *
 * @param id - Persisted prompt metadata ID record key.
 */
export async function deleteSystemPreset(id: string): Promise<void> {
  getDb().prepare("DELETE FROM system_presets WHERE id = ?").run(id);
}

/**
 * Executes automatic schema setup matching hardware contexts mapping specifically against all detected valid models internally to seed default presets.
 *
 * @param models - Map list mapping discovered active ModelEntry nodes.
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
        name: `Default for ${m.modelName}`,
        modelPath: m.primaryPath,
        isDefault: false,
        isReadonly: false,
        chatTemplateOverride: m.metadata.chatTemplate || "",
        config: {
          modelPath: m.primaryPath,
          mmProjPath: m.mmProjPath,
          contextSize: m.metadata.contextLength || 4096,
          contextShift: true,
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
        name: `Default for ${m.modelName}`,
        sourceModelPath: m.primaryPath,
        isDefault: false,
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
