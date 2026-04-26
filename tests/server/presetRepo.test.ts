/**
 * @packageDocumentation
 * Tests for preset repository persistence and CRUD operations.
 */

import { beforeEach, describe, expect, it } from "bun:test";
import { initDb } from "../../src/server/persistence/db";
import {
  createInferencePreset,
  createLoadPreset,
  createSystemPreset,
  deleteInferencePreset,
  deleteLoadPreset,
  deleteSystemPreset,
  getInferencePresets,
  getLoadPresets,
  getSystemPresets,
  updateInferencePreset,
  updateLoadPreset,
  updateSystemPreset,
} from "../../src/server/persistence/presetRepo";

describe("presetRepo", () => {
  beforeEach(async () => {
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
      },
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });
    let presets = await getLoadPresets();
    expect(presets.find((p) => p.id === "lp1")).toBeDefined();

    await updateLoadPreset("lp1", { name: "Load 1 Updated" });
    presets = await getLoadPresets();
    expect(presets.find((p) => p.id === "lp1")?.name).toBe("Load 1 Updated");

    await deleteLoadPreset("lp1");
    presets = await getLoadPresets();
    expect(presets.find((p) => p.id === "lp1")).toBeUndefined();
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
});
