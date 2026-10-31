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
import { loadPresetsForModel } from "../../src/shared/presetScope";
import { modelPathsMatch } from "../../src/shared/templateCapabilities";
import type { LoadPreset, ModelEntry } from "../../src/shared/types";
import { ggufDisplayMetadata, testInferencePreset, testLoadConfig } from "../fixtures";

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
    expect(loadPreset?.name).toBe("Gemma");
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
    expect(loadPreset?.config.contextSize).toBe(8192);

    expect(inferencePreset).toBeDefined();
    expect(inferencePreset?.name).toBe("Gemma");
    expect(inferencePresets.filter((preset) => preset.isDefault).length).toBeLessThanOrEqual(1);
  });

  it("caps seeded context when the GGUF advertises a huge native window", async () => {
    await ensureModelDefaultPresets([
      {
        publisher: "Publisher",
        modelName: "LongContext",
        primaryPath: "/models/long.gguf",
        metadata: ggufDisplayMetadata({ contextLength: 131072, name: "Long Context" }),
      },
      {
        publisher: "Publisher",
        modelName: "ShortContext",
        primaryPath: "/models/short.gguf",
        metadata: ggufDisplayMetadata({ contextLength: 2048, name: "Short Context" }),
      },
    ]);

    const loadPresets = await getLoadPresets();
    expect(
      loadPresets.find((preset) => preset.modelPath === "/models/long.gguf")?.config.contextSize,
    ).toBe(8192);
    expect(
      loadPresets.find((preset) => preset.modelPath === "/models/short.gguf")?.config.contextSize,
    ).toBe(2048);
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

  /**
   * Minimal scanned model with metadata so preset creation runs.
   *
   * @param modelName - Folder title shared by quant files of one model.
   * @param primaryPath - Absolute GGUF path.
   * @returns A model entry.
   */
  function scannedModel(modelName: string, primaryPath: string): ModelEntry {
    return {
      publisher: "Publisher",
      modelName,
      primaryPath,
      metadata: ggufDisplayMetadata({ name: modelName }),
    };
  }

  /**
   * Inserts a load preset directly, including duplicate names the write path would refuse.
   *
   * @param id - Row id.
   * @param name - Stored name, which may collide.
   * @param modelPath - Bound GGUF.
   * @param isDefault - `1` when the row is marked default.
   * @param createdAt - Creation time used to decide which duplicate keeps its name.
   * @returns No return value.
   */
  function insertLoadRow(
    id: string,
    name: string,
    modelPath: string,
    isDefault: number,
    createdAt: number,
  ): void {
    getDb()
      .prepare(
        "INSERT INTO load_presets (id, name, model_path, is_default, is_readonly, config_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
      )
      .run(
        id,
        name,
        modelPath,
        isDefault,
        0,
        JSON.stringify(testLoadConfig(modelPath)),
        createdAt,
        createdAt,
      );
  }

  /**
   * Saves a load preset through the normal write path.
   *
   * @param id - Preset id.
   * @param name - Requested name.
   * @param modelPath - Bound GGUF.
   * @returns The stored preset.
   */
  async function saveLoad(id: string, name: string, modelPath: string): Promise<void> {
    const preset: LoadPreset = {
      id,
      name,
      modelPath,
      isDefault: false,
      isReadonly: false,
      config: testLoadConfig(modelPath),
      createdAt: 1,
      updatedAt: 1,
    };
    await createLoadPreset(preset);
  }

  it("names each quant separately and lists that preset only on its own model", async () => {
    const q4 = "D:/Models/Aura/Aura-Q4_K_S.gguf";
    const q8 = "D:/Models/Aura/Aura-Q8_0.gguf";
    await ensureModelDefaultPresets([
      scannedModel("Aura", q4),
      scannedModel("Aura", q8),
      scannedModel("Gemma", "/models/Gemma/gemma.gguf"),
    ]);

    const loadPresets = await getLoadPresets();
    const inferencePresets = await getInferencePresets();
    const loadNames = loadPresets.map((preset) => preset.name);
    const inferenceNames = inferencePresets.map((preset) => preset.name);

    expect(loadNames).toContain("Aura-Q4_K_S");
    expect(loadNames).toContain("Aura-Q8_0");
    expect(loadNames).toContain("Gemma");
    expect(loadNames).not.toContain("Default (from GGUF) for Aura");
    expect(new Set(loadNames).size).toBe(loadNames.length);
    expect(new Set(inferenceNames).size).toBe(inferenceNames.length);
    expect(loadPresets.filter((preset) => preset.isDefault)).toHaveLength(1);

    const q4Choices = loadPresetsForModel(loadPresets, q4).map((preset) => preset.name);
    const q8Choices = loadPresetsForModel(loadPresets, q8).map((preset) => preset.name);
    expect(q4Choices).toContain("Aura-Q4_K_S");
    expect(q4Choices).toContain("Balanced Default");
    expect(q4Choices).not.toContain("Aura-Q8_0");
    expect(q8Choices).toContain("Aura-Q8_0");
    expect(q8Choices).not.toContain("Aura-Q4_K_S");
  });

  it("rewrites duplicate generated names and keeps a hand-written name", async () => {
    const q4 = "/models/Aura/Aura-Q4_K_S.gguf";
    const q8 = "/models/Aura/Aura-Q8_0.gguf";
    const gemmaPath = "/models/Gemma/gemma.gguf";
    insertLoadRow("q4", "Default (from GGUF) for Aura", q4, 1, 10);
    insertLoadRow("q8", "Default (from GGUF) for Aura", q8, 1, 20);
    insertLoadRow("ben", "BenGemma", gemmaPath, 0, 30);

    await ensureModelDefaultPresets([
      scannedModel("Aura", q4),
      scannedModel("Aura", q8),
      scannedModel("Gemma", gemmaPath),
    ]);

    const loadPresets = await getLoadPresets();
    expect(loadPresets.find((preset) => preset.id === "q4")?.name).toBe("Aura-Q4_K_S");
    expect(loadPresets.find((preset) => preset.id === "q8")?.name).toBe("Aura-Q8_0");
    expect(loadPresets.find((preset) => preset.id === "ben")?.name).toBe("BenGemma");
    expect(
      loadPresets.filter((preset) => modelPathsMatch(preset.modelPath, gemmaPath)),
    ).toHaveLength(1);
    const defaults = loadPresets.filter((preset) => preset.isDefault);
    expect(defaults.map((preset) => preset.name)).toEqual(["Balanced Default"]);
    expect(new Set(loadPresets.map((preset) => preset.name.toLowerCase())).size).toBe(
      loadPresets.length,
    );
  });

  it("does not create a second preset when an existing path only differs by slashes", async () => {
    await saveLoad("slash", "BenQ4", "D:\\Models\\Aura\\Aura-Q4_K_S.gguf");
    await ensureModelDefaultPresets([
      scannedModel("Aura", "D:/Models/Aura/Aura-Q4_K_S.gguf"),
      scannedModel("Aura", "D:/Models/Aura/Aura-Q8_0.gguf"),
    ]);

    const loadPresets = await getLoadPresets();
    const q4 = loadPresets.filter((preset) =>
      modelPathsMatch(preset.modelPath, "D:/Models/Aura/Aura-Q4_K_S.gguf"),
    );
    expect(q4.map((preset) => preset.name)).toEqual(["BenQ4"]);
    expect(
      loadPresets.find((preset) =>
        modelPathsMatch(preset.modelPath, "D:/Models/Aura/Aura-Q8_0.gguf"),
      )?.name,
    ).toBe("Aura-Q8_0");
  });

  it("refuses a duplicate name on create and on update", async () => {
    await saveLoad("first", "Same", "/models/a.gguf");
    await saveLoad("second", "same", "/models/b.gguf");
    let presets = await getLoadPresets();
    expect(presets.find((preset) => preset.id === "first")?.name).toBe("Same");
    expect(presets.find((preset) => preset.id === "second")?.name).toBe("same (2)");

    await updateLoadPreset("second", { name: "Same" });
    presets = await getLoadPresets();
    expect(presets.find((preset) => preset.id === "second")?.name).toBe("Same (2)");
    expect(new Set(presets.map((preset) => preset.name.toLowerCase())).size).toBe(presets.length);

    await createSystemPreset({
      id: "voice-a",
      name: "Voice",
      content: "a",
      createdAt: 1,
      updatedAt: 1,
    });
    await createSystemPreset({
      id: "voice-b",
      name: "voice",
      content: "b",
      createdAt: 2,
      updatedAt: 2,
    });
    const systemPresets = await getSystemPresets();
    expect(systemPresets.find((preset) => preset.id === "voice-b")?.name).toBe("voice (2)");
  });

  it("keeps a repaired name when a save sends the old generated title", async () => {
    const path = "/models/Aura/only.gguf";
    insertLoadRow("only", "Default (from GGUF) for Aura", path, 0, 5);
    await ensureModelDefaultPresets([scannedModel("Aura", path)]);
    expect((await getLoadPresets()).find((preset) => preset.id === "only")?.name).toBe("Aura");

    await updateLoadPreset("only", { name: "Default (from GGUF) for Aura" });
    expect((await getLoadPresets()).find((preset) => preset.id === "only")?.name).toBe("Aura");
  });
});
