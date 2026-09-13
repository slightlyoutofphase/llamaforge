/**
 * @packageDocumentation
 * Shared test values built from production types rather than parallel test-only shapes.
 */

import { createDefaultInferenceSampling, createDefaultLoadConfig } from "../src/shared/defaults";
import type { RouterServer } from "../src/server/router";
import type { GgufDisplayMetadata, InferencePreset, ModelLoadConfig } from "../src/shared/types";

export type { RouterServer };

/**
 * Stand-in server for HTTP-only router tests. `upgrade` always fails so `/ws`
 * follows the documented upgrade-failure path.
 */
export const noUpgradeServer: RouterServer = {
  upgrade: () => false,
};

/**
 * Attaches the current `fetch.preconnect` onto a fetch implementation so the
 * result is assignable to `typeof fetch`.
 *
 * @param impl - Fetch-compatible function, typically a bun `mock()`.
 * @returns The same function with `preconnect` from the current global fetch.
 */
export function asFetch(
  impl: (input: RequestInfo | URL, init?: RequestInit) => unknown,
): typeof fetch {
  const existingPreconnect = globalThis.fetch.preconnect;
  const preconnect: typeof fetch.preconnect =
    typeof existingPreconnect === "function"
      ? existingPreconnect.bind(globalThis.fetch)
      : (_url: string | URL) => {};
  return Object.assign(impl, { preconnect }) as typeof fetch;
}

/**
 * Assigns or deletes a `Bun.env` entry, including restoring a previously unset key.
 *
 * @param name - Environment variable name.
 * @param value - Value to store, or `undefined` to delete the key.
 * @returns No return value.
 */
export function setBunEnv(name: string, value: string | undefined): void {
  if (value === undefined) {
    delete Bun.env[name];
    return;
  }
  Bun.env[name] = value;
}

/**
 * Builds a complete {@link GgufDisplayMetadata} record for tests.
 *
 * @param overrides - Fields to replace on top of the canonical scan defaults.
 * @returns A full metadata object matching {@link parseGgufMetadata}'s return shape.
 */
export function ggufDisplayMetadata(
  overrides: Partial<GgufDisplayMetadata> = {},
): GgufDisplayMetadata {
  return {
    architecture: "llama",
    name: "Test Model",
    fileSizeBytes: 0,
    contextLength: 8192,
    embeddingLength: 4096,
    attentionHeadCount: 32,
    attentionHeadCountKv: 32,
    blockCount: 32,
    feedForwardLength: 8192,
    quantType: "Q4_K_M",
    hasVisionEncoder: false,
    hasAudioEncoder: false,
    hasToolCalling: false,
    isDraftModel: false,
    defaultTemperature: undefined,
    defaultTopK: undefined,
    defaultTopP: undefined,
    defaultMinP: undefined,
    defaultRepeatPenalty: undefined,
    chatTemplate: undefined,
    ...overrides,
  };
}

/**
 * Builds a complete {@link ModelLoadConfig} for tests.
 *
 * @param modelPath - Absolute model path embedded in the config.
 * @param overrides - Fields to replace on top of {@link createDefaultLoadConfig}.
 * @returns A full load configuration.
 */
export function testLoadConfig(
  modelPath: string = "/models/model.gguf",
  overrides: Partial<ModelLoadConfig> = {},
): ModelLoadConfig {
  return {
    ...createDefaultLoadConfig(modelPath),
    ...overrides,
    modelPath: overrides.modelPath ?? modelPath,
  };
}

/**
 * Builds a complete {@link InferencePreset} for tests.
 *
 * @param overrides - Required identity fields plus any sampling overrides.
 * @returns A full inference preset matching persistence and editor defaults.
 */
export function testInferencePreset(
  overrides: Partial<InferencePreset> & Pick<InferencePreset, "id" | "name">,
): InferencePreset {
  return {
    ...createDefaultInferenceSampling(),
    isDefault: false,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    ...overrides,
  };
}
