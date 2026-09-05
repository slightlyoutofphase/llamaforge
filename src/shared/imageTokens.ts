/**
 * @packageDocumentation
 * Shared image-token budget helpers used when constructing llama-server load args.
 *
 * Gemma 4's vision encoder uses non-causal attention, so llama-server requires
 * `n_ubatch >= n_tokens` (`--ubatch-size` at least `--image-max-tokens`). Other
 * architectures do not need this floor. Never raise ubatch past the image-token
 * count itself.
 */

import { isGemma4Architecture } from "./thinkingTags";

/** VIR budgets offered in the load-preset editor (Gemma 4 supported sizes). */
export const IMAGE_MAX_TOKEN_OPTIONS = [70, 140, 280, 560, 1120] as const;

/** Default `--image-max-tokens` used by seeded and auto-generated load presets. */
export const DEFAULT_IMAGE_MAX_TOKENS = 560;

/** Default `--image-min-tokens` paired with {@link DEFAULT_IMAGE_MAX_TOKENS}. */
export const DEFAULT_IMAGE_MIN_TOKENS = 70;

/** GPU-oriented default `--batch-size` before any Gemma 4 image-token floor is applied. */
export const DEFAULT_GPU_BATCH_SIZE = 2048;

/** GPU-oriented default `--ubatch-size` before any Gemma 4 image-token floor is applied. */
export const DEFAULT_GPU_MICRO_BATCH_SIZE = 512;

/**
 * Minimum `--ubatch-size` required so `n_ubatch >= n_tokens` for a Gemma 4 image budget.
 *
 * @param imageMaxTokens - Selected `--image-max-tokens` budget.
 * @returns Positive integer equal to the image-token count (never a multiple of it).
 */
export function minUbatchForImageTokens(imageMaxTokens: number): number {
  if (!Number.isFinite(imageMaxTokens) || imageMaxTokens <= 0) {
    return 1;
  }
  return Math.max(1, Math.ceil(imageMaxTokens));
}

/**
 * Resolves `--image-min-tokens` so it is always set alongside `--image-max-tokens`
 * and never exceeds the max budget.
 *
 * @param imageMaxTokens - Selected `--image-max-tokens` budget.
 * @param imageMinTokens - Explicit minimum, or `undefined` to use {@link DEFAULT_IMAGE_MIN_TOKENS}.
 * @returns A positive integer `min` such that `1 <= min <= imageMaxTokens`.
 */
export function resolveImageMinTokens(
  imageMaxTokens: number,
  imageMinTokens: number | undefined,
): number {
  const requested =
    imageMinTokens !== undefined && Number.isFinite(imageMinTokens)
      ? imageMinTokens
      : DEFAULT_IMAGE_MIN_TOKENS;
  return Math.max(1, Math.min(Math.ceil(requested), Math.ceil(imageMaxTokens)));
}

/**
 * Raises batch and micro-batch sizes so Gemma 4 can hold the selected image-token budget.
 * Non-Gemma architectures are left unchanged: they do not require `n_ubatch >= n_tokens`.
 *
 * @param batchSize - Current `--batch-size`.
 * @param microBatchSize - Current `--ubatch-size`.
 * @param imageMaxTokens - Selected `--image-max-tokens`, or `undefined` when unset.
 * @param architecture - GGUF `general.architecture` of the model being loaded.
 * @returns Batch sizes that satisfy the Gemma 4 vision ubatch constraint when applicable.
 */
export function applyImageTokenBatchFloor(
  batchSize: number,
  microBatchSize: number,
  imageMaxTokens: number | undefined,
  architecture?: string,
): { batchSize: number; microBatchSize: number } {
  const safeBatch = Number.isFinite(batchSize) ? batchSize : DEFAULT_GPU_BATCH_SIZE;
  const safeUbatch = Number.isFinite(microBatchSize)
    ? microBatchSize
    : DEFAULT_GPU_MICRO_BATCH_SIZE;
  if (!isGemma4Architecture(architecture)) {
    return { batchSize: safeBatch, microBatchSize: safeUbatch };
  }
  if (imageMaxTokens === undefined || !Number.isFinite(imageMaxTokens) || imageMaxTokens <= 0) {
    return { batchSize: safeBatch, microBatchSize: safeUbatch };
  }
  const minUbatch = minUbatchForImageTokens(imageMaxTokens);
  const nextUbatch = Math.max(safeUbatch, minUbatch);
  return {
    microBatchSize: nextUbatch,
    batchSize: Math.max(safeBatch, nextUbatch),
  };
}

/**
 * Default GPU batching for a newly created load preset that includes an image-token budget.
 *
 * @param imageMaxTokens - Image-token budget to size against.
 * @param architecture - GGUF architecture; Gemma 4 receives the `n_ubatch >= n_tokens` floor.
 * @returns Batch sizes that satisfy {@link applyImageTokenBatchFloor}.
 */
export function defaultBatchingForImageTokens(
  imageMaxTokens: number = DEFAULT_IMAGE_MAX_TOKENS,
  architecture?: string,
): {
  batchSize: number;
  microBatchSize: number;
} {
  return applyImageTokenBatchFloor(
    DEFAULT_GPU_BATCH_SIZE,
    DEFAULT_GPU_MICRO_BATCH_SIZE,
    imageMaxTokens,
    architecture,
  );
}
