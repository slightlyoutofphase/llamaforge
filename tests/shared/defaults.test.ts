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
  isDraftSpecType,
  isSpecializedDraftSpecType,
  resolveSpecDraftModelPath,
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

  it("prefers an explicit draft path and otherwise uses the scanned companion", () => {
    expect(
      resolveSpecDraftModelPath(
        "draft-simple",
        "/presets/custom-assistant.gguf",
        "/models/auto-assistant.gguf",
      ),
    ).toBe("/presets/custom-assistant.gguf");
    expect(resolveSpecDraftModelPath("draft-simple", "  ", "/models/auto-assistant.gguf")).toBe(
      "/models/auto-assistant.gguf",
    );
    expect(resolveSpecDraftModelPath("draft-mtp", "", "/models/auto-assistant.gguf")).toBe(
      "/models/auto-assistant.gguf",
    );
    expect(
      resolveSpecDraftModelPath("draft-mtp", "", "/models/auto-assistant.gguf", "draft-mtp"),
    ).toBe("/models/auto-assistant.gguf");
    expect(
      resolveSpecDraftModelPath("draft-simple", "", "/models/auto-assistant.gguf", "draft-mtp"),
    ).toBeUndefined();
    expect(
      resolveSpecDraftModelPath("off", "/models/auto-assistant.gguf", undefined),
    ).toBeUndefined();
    expect(
      resolveSpecDraftModelPath("draft-dflash", "", "/models/auto-dflash.gguf", "draft-dflash"),
    ).toBe("/models/auto-dflash.gguf");
    expect(
      resolveSpecDraftModelPath("draft-dspark", "", "/models/auto-dspark.gguf", "draft-dspark"),
    ).toBe("/models/auto-dspark.gguf");
    expect(
      resolveSpecDraftModelPath("draft-eagle3", "", "/models/auto-eagle3.gguf", "draft-eagle3"),
    ).toBe("/models/auto-eagle3.gguf");
    expect(
      resolveSpecDraftModelPath("draft-simple", "", "/models/auto-dflash.gguf", "draft-dflash"),
    ).toBeUndefined();
    expect(
      resolveSpecDraftModelPath("draft-dflash", "", "/models/auto-dspark.gguf", "draft-dspark"),
    ).toBeUndefined();
  });

  it("identifies sidecar draft modes that cannot be loaded as draft-simple", () => {
    expect(isDraftSpecType("draft-dflash")).toBe(true);
    expect(isDraftSpecType("draft-dspark")).toBe(true);
    expect(isDraftSpecType("draft-eagle3")).toBe(true);
    expect(isDraftSpecType("off")).toBe(false);
    expect(isSpecializedDraftSpecType("draft-mtp")).toBe(true);
    expect(isSpecializedDraftSpecType("draft-dflash")).toBe(true);
    expect(isSpecializedDraftSpecType("draft-simple")).toBe(false);
    expect(isSpecializedDraftSpecType("off")).toBe(false);
  });
});
