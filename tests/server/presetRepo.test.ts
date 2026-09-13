/**
 * @packageDocumentation
 * Tests for preset repository persistence and CRUD operations.
 */

import { beforeEach, describe, expect, it } from "bun:test";
import { getDb, initDb, resetDb } from "../../src/server/persistence/db";
import {
  createInferencePreset,
  createLoadPreset,
  createSystemPreset,
  deleteInferencePreset,
  deleteLoadPreset,
  deleteSystemPreset,
  ensureModelDefaultPresets,
  getInferencePresets,
  getLoadPresets,
  getSystemPresets,
  updateInferencePreset,
  updateLoadPreset,
  updateSystemPreset,
  assertWritableLoadPresetConfig,
} from "../../src/server/persistence/presetRepo";
import { testInferencePreset, testLoadConfig } from "../fixtures";

describe("presetRepo", () => {
  beforeEach(async () => {
    resetDb();
    await initDb(":memory:");
  });

  it("handles load presets CRUD", async () => {
    await createLoadPreset({
      id: "lp1",
      name: "Load 1",
      isDefault: false,
      isReadonly: false,
      modelPath: "path1",
      config: testLoadConfig("path1", {
        contextSize: 2048,
        gpuLayers: 1,
        threads: 1,
        batchSize: 1,
        microBatchSize: 1,
        ropeFreqBase: 1,
        ropeFreqScale: 1,
        mlock: false,
      }),
      thinkingTagOverride: {
        openTag: "<think>",
        closeTag: "</think>",
        enableToken: "<|think|>",
      },
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });
    let presets = await getLoadPresets();
    expect(presets.find((p) => p.id === "lp1")).toBeDefined();
    expect(presets.find((p) => p.id === "lp1")?.thinkingTagOverride?.openTag).toBe("<think>");
    expect(presets.find((p) => p.id === "lp1")?.config.flashAttn).toBe("auto");

    await updateLoadPreset("lp1", {
      name: "Load 1 Updated",
      config: testLoadConfig("path1-updated", {
        contextSize: 2048,
        gpuLayers: 1,
        threads: 1,
        batchSize: 1,
        microBatchSize: 1,
        ropeFreqBase: 1,
        ropeFreqScale: 1,
        mlock: false,
        flashAttn: "off",
      }),
      thinkingTagOverride: {
        openTag: "<reason>",
        closeTag: "</reason>",
        enableToken: undefined,
      },
    });
    presets = await getLoadPresets();
    expect(presets.find((p) => p.id === "lp1")?.name).toBe("Load 1 Updated");
    expect(presets.find((p) => p.id === "lp1")?.modelPath).toBe("path1-updated");
    expect(presets.find((p) => p.id === "lp1")?.thinkingTagOverride?.openTag).toBe("<reason>");
    expect(presets.find((p) => p.id === "lp1")?.config.flashAttn).toBe("off");

    await deleteLoadPreset("lp1");
    presets = await getLoadPresets();
    expect(presets.find((p) => p.id === "lp1")).toBeUndefined();
  });

  it("persists preserveThinking on load presets independently of inference presets", async () => {
    await createLoadPreset({
      id: "lp-preserve",
      name: "Preserve Load",
      isDefault: false,
      isReadonly: false,
      modelPath: "path-preserve",
      config: testLoadConfig("path-preserve", {
        contextSize: 2048,
        gpuLayers: 1,
        threads: 1,
        batchSize: 1,
        microBatchSize: 1,
        ropeFreqBase: 1,
        ropeFreqScale: 1,
        mlock: false,
      }),
      preserveThinking: true,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });
    let stored = (await getLoadPresets()).find((p) => p.id === "lp-preserve");
    expect(stored?.preserveThinking).toBe(true);

    await updateLoadPreset("lp-preserve", { preserveThinking: false });
    stored = (await getLoadPresets()).find((p) => p.id === "lp-preserve");
    expect(stored?.preserveThinking).toBe(false);
  });

  it("strips unknown load preset config keys and rejects them on the write validator", async () => {
    await createLoadPreset({
      id: "lp-unknown",
      name: "Unknown Keys",
      isDefault: false,
      isReadonly: false,
      modelPath: "path1",
      config: {
        contextSize: 2048,
        extraFlag: "--smuggle",
      } as any,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });
    const stored = (await getLoadPresets()).find((p) => p.id === "lp-unknown");
    expect(stored?.config).toBeDefined();
    if (!stored?.config) return;
    expect("extraFlag" in stored.config).toBe(false);
    expect(stored.config.contextSize).toBe(2048);

    expect(() =>
      assertWritableLoadPresetConfig({
        modelPath: "/models/model.gguf",
        extraFlag: "--smuggle",
      }),
    ).toThrow("Unknown load preset config fields");
  });

  it("normalizes legacy flat and wrapped flashAttention presets on load", async () => {
    const db = getDb();
    const now = Date.now();
    db.prepare(
      "INSERT INTO load_presets (id, name, model_path, is_default, is_readonly, config_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
    ).run(
      "legacy-flat",
      "Legacy Flat",
      "/models/legacy-flat.gguf",
      0,
      0,
      JSON.stringify({
        modelPath: "/models/legacy-flat.gguf",
        contextSize: 4096,
        flashAttention: true,
      }),
      now,
      now,
    );
    db.prepare(
      "INSERT INTO load_presets (id, name, model_path, is_default, is_readonly, config_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
    ).run(
      "legacy-wrapped",
      "Legacy Wrapped",
      "/models/legacy-wrapped.gguf",
      0,
      0,
      JSON.stringify({
        config: {
          modelPath: "/models/legacy-wrapped.gguf",
          contextSize: 2048,
          flashAttention: false,
        },
      }),
      now,
      now,
    );

    const presets = await getLoadPresets();
    const flatPreset = presets.find((preset) => preset.id === "legacy-flat");
    const wrappedPreset = presets.find((preset) => preset.id === "legacy-wrapped");

    expect(flatPreset?.config.flashAttn).toBe("on");
    expect(wrappedPreset?.config.flashAttn).toBe("off");
    if (flatPreset) {
      expect("flashAttention" in flatPreset.config).toBe(false);
    }
    if (wrappedPreset) {
      expect("flashAttention" in wrappedPreset.config).toBe(false);
    }
  });

  it("handles inference presets CRUD", async () => {
    const calculateTool = {
      name: "calculate",
      description: "Evaluate a mathematical expression.",
      parameters: {
        type: "object",
        properties: { expression: { type: "string" } },
        required: ["expression"],
      },
    };

    await createInferencePreset(
      testInferencePreset({
        id: "ip1",
        name: "Inf 1",
        isDefault: false,
        temperature: 0.7,
        topP: 0.9,
        stopStrings: ["</s>", "User:"],
        toolCallsEnabled: true,
        thinkingEnabled: false,
        tools: [calculateTool],
      }),
    );
    let presets = await getInferencePresets();
    const created = presets.find((p) => p.id === "ip1");
    expect(created).toBeDefined();
    expect(created?.temperature).toBe(0.7);
    expect(created?.stopStrings).toEqual(["</s>", "User:"]);
    expect(created?.toolCallsEnabled).toBe(true);
    expect(created?.thinkingEnabled).toBe(false);
    expect(created?.tools).toEqual([calculateTool]);

    await updateInferencePreset("ip1", {
      temperature: 0.8,
      stopStrings: ["END"],
      toolCallsEnabled: false,
      thinkingEnabled: true,
      tools: [],
    });
    presets = await getInferencePresets();
    const updated = presets.find((p) => p.id === "ip1");
    expect(updated?.temperature).toBe(0.8);
    expect(updated?.stopStrings).toEqual(["END"]);
    expect(updated?.toolCallsEnabled).toBe(false);
    expect(updated?.thinkingEnabled).toBe(true);
    expect(updated?.tools).toEqual([]);

    await deleteInferencePreset("ip1");
    presets = await getInferencePresets();
    expect(presets.find((p) => p.id === "ip1")).toBeUndefined();
  });

  it("handles system presets CRUD", async () => {
    await createSystemPreset({
      id: "sp1",
      name: "Sys 1",
      content: "You are an AI.",
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });
    let presets = await getSystemPresets();
    expect(presets.find((p) => p.id === "sp1")).toBeDefined();

    await updateSystemPreset("sp1", { content: "You are a helpful AI." });
    presets = await getSystemPresets();
    expect(presets.find((p) => p.id === "sp1")?.content).toBe("You are a helpful AI.");

    await deleteSystemPreset("sp1");
    presets = await getSystemPresets();
    expect(presets.find((p) => p.id === "sp1")).toBeUndefined();
  });

  it("creates deletable GGUF defaults with detected thinking config", async () => {
    await ensureModelDefaultPresets([
      {
        publisher: "Publisher",
        modelName: "Gemma",
        primaryPath: "/models/gemma4.gguf",
        metadata: {
          architecture: "gemma4",
          name: "Gemma 4",
          fileSizeBytes: 1,
          contextLength: 8192,
          embeddingLength: undefined,
          attentionHeadCount: undefined,
          attentionHeadCountKv: undefined,
          blockCount: undefined,
          feedForwardLength: undefined,
          quantType: undefined,
          hasVisionEncoder: true,
          hasAudioEncoder: false,
          hasToolCalling: false,
          isDraftModel: false,
          defaultTemperature: 0.7,
          defaultTopK: 20,
          defaultTopP: 0.9,
          defaultMinP: 0.05,
          defaultRepeatPenalty: 1.1,
          chatTemplate: "gguf-template",
        },
      },
    ]);

    const loadPresets = await getLoadPresets();
    const inferencePresets = await getInferencePresets();
    const loadPreset = loadPresets.find((preset) => preset.modelPath === "/models/gemma4.gguf");
    const inferencePreset = inferencePresets.find(
      (preset) => preset.sourceModelPath === "/models/gemma4.gguf",
    );

    expect(loadPreset).toBeDefined();
    expect(loadPreset?.name).toBe("Default (from GGUF) for Gemma");
    expect(loadPresets.filter((preset) => preset.isDefault).length).toBeLessThanOrEqual(1);
    expect(loadPreset?.isReadonly).toBe(false);
    expect(loadPreset?.chatTemplateOverride).toBe("gguf-template");
    expect(loadPreset?.thinkingTagOverride?.enableToken).toBe("<|think|>");
    expect(loadPreset?.config.imageMaxTokens).toBe(560);
    expect(loadPreset?.config.imageMinTokens).toBe(70);
    expect(loadPreset?.config.videoFps).toBe(4);
    expect(loadPreset?.config.microBatchSize).toBe(560);
    expect(loadPreset?.config.batchSize).toBeGreaterThanOrEqual(
      loadPreset?.config.microBatchSize ?? 0,
    );

    expect(inferencePreset).toBeDefined();
    expect(inferencePreset?.name).toBe("Default (from GGUF) for Gemma");
    expect(inferencePresets.filter((preset) => preset.isDefault).length).toBeLessThanOrEqual(1);
  });

  it("uses relaxed minP/repeatPenalty defaults when all three core sampling params are present in GGUF", async () => {
    await ensureModelDefaultPresets([
      {
        publisher: "Publisher",
        modelName: "FullSampling",
        primaryPath: "/models/full.gguf",
        metadata: {
          architecture: "llama",
          name: "Full Sampling",
          fileSizeBytes: 1,
          contextLength: 4096,
          embeddingLength: undefined,
          attentionHeadCount: undefined,
          attentionHeadCountKv: undefined,
          blockCount: undefined,
          feedForwardLength: undefined,
          quantType: undefined,
          hasVisionEncoder: false,
          hasAudioEncoder: false,
          hasToolCalling: false,
          isDraftModel: false,
          defaultTemperature: 0.7,
          defaultTopK: 40,
          defaultTopP: 0.95,
          defaultMinP: undefined,
          defaultRepeatPenalty: undefined,
          chatTemplate: undefined,
        },
      },
    ]);

    const inferencePresets = await getInferencePresets();
    const preset = inferencePresets.find((p) => p.sourceModelPath === "/models/full.gguf");

    expect(preset).toBeDefined();
    expect(preset?.temperature).toBe(0.7);
    expect(preset?.topK).toBe(40);
    expect(preset?.topP).toBe(0.95);
    expect(preset?.minP).toBe(0);
    expect(preset?.repeatPenalty).toBe(1.0);
  });

  it("preserves explicitly provided minP/repeatPenalty even when all three core sampling params are present", async () => {
    await ensureModelDefaultPresets([
      {
        publisher: "Publisher",
        modelName: "ExplicitOverrides",
        primaryPath: "/models/explicit.gguf",
        metadata: {
          architecture: "llama",
          name: "Explicit Overrides",
          fileSizeBytes: 1,
          contextLength: 4096,
          embeddingLength: undefined,
          attentionHeadCount: undefined,
          attentionHeadCountKv: undefined,
          blockCount: undefined,
          feedForwardLength: undefined,
          quantType: undefined,
          hasVisionEncoder: false,
          hasAudioEncoder: false,
          hasToolCalling: false,
          isDraftModel: false,
          defaultTemperature: 0.7,
          defaultTopK: 40,
          defaultTopP: 0.95,
          defaultMinP: 0.02,
          defaultRepeatPenalty: 1.15,
          chatTemplate: undefined,
        },
      },
    ]);

    const inferencePresets = await getInferencePresets();
    const preset = inferencePresets.find((p) => p.sourceModelPath === "/models/explicit.gguf");

    expect(preset).toBeDefined();
    expect(preset?.minP).toBe(0.02);
    expect(preset?.repeatPenalty).toBe(1.15);
  });

  it("uses regular minP/repeatPenalty defaults when core sampling params are missing from GGUF", async () => {
    await ensureModelDefaultPresets([
      {
        publisher: "Publisher",
        modelName: "PartialSampling",
        primaryPath: "/models/partial.gguf",
        metadata: {
          architecture: "llama",
          name: "Partial Sampling",
          fileSizeBytes: 1,
          contextLength: 4096,
          embeddingLength: undefined,
          attentionHeadCount: undefined,
          attentionHeadCountKv: undefined,
          blockCount: undefined,
          feedForwardLength: undefined,
          quantType: undefined,
          hasVisionEncoder: false,
          hasAudioEncoder: false,
          hasToolCalling: false,
          isDraftModel: false,
          defaultTemperature: 0.7,
          defaultTopK: undefined,
          defaultTopP: 0.95,
          defaultMinP: undefined,
          defaultRepeatPenalty: undefined,
          chatTemplate: undefined,
        },
      },
    ]);

    const inferencePresets = await getInferencePresets();
    const preset = inferencePresets.find((p) => p.sourceModelPath === "/models/partial.gguf");

    expect(preset).toBeDefined();
    expect(preset?.temperature).toBe(0.7);
    expect(preset?.topP).toBe(0.95);
    expect(preset?.topK).toBe(40);
    expect(preset?.minP).toBe(0.05);
    expect(preset?.repeatPenalty).toBe(1.1);
  });
});
