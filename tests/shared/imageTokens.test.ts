/**
 * @packageDocumentation
 * Tests for image-token ubatch floor helpers.
 */

import { describe, expect, it } from "bun:test";
import {
  DEFAULT_IMAGE_MAX_TOKENS,
  applyImageTokenBatchFloor,
  defaultBatchingForImageTokens,
  minUbatchForImageTokens,
} from "../../src/shared/imageTokens";

describe("imageTokens", () => {
  it("uses a 2x ubatch floor for the default 560-token budget", () => {
    expect(minUbatchForImageTokens(DEFAULT_IMAGE_MAX_TOKENS)).toBe(1120);
    const defaults = defaultBatchingForImageTokens();
    expect(defaults.microBatchSize).toBe(1120);
    expect(defaults.batchSize).toBeGreaterThanOrEqual(1120);
  });

  it("raises undersized ubatch and batch values to the image-token floor", () => {
    const floored = applyImageTokenBatchFloor(512, 128, 560);
    expect(floored.microBatchSize).toBe(1120);
    expect(floored.batchSize).toBe(1120);
  });

  it("leaves batching unchanged when no image budget is set", () => {
    expect(applyImageTokenBatchFloor(2048, 512, undefined)).toEqual({
      batchSize: 2048,
      microBatchSize: 512,
    });
  });
});
