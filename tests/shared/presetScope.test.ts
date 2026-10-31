/**
 * @packageDocumentation
 * Tests for per-model preset filtering and copying settings without model paths.
 */

import { describe, expect, it } from "bun:test";
import { createDefaultInferenceSampling, createDefaultLoadConfig } from "../../src/shared/defaults";
import {
  copyInferencePresetSettings,
  copyLoadPresetSettings,
  inferencePresetsForModel,
  loadPresetsForModel,
  pickLoadPresetForModel,
  presetAppliesToModel,
} from "../../src/shared/presetScope";
import type { InferencePreset, LoadPreset } from "../../src/shared/types";

describe("presetAppliesToModel", () => {
  it("treats a blank binding as global", () => {
    expect(presetAppliesToModel("", "/models/a.gguf")).toBe(true);
    expect(presetAppliesToModel(undefined, undefined)).toBe(true);
  });

  it("hides a bound preset when no model is selected", () => {
    expect(presetAppliesToModel("/models/a.gguf", undefined)).toBe(false);
  });

  it("matches the same file across slash direction and drive-letter case", () => {
    expect(presetAppliesToModel("D:\\Models\\A.gguf", "d:/Models/A.gguf")).toBe(true);
    expect(presetAppliesToModel("D:/Models/A.gguf", "D:/Models/B.gguf")).toBe(false);
  });
});

describe("load and inference preset lists", () => {
  const loadPresets = [
    { id: "global", modelPath: "", isDefault: true },
    { id: "a", modelPath: "D:\\Models\\A.gguf", isDefault: false },
    { id: "b", modelPath: "D:/Models/B.gguf", isDefault: false },
  ];

  it("keeps globals and the matching file, including a slash-insensitive path", () => {
    expect(loadPresetsForModel(loadPresets, "d:/models/a.gguf").map((preset) => preset.id)).toEqual(
      ["global", "a"],
    );
  });

  it("prefers the preset bound to the file over a global default", () => {
    expect(pickLoadPresetForModel(loadPresets, "d:/models/a.gguf")?.id).toBe("a");
  });

  it("ignores a remembered id that belongs to a different file", () => {
    expect(pickLoadPresetForModel(loadPresets, "d:/models/a.gguf", "b")?.id).toBe("a");
  });

  it("filters inference presets the same way", () => {
    const presets = [
      { id: "standard", sourceModelPath: undefined },
      { id: "a", sourceModelPath: "/models/a.gguf" },
      { id: "b", sourceModelPath: "/models/b.gguf" },
    ];
    expect(inferencePresetsForModel(presets, "/models/b.gguf").map((preset) => preset.id)).toEqual([
      "standard",
      "b",
    ]);
  });
});

describe("copy preset settings", () => {
  it("copies inference settings and keeps the target model binding", () => {
    const target: InferencePreset = {
      id: "target",
      name: "FineTune B",
      sourceModelPath: "/models/b.gguf",
      isDefault: false,
      ...createDefaultInferenceSampling(),
      temperature: 0.8,
      tools: [],
      createdAt: 1,
      updatedAt: 2,
    };
    const source: InferencePreset = {
      ...target,
      id: "source",
      name: "FineTune A",
      sourceModelPath: "/models/a.gguf",
      isDefault: true,
      temperature: 0.2,
      topK: 12,
      tools: [{ name: "calculate", description: "math", parameters: { type: "object" } }],
      createdAt: 3,
      updatedAt: 4,
    };

    const copied = copyInferencePresetSettings(target, source);
    source.tools.push({ name: "extra", description: "nope", parameters: { type: "object" } });

    expect(copied.id).toBe("target");
    expect(copied.name).toBe("FineTune B");
    expect(copied.sourceModelPath).toBe("/models/b.gguf");
    expect(copied.isDefault).toBe(false);
    expect(copied.createdAt).toBe(1);
    expect(copied.temperature).toBe(0.2);
    expect(copied.topK).toBe(12);
    expect(copied.tools.map((tool) => tool.name)).toEqual(["calculate"]);
  });

  it("copies load settings and keeps the target model paths", () => {
    const target: LoadPreset = {
      id: "target",
      name: "FineTune B",
      modelPath: "/models/b.gguf",
      isDefault: false,
      isReadonly: false,
      config: {
        ...createDefaultLoadConfig("/models/b.gguf"),
        mmProjPath: "/models/b.mmproj",
        specDraftModelPath: "/models/b-draft.gguf",
        gpuLayers: 4,
      },
      chatTemplateOverride: "target-template",
      createdAt: 1,
      updatedAt: 2,
    };
    const source: LoadPreset = {
      id: "source",
      name: "FineTune A",
      modelPath: "/models/a.gguf",
      isDefault: true,
      isReadonly: true,
      config: {
        ...createDefaultLoadConfig("/models/a.gguf"),
        mmProjPath: "/models/a.mmproj",
        specDraftModelPath: "/models/a-draft.gguf",
        specType: "draft-simple",
        gpuLayers: 33,
        contextSize: 16384,
        presetId: "source",
      },
      chatTemplateOverride: "source-template",
      preserveThinking: true,
      createdAt: 3,
      updatedAt: 4,
    };

    const copied = copyLoadPresetSettings(target, source);

    expect(copied.id).toBe("target");
    expect(copied.name).toBe("FineTune B");
    expect(copied.modelPath).toBe("/models/b.gguf");
    expect(copied.isDefault).toBe(false);
    expect(copied.isReadonly).toBe(false);
    expect(copied.config.modelPath).toBe("/models/b.gguf");
    expect(copied.config.mmProjPath).toBe("/models/b.mmproj");
    expect(copied.config.specDraftModelPath).toBe("/models/b-draft.gguf");
    expect(copied.config.presetId).toBeUndefined();
    expect(copied.config.gpuLayers).toBe(33);
    expect(copied.config.contextSize).toBe(16384);
    expect(copied.config.specType).toBe("draft-simple");
    expect(copied.chatTemplateOverride).toBe("source-template");
    expect(copied.preserveThinking).toBe(true);
    expect(source.config.modelPath).toBe("/models/a.gguf");
  });
});
