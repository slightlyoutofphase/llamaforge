/**
 * @packageDocumentation
 * Tests that backend seeds and UI fallbacks share the same canonical defaults.
 */

import { describe, expect, it } from "bun:test";
import {
  clampVideoFps,
  createDefaultInferenceSampling,
  createDefaultLoadConfig,
  DEFAULT_APP_SETTINGS,
} from "../../src/shared/defaults";

describe("shared defaults", () => {
  it("disables automatic last-model reload by default", () => {
    expect(DEFAULT_APP_SETTINGS.autoloadLastModel).toBe(false);
  });

  it("disables sending extracted video audio by default", () => {
    expect(DEFAULT_APP_SETTINGS.includeVideoAudio).toBe(false);
  });

  it("builds a complete load config matching the load-preset editor", () => {
    const config = createDefaultLoadConfig("/models/demo.gguf");
    expect(config.modelPath).toBe("/models/demo.gguf");
    expect(config.contextSize).toBe(4096);
    expect(config.gpuLayers).toBe(0);
    expect(config.threads).toBe(3);
    expect(config.threadsBatch).toBe(-1);
    expect(config.flashAttn).toBe("auto");
    expect(config.kvUnified).toBe(true);
    expect(config.contBatching).toBe(true);
    expect(config.imageMaxTokens).toBe(560);
    expect(config.imageMinTokens).toBe(70);
    expect(config.videoFps).toBe(4);
    expect(config.specDraftNMin).toBe(0);
    expect(config.batchSize).toBe(2048);
    expect(config.microBatchSize).toBe(512);
  });

  it("clamps video FPS to the llama-server-safe range", () => {
    expect(clampVideoFps(Number.NaN)).toBe(4);
    expect(clampVideoFps(0)).toBe(0.1);
    expect(clampVideoFps(120)).toBe(30);
    expect(clampVideoFps(1.5)).toBe(1.5);
  });

  it("builds inference sampling matching the inference-preset editor", () => {
    const sampling = createDefaultInferenceSampling();
    expect(sampling.temperature).toBe(0.8);
    expect(sampling.topK).toBe(40);
    expect(sampling.topP).toBe(0.95);
    expect(sampling.minP).toBe(0.05);
    expect(sampling.repeatPenalty).toBe(1.1);
    expect(sampling.contextOverflowPolicy).toBe("TruncateMiddle");
    expect(sampling.thinkingEnabled).toBe(true);
    expect(sampling.maxTokens).toBe(-1);
  });
});
