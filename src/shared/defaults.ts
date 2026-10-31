/**
 * @packageDocumentation
 * Canonical default values shared by the backend seeders and the client editors.
 *
 * Every UI control that displays a fallback MUST read from this module so the
 * settings the user sees cannot drift from the values the server actually uses.
 */

import {
  DEFAULT_IMAGE_MAX_TOKENS,
  DEFAULT_IMAGE_MIN_TOKENS,
  defaultBatchingForImageTokens,
} from "./imageTokens";
import {
  DRAFT_SPEC_TYPES,
  SPECIALIZED_DRAFT_SPEC_TYPES,
  type AppSettings,
  type DraftSpeculativeType,
  type InferencePreset,
  type ModelLoadConfig,
  type SpecializedDraftSpecType,
  type SpeculativeDecodeType,
} from "./types";

/** llama-server `--video-fps` default used when a load preset does not override it. */
export const DEFAULT_VIDEO_FPS = 4;

/** Lowest `--video-fps` the load-preset editor will persist. */
export const MIN_VIDEO_FPS = 0.1;

/** Highest `--video-fps` the load-preset editor will persist. */
export const MAX_VIDEO_FPS = 30;

/**
 * Clamps a video sampling rate to the range accepted by llama-server `--video-fps`.
 *
 * @param value - Candidate frames-per-second value.
 * @returns A finite rate between {@link MIN_VIDEO_FPS} and {@link MAX_VIDEO_FPS}.
 */
export function clampVideoFps(value: number): number {
  if (!Number.isFinite(value)) return DEFAULT_VIDEO_FPS;
  return Math.min(MAX_VIDEO_FPS, Math.max(MIN_VIDEO_FPS, value));
}

/**
 * Application settings that do not depend on the host filesystem.
 * `modelsPath` is resolved to an absolute default by the settings repository.
 */
export const DEFAULT_APP_SETTINGS: Omit<AppSettings, "modelsPath"> & { modelsPath: string } = {
  serverPort: 11435,
  modelsPath: "Models",
  theme: "system",
  accentColor: "#7b6ef6",
  fontSize: 14,
  chatBubbleStyle: "bubble",
  autonameEnabled: true,
  autoloadLastModel: false,
  includeVideoAudio: false,
  llamaPortRangeMin: 12000,
  llamaPortRangeMax: 13000,
  requestTimeoutSeconds: 60,
  logLevel: "info",
  showConsoleOnStartup: false,
};

/**
 * Sampling and overflow fields used when creating inference presets and when
 * hydrating incomplete rows from persistence.
 */
export type DefaultInferenceSampling = Omit<
  InferencePreset,
  "id" | "name" | "isDefault" | "createdAt" | "updatedAt" | "sourceModelPath"
>;

/**
 * Builds the canonical default inference sampling configuration.
 *
 * @returns Default inference fields matching the editor and llama-server request fallbacks.
 */
export function createDefaultInferenceSampling(): DefaultInferenceSampling {
  return {
    temperature: 0.8,
    topK: 40,
    topP: 0.95,
    minP: 0.05,
    repeatPenalty: 1.1,
    repeatLastN: 64,
    typicalP: 1.0,
    presencePenalty: 0.0,
    frequencyPenalty: 0.0,
    mirostat: 0,
    mirostatTau: 5.0,
    mirostatEta: 0.1,
    dynaTempRange: 0.0,
    dynaTempExponent: 1.0,
    dryMultiplier: 0.0,
    dryBase: 1.75,
    dryAllowedLength: 2,
    dryPenaltyLastN: 64,
    drySequenceBreakers: ["\n", ":", '"', "*"],
    xtcProbability: 0.0,
    xtcThreshold: 0.1,
    seed: -1,
    maxTokens: -1,
    stopStrings: [],
    toolCallsEnabled: false,
    tools: [],
    structuredOutput: undefined,
    contextOverflowPolicy: "TruncateMiddle",
    thinkingEnabled: true,
  };
}

/**
 * Builds the canonical default llama-server load configuration.
 *
 * @param modelPath - Absolute model path to embed in the config, or an empty string for a blank preset.
 * @returns A complete {@link ModelLoadConfig} matching the load-preset editor defaults.
 */
export function createDefaultLoadConfig(modelPath: string = ""): ModelLoadConfig {
  return {
    modelPath,
    contextSize: 4096,
    contextShift: false,
    gpuLayers: 0,
    threads: 3,
    threadsBatch: -1,
    ...defaultBatchingForImageTokens(DEFAULT_IMAGE_MAX_TOKENS),
    ropeScaling: "none",
    ropeFreqBase: 0,
    ropeFreqScale: 0,
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
    imageMinTokens: DEFAULT_IMAGE_MIN_TOKENS,
    videoFps: DEFAULT_VIDEO_FPS,
    logLevel: 3,
    seedOverride: -1,
    specType: "off",
    specDraftNMax: 8,
    specDraftNMin: 0,
    specDraftPMin: 0.75,
    specDraftModelPath: "",
  };
}

/**
 * Largest context window written into an auto-created load preset.
 *
 * A GGUF can advertise 128k to 1M tokens of native context. Seeding that value
 * asks llama-server for a KV cache that often does not fit, and an explicit
 * `--ctx-size` prevents `--fit` from shrinking it.
 */
export const SEEDED_LOAD_CONTEXT_CAP = 8192;

/**
 * Context size stored on a load preset created from a scanned model.
 *
 * Missing or non-positive native lengths fall back to 4096. Longer native
 * windows are capped so the first load stays within a modest KV cache.
 *
 * @param nativeContextLength - `contextLength` from GGUF metadata, when known.
 * @returns Context size in tokens for the seeded preset.
 */
export function seededLoadContextSize(nativeContextLength: number | undefined): number {
  const native =
    typeof nativeContextLength === "number" &&
    Number.isFinite(nativeContextLength) &&
    nativeContextLength > 0
      ? Math.trunc(nativeContextLength)
      : 4096;
  return Math.min(native, SEEDED_LOAD_CONTEXT_CAP);
}

/**
 * Returns whether a speculative mode loads a sidecar draft GGUF.
 *
 * @param specType - Selected speculative decoding mode.
 * @returns `true` when llama-server should receive `--spec-draft-model`.
 */
export function isDraftSpecType(
  specType: SpeculativeDecodeType | undefined,
): specType is DraftSpeculativeType {
  return specType !== undefined && (DRAFT_SPEC_TYPES as readonly string[]).includes(specType);
}

/**
 * Returns whether a sidecar requires a specialized `--spec-type` rather than `draft-simple`.
 *
 * @param specType - Detected or selected speculative decoding mode.
 * @returns `true` for MTP, DFlash, DSpark, and Eagle3 companions.
 */
export function isSpecializedDraftSpecType(
  specType: string | undefined,
): specType is SpecializedDraftSpecType {
  return (
    specType !== undefined && (SPECIALIZED_DRAFT_SPEC_TYPES as readonly string[]).includes(specType)
  );
}

/**
 * Resolves the draft GGUF path that should be sent to llama-server.
 * An explicit preset path wins; otherwise the scanned same-directory companion is used
 * when its required `--spec-type` matches the selected mode.
 *
 * @param specType - Selected speculative decoding mode.
 * @param configuredPath - Path stored on the load preset, if any.
 * @param detectedPath - Companion draft path discovered next to the main GGUF.
 * @param detectedSpecType - `--spec-type` required by the scanned companion, if known.
 * @returns Path to pass as `--spec-draft-model`, or `undefined` to omit the flag.
 */
export function resolveSpecDraftModelPath(
  specType: ModelLoadConfig["specType"],
  configuredPath: string | undefined,
  detectedPath: string | undefined,
  detectedSpecType?: DraftSpeculativeType | undefined,
): string | undefined {
  if (!isDraftSpecType(specType)) {
    return undefined;
  }
  const configured = configuredPath?.trim();
  if (configured) return configured;
  const detected = detectedPath?.trim();
  if (!detected) return undefined;
  if (detectedSpecType && detectedSpecType !== specType) return undefined;
  return detected;
}
