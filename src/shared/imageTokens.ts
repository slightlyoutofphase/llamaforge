/**
 * @packageDocumentation
 * Shared image-token budget helpers used when constructing llama-server load args.
 *
 * Gemma 4's vision encoder uses non-causal attention, so every image token must
 * fit in a single `--ubatch-size`. Undersized ubatch trips `GGML_ASSERT` and kills
 * the process. A 2× floor on the selected VIR budget is the safe default.
 */

/** VIR budgets offered in the load-preset editor (Gemma 4 supported sizes). */
export const IMAGE_MAX_TOKEN_OPTIONS = [70, 140, 280, 560, 1120] as const;

/** Default `--image-max-tokens` used by seeded and auto-generated load presets. */
export const DEFAULT_IMAGE_MAX_TOKENS = 560;

/** Multiplier applied to the image-token budget to derive a safe ubatch floor. */
export const IMAGE_TOKEN_UBATCH_MULTIPLIER = 2;

/** GPU-oriented default `--batch-size` before the image-token floor is applied. */
export const DEFAULT_GPU_BATCH_SIZE = 2048;

/** GPU-oriented default `--ubatch-size` before the image-token floor is applied. */
export const DEFAULT_GPU_MICRO_BATCH_SIZE = 512;

/**
 * Minimum `--ubatch-size` required for a given `--image-max-tokens` budget.
 *
 * @param imageMaxTokens - Selected image-token budget.
 * @returns Positive integer ubatch floor (approximately 2× the budget).
 */
export function minUbatchForImageTokens(imageMaxTokens: number): number {
  if (!Number.isFinite(imageMaxTokens) || imageMaxTokens <= 0) {
    return 1;
  }
  return Math.max(1, Math.ceil(imageMaxTokens * IMAGE_TOKEN_UBATCH_MULTIPLIER));
}

/**
 * Raises batch and micro-batch sizes so they can hold the selected image-token budget.
 *
 * @param batchSize - Current `--batch-size`.
 * @param microBatchSize - Current `--ubatch-size`.
 * @param imageMaxTokens - Selected `--image-max-tokens`, or `undefined` when unset.
 * @returns Batch sizes that satisfy the vision ubatch constraint.
 */
export function applyImageTokenBatchFloor(
  batchSize: number,
  microBatchSize: number,
  imageMaxTokens: number | undefined,
): { batchSize: number; microBatchSize: number } {
  const safeBatch = Number.isFinite(batchSize) ? batchSize : DEFAULT_GPU_BATCH_SIZE;
  const safeUbatch = Number.isFinite(microBatchSize)
    ? microBatchSize
    : DEFAULT_GPU_MICRO_BATCH_SIZE;
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
 * @returns Batch sizes that satisfy {@link applyImageTokenBatchFloor}.
 */
export function defaultBatchingForImageTokens(imageMaxTokens: number = DEFAULT_IMAGE_MAX_TOKENS): {
  batchSize: number;
  microBatchSize: number;
} {
  return applyImageTokenBatchFloor(
    DEFAULT_GPU_BATCH_SIZE,
    DEFAULT_GPU_MICRO_BATCH_SIZE,
    imageMaxTokens,
  );
}
