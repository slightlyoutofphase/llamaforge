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
} from "../../src/server/persistence/presetRepo";

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
      config: {
        contextSize: 2048,
        gpuLayers: 1,
        threads: 1,
        batchSize: 1,
        microBatchSize: 1,
        ropeScaling: "none",
        ropeFreqBase: 1,
        ropeFreqScale: 1,
        kvCacheTypeK: "f16",
        kvCacheTypeV: "f16",
        mlock: false,
        noMmap: false,
        flashAttn: "auto",
      },
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
      config: {
        contextSize: 2048,
        gpuLayers: 1,
        threads: 1,
        batchSize: 1,
        microBatchSize: 1,
        ropeScaling: "none",
        ropeFreqBase: 1,
        ropeFreqScale: 1,
        kvCacheTypeK: "f16",
        kvCacheTypeV: "f16",
        mlock: false,
        noMmap: false,
        modelPath: "path1-updated",
        flashAttn: "off",
      },
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
      expect((flatPreset.config as Record<string, unknown>).flashAttention).toBeUndefined();
    }
    if (wrappedPreset) {
      expect((wrappedPreset.config as Record<string, unknown>).flashAttention).toBeUndefined();
    }
  });

  it("handles inference presets CRUD", async () => {
    await createInferencePreset({
      id: "ip1",
      name: "Inf 1",
      isDefault: false,
      temperature: 0.7,
      topP: 0.9,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });
    let presets = await getInferencePresets();
    expect(presets.find((p) => p.id === "ip1")).toBeDefined();

    await updateInferencePreset("ip1", { temperature: 0.8 });
    presets = await getInferencePresets();
    expect(presets.find((p) => p.id === "ip1")?.temperature).toBe(0.8);

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

  it("creates readonly GGUF defaults with detected thinking config", async () => {
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
          defaultTemperature: 0.7,
          defaultTopK: 20,
          defaultTopP: 0.9,
          defaultMinP: 0.05,
          defaultRepeatPenalty: 1.1,
          chatTemplate: "gguf-template",
          bosToken: undefined,
          eosToken: undefined,
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
    expect(loadPreset?.isDefault).toBe(true);
    expect(loadPreset?.isReadonly).toBe(true);
    expect(loadPreset?.chatTemplateOverride).toBe("gguf-template");
    expect(loadPreset?.thinkingTagOverride?.enableToken).toBe("<|think|>");
    expect(loadPreset?.config.imageMaxTokens).toBe(560);

    expect(inferencePreset).toBeDefined();
    expect(inferencePreset?.name).toBe("Default (from GGUF) for Gemma");
    expect(inferencePreset?.isDefault).toBe(true);
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
          defaultTemperature: 0.7,
          defaultTopK: 40,
          defaultTopP: 0.95,
          defaultMinP: undefined,
          defaultRepeatPenalty: undefined,
          chatTemplate: undefined,
          bosToken: undefined,
          eosToken: undefined,
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
          defaultTemperature: 0.7,
          defaultTopK: 40,
          defaultTopP: 0.95,
          defaultMinP: 0.02,
          defaultRepeatPenalty: 1.15,
          chatTemplate: undefined,
          bosToken: undefined,
          eosToken: undefined,
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
          defaultTemperature: 0.7,
          defaultTopK: undefined,
          defaultTopP: 0.95,
          defaultMinP: undefined,
          defaultRepeatPenalty: undefined,
          chatTemplate: undefined,
          bosToken: undefined,
          eosToken: undefined,
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
