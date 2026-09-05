/**
 * @packageDocumentation
 * Tests for inference-preset resolution shared by the chat header and stream proxy.
 */

import { describe, expect, it } from "bun:test";
import { resolveInferencePreset } from "../../src/shared/inferencePresetResolve";

const presets = [
  { id: "first", name: "First", isDefault: false },
  {
    id: "qwen-default",
    name: "Default Qwen",
    sourceModelPath: "/models/qwen.gguf",
    isDefault: true,
  },
  { id: "benqwen", name: "BenQwen", sourceModelPath: "/models/qwen.gguf", isDefault: false },
];

describe("resolveInferencePreset", () => {
  it("prefers the chat-stored preset id over model-path matches", () => {
    expect(
      resolveInferencePreset(presets, {
        chatPresetId: "benqwen",
        preferredPresetId: "qwen-default",
        modelPath: "/models/qwen.gguf",
      })?.id,
    ).toBe("benqwen");
  });

  it("uses the UI-preferred id when the chat row has no preset", () => {
    expect(
      resolveInferencePreset(presets, {
        preferredPresetId: "benqwen",
        modelPath: "/models/qwen.gguf",
      })?.id,
    ).toBe("benqwen");
  });

  it("falls back to the first preset bound to the loaded model path", () => {
    expect(
      resolveInferencePreset(presets, {
        modelPath: "/models/qwen.gguf",
      })?.id,
    ).toBe("qwen-default");
  });

  it("does not silently use an unrelated first preset when a model-bound preset exists", () => {
    expect(
      resolveInferencePreset(presets, {
        modelPath: "/models/qwen.gguf",
      })?.id,
    ).not.toBe("first");
  });

  it("uses the marked default when no chat, preference, or model match exists", () => {
    expect(resolveInferencePreset(presets, { modelPath: "/models/other.gguf" })?.id).toBe(
      "qwen-default",
    );
  });
});
