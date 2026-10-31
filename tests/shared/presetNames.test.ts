/**
 * @packageDocumentation
 * Tests for preset and model labels: one "default", no repeated model name,
 * and no two rows in a list sharing a name.
 */

import { describe, expect, it } from "bun:test";
import {
  allocateUniqueName,
  assignUniquePresetNames,
  autoPresetName,
  duplicatePresetName,
  modelOptionLabel,
  preferredDefaultId,
  presetListLabel,
  presetMenuLabels,
  resolveStoredPresetName,
} from "../../src/shared/presetNames";

const auraQ4 = "/models/Aura/Aura-Q4_K_S.gguf";
const auraQ8 = "/models/Aura/Aura-Q8_0.gguf";
const gemma = "/models/Gemma/gemma-q8.gguf";

const auraQ4Model = { modelName: "Aura", primaryPath: auraQ4 };
const auraQ8Model = { modelName: "Aura", primaryPath: auraQ8 };
const gemmaModel = { modelName: "Gemma", primaryPath: gemma };
const models = [auraQ4Model, auraQ8Model, gemmaModel];

describe("preset names", () => {
  it("uses the word default at most once", () => {
    expect(presetListLabel("Balanced Default", true)).toBe("Balanced Default");
    expect(presetListLabel("Gemma", true)).toBe("Gemma (Default)");
    expect(presetListLabel("Gemma", false)).toBe("Gemma");
    expect(presetListLabel("Default (from GGUF) for Aura", true)).toBe(
      "Default (from GGUF) for Aura",
    );
  });

  it("does not append the model file to a menu label", () => {
    const labels = presetMenuLabels([
      { id: "ben", name: "BenGemma", isDefault: false },
      { id: "balanced", name: "Balanced Default", isDefault: true },
    ]);
    expect(labels.get("ben")).toBe("BenGemma");
    expect(labels.get("balanced")).toBe("Balanced Default");
  });

  it("keeps two menu rows from displaying the same text", () => {
    const labels = presetMenuLabels([
      { id: "marked", name: "Gemma", isDefault: true },
      { id: "literal", name: "Gemma (Default)", isDefault: false },
    ]);
    expect(labels.get("marked")).toBe("Gemma (Default)");
    expect(labels.get("literal")).toBe("Gemma (Default) (2)");
    expect(new Set(labels.values()).size).toBe(2);
  });

  it("allocates a unique name without stacking copy suffixes", () => {
    expect(allocateUniqueName("BenGemma", ["Other"])).toBe("BenGemma");
    expect(allocateUniqueName("same", ["Same"])).toBe("same (2)");
    expect(duplicatePresetName("BenGemma", ["BenGemma"])).toBe("BenGemma (Copy)");
    expect(duplicatePresetName("BenGemma", ["BenGemma", "BenGemma (Copy)"])).toBe(
      "BenGemma (Copy 2)",
    );
    expect(duplicatePresetName("BenGemma (Copy)", ["BenGemma (Copy)"])).toBe("BenGemma (Copy 2)");
  });

  it("labels one model with its folder title and each quant with its file name", () => {
    expect(modelOptionLabel(gemmaModel, models)).toBe("Gemma");
    expect(autoPresetName(gemmaModel, models)).toBe("Gemma");
    expect(modelOptionLabel(auraQ4Model, models)).toBe("Aura-Q4_K_S");
    expect(modelOptionLabel(auraQ8Model, models)).toBe("Aura-Q8_0");
    expect(modelOptionLabel(auraQ4Model, models)).not.toContain("Aura-Q4_K_S —");
  });

  it("ignores a draft companion when renaming a generated preset", () => {
    const assigned = assignUniquePresetNames(
      [{ id: "g", name: "Default (from GGUF) for Gemma", createdAt: 1, modelPath: gemma }],
      [
        gemmaModel,
        {
          modelName: "Gemma",
          primaryPath: "/models/Gemma/gemma-draft.gguf",
          metadata: { isDraftModel: true },
        },
      ],
    );
    expect(assigned.get("g")).toBe("Gemma");
  });

  it("replaces generated names and refuses duplicate names", () => {
    const assigned = assignUniquePresetNames(
      [
        {
          id: "balanced",
          name: "Balanced Default",
          createdAt: 0,
          isReadonly: true,
          modelPath: "",
        },
        {
          id: "q4",
          name: "Default (from GGUF) for Aura",
          createdAt: 1,
          modelPath: auraQ4,
        },
        {
          id: "q8",
          name: "Default (from GGUF) for Aura",
          createdAt: 2,
          modelPath: auraQ8,
        },
        {
          id: "copy",
          name: "Default (from GGUF) for Aura (Copy)",
          createdAt: 3,
          modelPath: auraQ4,
        },
        { id: "ben", name: "BenGemma", createdAt: 4, modelPath: gemma },
        { id: "ben-again", name: "bengemma", createdAt: 5, modelPath: "/models/other.gguf" },
      ],
      models,
    );

    expect(assigned.get("balanced")).toBe("Balanced Default");
    expect(assigned.get("q4")).toBe("Aura-Q4_K_S");
    expect(assigned.get("q8")).toBe("Aura-Q8_0");
    expect(assigned.get("copy")).toBe("Aura-Q4_K_S (Copy)");
    expect(assigned.get("ben")).toBe("BenGemma");
    expect(assigned.get("ben-again")).toBe("bengemma (2)");
    expect(new Set(assigned.values()).size).toBe(assigned.size);
    for (const name of assigned.values()) {
      expect(name.toLowerCase().includes("from gguf")).toBe(false);
      const defaults = name.toLowerCase().match(/\bdefault\b/g) ?? [];
      expect(defaults.length).toBeLessThanOrEqual(1);
    }
  });

  it("keeps one default, preferring the read-only global preset", () => {
    expect(
      preferredDefaultId([
        { id: "quant", isDefault: true, boundPath: auraQ4, createdAt: 2 },
        { id: "balanced", isDefault: true, isReadonly: true, boundPath: "", createdAt: 1 },
        { id: "other", isDefault: false, boundPath: auraQ8, createdAt: 3 },
      ]),
    ).toBe("balanced");
  });

  it("does not let a stale generated name overwrite a repaired name", () => {
    expect(
      resolveStoredPresetName("Default (from GGUF) for Aura", "Aura-Q4_K_S", ["Aura-Q8_0"]),
    ).toBe("Aura-Q4_K_S");
    expect(resolveStoredPresetName("Same", "Custom", ["Same"])).toBe("Same (2)");
  });
});
