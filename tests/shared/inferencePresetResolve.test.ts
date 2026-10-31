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

  it("uses an unbound preset instead of a default bound to a different model", () => {
    expect(resolveInferencePreset(presets, { modelPath: "/models/other.gguf" })?.id).toBe("first");
  });

  it("uses an unbound default for a model that has no preset of its own", () => {
    expect(
      resolveInferencePreset(
        [
          {
            id: "other-model",
            name: "Other",
            sourceModelPath: "/models/other.gguf",
            isDefault: false,
          },
          { id: "standard", name: "Standard", isDefault: true },
        ],
        { modelPath: "/models/qwen.gguf" },
      )?.id,
    ).toBe("standard");
  });

  it("ignores a chat preset bound to a different model", () => {
    expect(
      resolveInferencePreset(presets, {
        chatPresetId: "benqwen",
        modelPath: "/models/other.gguf",
      })?.id,
    ).toBe("first");
  });

  it("matches a model path when only the slash direction differs", () => {
    expect(resolveInferencePreset(presets, { modelPath: "\\models\\qwen.gguf" })?.id).toBe(
      "qwen-default",
    );
  });

  it("returns undefined when every preset is bound to a different model", () => {
    expect(
      resolveInferencePreset(
        [
          {
            id: "qwen-default",
            name: "Default Qwen",
            sourceModelPath: "/models/qwen.gguf",
            isDefault: true,
          },
        ],
        { modelPath: "/models/other.gguf" },
      ),
    ).toBeUndefined();
  });
});
