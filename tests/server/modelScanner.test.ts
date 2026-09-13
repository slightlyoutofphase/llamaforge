/**
 * @packageDocumentation
 * Tests for GGUF model scanning and filesystem discovery.
 */

import { afterAll, beforeAll, describe, expect, it, spyOn } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import * as ggufReaderModule from "../../src/server/ggufReader";
import { scanModels } from "../../src/server/modelScanner";
import { initDb } from "../../src/server/persistence/db";
import { setCachedGgufMetadata } from "../../src/server/persistence/chatRepo";

const baseMockMetadata = {
  name: "Test Model",
  fileSizeBytes: 5_368_709_120,
  contextLength: 8192,
  embeddingLength: 0,
  attentionHeadCount: 32,
  attentionHeadCountKv: 32,
  blockCount: 48,
  feedForwardLength: 8192,
  quantType: "q4_0",
  hasVisionEncoder: false,
  hasAudioEncoder: false,
  hasToolCalling: false,
  defaultTemperature: 0.8,
  defaultTopK: 40,
  defaultTopP: 0.95,
  defaultMinP: 0.05,
  defaultRepeatPenalty: 1.1,
  chatTemplate: undefined,
  isDraftModel: false,
};

describe("modelScanner", () => {
  let tmpDir: string;

  let parseSpy: ReturnType<typeof spyOn>;

  beforeAll(async () => {
    await initDb();

    parseSpy = spyOn(ggufReaderModule, "parseGgufMetadata").mockImplementation(
      async (filePath: string) => {
        const lower = filePath.toLowerCase();
        const isEagle = lower.includes("eagle3");
        const isGemmaAssistant = lower.includes("gemma") && lower.includes("assistant");
        let architecture = "llama";
        if (isEagle) architecture = "eagle3";
        else if (isGemmaAssistant) architecture = "gemma4-assistant";
        return {
          ...baseMockMetadata,
          architecture,
        };
      },
    );

    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "llamaforge-test-"));

    // Create PublisherA / Model-7B
    const mod1 = path.join(tmpDir, "PublisherA", "Model-7B");
    await fs.mkdir(mod1, { recursive: true });
    await Bun.write(path.join(mod1, "model-7b-q4.gguf"), "mock");

    // Create PublisherA / Model-13B with multiple
    const mod2 = path.join(tmpDir, "PublisherA", "Model-13B");
    await fs.mkdir(mod2, { recursive: true });
    await Bun.write(path.join(mod2, "model-13b-q4.gguf"), "mock");
    await Bun.write(path.join(mod2, "model-13b-q8.gguf"), "mock");
    await Bun.write(path.join(mod2, "mmproj-13b.gguf"), "mock"); // exactly one mmproj

    // Create PublisherB / Model-Vision (only mmproj)
    const mod3 = path.join(tmpDir, "PublisherB", "Model-Vision");
    await fs.mkdir(mod3, { recursive: true });
    await Bun.write(path.join(mod3, "mmproj-vision.gguf"), "mock");
  });

  afterAll(async () => {
    parseSpy.mockRestore();
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it("walks directory and returns exactly primary models with associated mmprojs", async () => {
    const entries = await scanModels(tmpDir);
    expect(entries.length).toBe(3); // 1 from Model-7B, 2 from Model-13B

    const m7b = entries.find((e) => e.primaryPath.includes("model-7b-q4"));
    expect(m7b).toBeDefined();
    expect(m7b?.publisher).toBe("PublisherA");
    expect(m7b?.mmProjPath).toBeUndefined();

    const m13b_q4 = entries.find((e) => e.primaryPath.includes("model-13b-q4"));
    expect(m13b_q4).toBeDefined();
    expect(m13b_q4?.mmProjPath).toBeDefined();
    expect(m13b_q4?.mmProjPath?.includes("mmproj-13b.gguf")).toBeTrue();

    // PublisherB/Model-Vision should be skipped because no primary GGUF
    const mVish = entries.find((e) => e.publisher === "PublisherB");
    expect(mVish).toBeUndefined();
  });

  it("stops traversal once the entry budget is exhausted by non-model files and directories", async () => {
    const noisyRoot = path.join(tmpDir, "NoisyTree");
    await fs.mkdir(noisyRoot, { recursive: true });

    for (let index = 0; index < 12; index++) {
      const subdir = path.join(noisyRoot, `${index}`.padStart(2, "0"));
      await fs.mkdir(subdir, { recursive: true });
      await Bun.write(path.join(subdir, `note-${index}.txt`), "not a model");
    }

    const lateModelDir = path.join(noisyRoot, "zz-late-model");
    await fs.mkdir(lateModelDir, { recursive: true });
    await Bun.write(path.join(lateModelDir, "late.gguf"), "mock");

    const entries = await scanModels(noisyRoot, { maxEntries: 10, maxDepth: 20 });
    expect(entries).toHaveLength(0);
  });

  it("links a same-directory mmproj whose filename does not share an exact companion key", async () => {
    const gemmaRoot = path.join(tmpDir, "FadedRedStar", "gemma-4-E4B-it-qat-q4_0-heretic-GGUF");
    await fs.mkdir(gemmaRoot, { recursive: true });
    await Bun.write(path.join(gemmaRoot, "gemma-4-E4B-it-qat-q4_0-heretic-Q4_0_PURE.gguf"), "mock");
    await Bun.write(
      path.join(gemmaRoot, "mmproj-gemma-4-E4B-it-qat-q4_0-heretic-BF16.gguf"),
      "mock",
    );

    const entries = await scanModels(path.join(tmpDir, "FadedRedStar"));
    const gemma = entries.find((e) => e.primaryPath.includes("Q4_0_PURE.gguf"));
    expect(entries).toHaveLength(1);
    expect(gemma?.mmProjPath?.includes("mmproj-gemma-4-E4B-it-qat-q4_0-heretic-BF16.gguf")).toBe(
      true,
    );
  });

  it("leaves mmProjPath unset when multiple mmproj variants match the same primary companion key", async () => {
    const ambiguousRoot = path.join(tmpDir, "AmbiguousPublisher", "Model-7B");
    await fs.mkdir(ambiguousRoot, { recursive: true });
    await Bun.write(path.join(ambiguousRoot, "model-7b-q4.gguf"), "mock");
    await Bun.write(path.join(ambiguousRoot, "mmproj-7b-f16.gguf"), "mock");
    await Bun.write(path.join(ambiguousRoot, "mmproj-7b-q8.gguf"), "mock");

    const entries = await scanModels(path.join(tmpDir, "AmbiguousPublisher"));
    expect(entries).toHaveLength(1);
    expect(entries[0]?.mmProjPath).toBeUndefined();
  });

  it("excludes draft models from primary results and links them to main models", async () => {
    const draftRoot = path.join(tmpDir, "DraftPublisher", "Model-7B");
    await fs.mkdir(draftRoot, { recursive: true });
    await Bun.write(path.join(draftRoot, "model-7b-q4.gguf"), "mock");
    await Bun.write(path.join(draftRoot, "model-7b-q4-assistant.gguf"), "mock");

    const entries = await scanModels(path.join(tmpDir, "DraftPublisher"));
    const mainModel = entries.find((e) => e.primaryPath.includes("model-7b-q4.gguf"));
    const draftModel = entries.find((e) => e.primaryPath.includes("assistant.gguf"));

    expect(entries).toHaveLength(1);
    expect(mainModel).toBeDefined();
    expect(draftModel).toBeUndefined();
    expect(mainModel?.draftModelPath).toBeDefined();
    expect(mainModel?.draftModelPath?.includes("assistant.gguf")).toBeTrue();
    expect(mainModel?.draftSpecType).toBe("draft-simple");
  });

  it("does not link draft models when filename contains mtp instead of assistant/eagle3", async () => {
    const mtpRoot = path.join(tmpDir, "MtpPublisher", "Model-MTP");
    await fs.mkdir(mtpRoot, { recursive: true });
    await Bun.write(path.join(mtpRoot, "model-mtp-q4.gguf"), "mock");

    const entries = await scanModels(path.join(tmpDir, "MtpPublisher"));
    expect(entries).toHaveLength(1);
    expect(entries[0]?.draftModelPath).toBeUndefined();
  });

  it("gracefully handles mprotect failures from parseGgufMetadata without crashing", async () => {
    const originalImpl = parseSpy.getMockImplementation();
    parseSpy.mockImplementation(async () => {
      throw new Error("mprotect failed: 487");
    });

    const crashRoot = path.join(tmpDir, "CrashPublisher", "Model-7B");
    await fs.mkdir(crashRoot, { recursive: true });
    await Bun.write(path.join(crashRoot, "model-7b-q4.gguf"), "mock");

    const entries = await scanModels(path.join(tmpDir, "CrashPublisher"));
    expect(entries).toHaveLength(1);
    expect(entries[0]?.primaryPath.includes("model-7b-q4.gguf")).toBeTrue();

    parseSpy.mockImplementation(originalImpl);
  });

  it("keeps qwen in companion keys so Qwen models do not collide with unrelated mmprojs", async () => {
    const qwenRoot = path.join(tmpDir, "QwenPublisher", "VL-Chat");
    await fs.mkdir(qwenRoot, { recursive: true });
    await Bun.write(path.join(qwenRoot, "Qwen-VL-Chat-Q4_K_M.gguf"), "mock");
    await Bun.write(path.join(qwenRoot, "Qwen-VL-Chat-mmproj.gguf"), "mock");
    await Bun.write(path.join(qwenRoot, "a-mmproj.gguf"), "mock");

    const entries = await scanModels(path.join(tmpDir, "QwenPublisher"));
    const qwen = entries.find((e) => e.primaryPath.includes("Qwen-VL-Chat-Q4_K_M.gguf"));
    expect(qwen).toBeDefined();
    expect(qwen?.mmProjPath?.includes("Qwen-VL-Chat-mmproj.gguf")).toBeTrue();
    expect(qwen?.mmProjPath?.endsWith("a-mmproj.gguf")).toBeFalse();
  });

  it("links draft models by companion key instead of directory alone", async () => {
    const draftRoot = path.join(tmpDir, "DraftAmbiguous", "Family");
    await fs.mkdir(draftRoot, { recursive: true });
    await Bun.write(path.join(draftRoot, "alpha-7b-q4.gguf"), "mock");
    await Bun.write(path.join(draftRoot, "alpha-7b-q4-assistant.gguf"), "mock");
    await Bun.write(path.join(draftRoot, "unrelated-eagle3.gguf"), "mock");

    const entries = await scanModels(path.join(tmpDir, "DraftAmbiguous"));
    const mainModel = entries.find((e) => e.primaryPath.includes("alpha-7b-q4.gguf"));
    expect(entries).toHaveLength(1);
    expect(mainModel?.draftModelPath?.includes("alpha-7b-q4-assistant.gguf")).toBeTrue();
    expect(mainModel?.draftModelPath?.includes("unrelated-eagle3.gguf")).toBeFalse();
  });

  it("links a same-directory gemma4-assistant draft even when heretic filename tokens differ", async () => {
    const gemmaRoot = path.join(tmpDir, "FadedRedStar12B", "gemma-4-12B-it-qat-q4_0-heretic-GGUF");
    await fs.mkdir(gemmaRoot, { recursive: true });
    await Bun.write(path.join(gemmaRoot, "gemma-4-12B-it-qat-q4_0-heretic-Q4_0_PURE.gguf"), "mock");
    await Bun.write(path.join(gemmaRoot, "gemma-4-12b-qat-it-assistant-Q4_0_Q4emb.gguf"), "mock");
    await Bun.write(
      path.join(gemmaRoot, "mmproj-gemma-4-12B-it-qat-q4_0-heretic-BF16.gguf"),
      "mock",
    );

    const entries = await scanModels(path.join(tmpDir, "FadedRedStar12B"));
    expect(entries).toHaveLength(1);
    const gemma = entries[0];
    expect(gemma?.primaryPath.includes("Q4_0_PURE.gguf")).toBeTrue();
    expect(gemma?.draftModelPath?.includes("assistant-Q4_0_Q4emb.gguf")).toBeTrue();
    expect(gemma?.draftSpecType).toBe("draft-mtp");
    expect(gemma?.mmProjPath?.includes("mmproj-gemma-4-12B-it-qat-q4_0-heretic-BF16.gguf")).toBe(
      true,
    );
    expect(entries.some((entry) => entry.primaryPath.includes("assistant"))).toBeFalse();
  });

  it("reclassifies cached gemma4-assistant GGUFs as hidden drafts even when isDraftModel was stored false", async () => {
    const root = path.join(tmpDir, "StaleDraftCache", "Gemma12B");
    await fs.mkdir(root, { recursive: true });
    const mainPath = path.resolve(root, "gemma-main.gguf");
    const draftPath = path.resolve(root, "gemma-sidecar.gguf");
    await Bun.write(mainPath, "mock");
    await Bun.write(draftPath, "mock");
    const draftStat = await fs.stat(draftPath);
    await setCachedGgufMetadata(draftPath, draftStat.mtimeMs, {
      ...baseMockMetadata,
      architecture: "gemma4-assistant",
      isDraftModel: false,
    });

    const entries = await scanModels(path.join(tmpDir, "StaleDraftCache"));
    expect(entries).toHaveLength(1);
    expect(entries[0]?.primaryPath).toBe(mainPath);
    expect(entries[0]?.draftModelPath).toBe(draftPath);
    expect(entries[0]?.draftSpecType).toBe("draft-mtp");
  });
});
