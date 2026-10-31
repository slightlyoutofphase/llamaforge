/**
 * @packageDocumentation
 * Decides which load and inference presets belong to a model, and copies
 * settings from one preset onto another without taking its model files.
 */

import { modelPathsMatch } from "./templateCapabilities";
import type { InferencePreset, LoadPreset } from "./types";

/**
 * Whether a preset bound to `presetModelPath` may be offered for `modelPath`.
 *
 * A blank binding is global and matches every model, including when no model
 * is selected. A bound preset matches only that file. Slash direction and
 * drive-letter case are ignored.
 *
 * @param presetModelPath - Load preset `modelPath` or inference preset `sourceModelPath`.
 * @param modelPath - Model file the user is loading or chatting with.
 * @returns `true` when the preset should appear for that model.
 */
export function presetAppliesToModel(
  presetModelPath: string | null | undefined,
  modelPath: string | null | undefined,
): boolean {
  const bound = presetModelPath?.trim() ?? "";
  if (!bound) return true;
  const target = modelPath?.trim() ?? "";
  if (!target) return false;
  return modelPathsMatch(bound, target);
}

/**
 * Load presets that can be used with a model: its own presets plus globals.
 *
 * @param presets - Full load-preset list.
 * @param modelPath - Primary GGUF the presets would load.
 * @returns Presets whose binding is empty or refers to `modelPath`.
 */
export function loadPresetsForModel<T extends { modelPath?: string | null | undefined }>(
  presets: readonly T[],
  modelPath: string | null | undefined,
): T[] {
  return presets.filter((preset) => presetAppliesToModel(preset.modelPath, modelPath));
}

/**
 * Inference presets that can sample a model: its own presets plus globals.
 *
 * @param presets - Full inference-preset list.
 * @param modelPath - Primary GGUF currently loaded, if any.
 * @returns Presets whose binding is empty or refers to `modelPath`.
 */
export function inferencePresetsForModel<T extends { sourceModelPath?: string | null | undefined }>(
  presets: readonly T[],
  modelPath: string | null | undefined,
): T[] {
  return presets.filter((preset) => presetAppliesToModel(preset.sourceModelPath, modelPath));
}

/**
 * Fields used to choose which load preset a model card should apply.
 */
export interface LoadPresetPickRef {
  /** Preset identifier. */
  id: string;
  /** GGUF this preset loads, or blank when the preset is global. */
  modelPath?: string | null | undefined;
  /** Whether this preset is the marked default. */
  isDefault: boolean;
}

/**
 * Picks the load preset a model card should apply.
 *
 * Order: a preferred id that actually belongs to the model, the first preset
 * bound to that file, a global default, then the first applicable preset.
 * A stored id for a different GGUF is ignored.
 *
 * @param presets - Full load-preset list.
 * @param modelPath - Primary GGUF being loaded.
 * @param preferredId - Id the user last chose for this file, if any.
 * @returns The preset to show and load, or `undefined` when none apply.
 */
export function pickLoadPresetForModel<T extends LoadPresetPickRef>(
  presets: readonly T[],
  modelPath: string,
  preferredId?: string | null,
): T | undefined {
  const applicable = loadPresetsForModel(presets, modelPath);
  if (applicable.length === 0) return undefined;
  if (preferredId) {
    const preferred = applicable.find((preset) => preset.id === preferredId);
    if (preferred) return preferred;
  }
  const bound = applicable.find(
    (preset) => !!preset.modelPath?.trim() && modelPathsMatch(preset.modelPath, modelPath),
  );
  if (bound) return bound;
  return applicable.find((preset) => preset.isDefault) ?? applicable[0];
}

/**
 * Copies inference settings onto `target` and leaves its identity alone.
 *
 * Sampling, tools, structured output, and thinking flags come from `source`.
 * The target keeps its id, name, default flag, timestamps, and `sourceModelPath`,
 * so a preset for one GGUF can match another variant without being reassigned.
 *
 * @param target - Preset being edited.
 * @param source - Preset whose settings should be adopted.
 * @returns A new preset object. Neither input is mutated.
 */
export function copyInferencePresetSettings(
  target: InferencePreset,
  source: InferencePreset,
): InferencePreset {
  if (target.id === source.id) return target;
  const copied = structuredClone(source);
  return {
    ...copied,
    id: target.id,
    name: target.name,
    sourceModelPath: target.sourceModelPath,
    isDefault: target.isDefault,
    createdAt: target.createdAt,
    updatedAt: target.updatedAt,
  };
}

/**
 * Copies load settings onto `target` and leaves its model files alone.
 *
 * Context, batching, cache, RoPE, speculative mode, the chat-template override,
 * and thinking tags come from `source`. The target keeps its id, name, flags,
 * timestamps, primary GGUF, mmproj path, and draft-model path.
 *
 * @param target - Preset being edited.
 * @param source - Preset whose settings should be adopted.
 * @returns A new preset object. Neither input is mutated.
 */
export function copyLoadPresetSettings(target: LoadPreset, source: LoadPreset): LoadPreset {
  if (target.id === source.id) return target;
  const copied = structuredClone(source);
  const config = structuredClone(source.config);
  config.modelPath = target.config.modelPath;
  config.mmProjPath = target.config.mmProjPath;
  config.specDraftModelPath = target.config.specDraftModelPath;
  if (target.config.presetId !== undefined) {
    config.presetId = target.config.presetId;
  } else {
    delete config.presetId;
  }
  return {
    ...copied,
    id: target.id,
    name: target.name,
    modelPath: target.modelPath,
    isDefault: target.isDefault,
    isReadonly: target.isReadonly,
    createdAt: target.createdAt,
    updatedAt: target.updatedAt,
    config,
  };
}
