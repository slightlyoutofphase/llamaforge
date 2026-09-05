/**
 * @packageDocumentation
 * Tests for image-token ubatch floor helpers.
 */

import { describe, expect, it } from "bun:test";
import {
  DEFAULT_IMAGE_MAX_TOKENS,
  DEFAULT_IMAGE_MIN_TOKENS,
  applyImageTokenBatchFloor,
  defaultBatchingForImageTokens,
  minUbatchForImageTokens,
  resolveImageMinTokens,
} from "../../src/shared/imageTokens";

describe("imageTokens", () => {
  it("uses n_ubatch >= n_tokens as the Gemma 4 floor, not a multiple of the budget", () => {
    expect(minUbatchForImageTokens(DEFAULT_IMAGE_MAX_TOKENS)).toBe(560);
    const gemmaDefaults = defaultBatchingForImageTokens(DEFAULT_IMAGE_MAX_TOKENS, "gemma4");
    expect(gemmaDefaults.microBatchSize).toBe(560);
    expect(gemmaDefaults.batchSize).toBeGreaterThanOrEqual(560);
  });

  it("does not raise ubatch for non-Gemma architectures", () => {
    const qwen = applyImageTokenBatchFloor(2048, 512, 1120, "qwen3vl");
    expect(qwen).toEqual({ batchSize: 2048, microBatchSize: 512 });
    expect(defaultBatchingForImageTokens(DEFAULT_IMAGE_MAX_TOKENS)).toEqual({
      batchSize: 2048,
      microBatchSize: 512,
    });
  });

  it("raises undersized Gemma 4 ubatch to the image-token count", () => {
    const floored = applyImageTokenBatchFloor(512, 128, 560, "gemma4");
    expect(floored.microBatchSize).toBe(560);
    expect(floored.batchSize).toBe(560);
  });

  it("leaves batching unchanged when no image budget is set", () => {
    expect(applyImageTokenBatchFloor(2048, 512, undefined, "gemma4")).toEqual({
      batchSize: 2048,
      microBatchSize: 512,
    });
  });

  it("pairs image-min-tokens with max and never exceeds the max budget", () => {
    expect(resolveImageMinTokens(560, undefined)).toBe(DEFAULT_IMAGE_MIN_TOKENS);
    expect(resolveImageMinTokens(560, 70)).toBe(70);
    expect(resolveImageMinTokens(70, 140)).toBe(70);
  });
});
