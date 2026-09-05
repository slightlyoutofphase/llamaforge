/**
 * @packageDocumentation
 * Resolves which inference sampling preset should apply to a chat.
 *
 * The chat header and llama-server request path must use the same order so
 * the UI label cannot disagree with the sampling payload.
 */

/**
 * Minimum inference-preset fields required to pick an active preset.
 */
export interface InferencePresetRef {
  /** Preset identifier. */
  id: string;
  /** Optional model path this preset was created for. */
  sourceModelPath?: string | undefined;
  /** Whether this preset is the global default. */
  isDefault: boolean;
}

/**
 * Inputs used to choose an inference preset for a chat or completion.
 */
export interface InferencePresetResolveOptions {
  /** Preset id stored on the chat row, when present. */
  chatPresetId?: string | null | undefined;
  /**
   * Preset id the UI is currently displaying for this model (local selection
   * or the id sent with a message), used when the chat row has none.
   */
  preferredPresetId?: string | null | undefined;
  /** Absolute path of the loaded or chat-selected model. */
  modelPath?: string | null | undefined;
}

/**
 * Picks the inference preset that should drive sampling for a chat.
 *
 * Order: chat-stored id, caller-preferred id, first preset bound to the
 * loaded model path, the marked default, then the first preset.
 *
 * @param presets - Available inference presets.
 * @param options - Chat, UI, and model identity used to choose.
 * @returns The matching preset, or `undefined` when the list is empty.
 */
export function resolveInferencePreset<T extends InferencePresetRef>(
  presets: T[],
  options: InferencePresetResolveOptions = {},
): T | undefined {
  if (presets.length === 0) return undefined;

  const byId = (id: string | null | undefined): T | undefined => {
    if (!id) return undefined;
    return presets.find((preset) => preset.id === id);
  };

  return (
    byId(options.chatPresetId) ||
    byId(options.preferredPresetId) ||
    (options.modelPath
      ? presets.find((preset) => preset.sourceModelPath === options.modelPath)
      : undefined) ||
    presets.find((preset) => preset.isDefault) ||
    presets[0]
  );
}
