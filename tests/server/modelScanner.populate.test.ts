/**
 * @packageDocumentation
 * Tests for model scanner metadata population and cache integration.
 */

import { afterAll, beforeAll, describe, expect, it, spyOn } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import * as ggufReaderModule from "../../src/server/ggufReader";
import { cachedGgufMetadata } from "../../src/server/persistence/chatRepo";
import { initDb } from "../../src/server/persistence/db";

import { populateMetadata } from "../../src/server/modelScanner";

describe("modelScanner metadata population", () => {
  let tmpDir: string;
  let modelPath: string;
  let parseSpy: ReturnType<typeof spyOn>;

  beforeAll(async () => {
    parseSpy = spyOn(ggufReaderModule, "parseGgufMetadata").mockImplementation(
      async (_filePath: string) => ({
        architecture: "gemma4",
        name: "Test Model",
        fileSizeBytes: 5_368_709_120,
        contextLength: 8192,
        embeddingLength: 0,
        attentionHeadCount: 32,
        attentionHeadCountKv: 32,
        blockCount: 48,
        feedForwardLength: 8192,
        quantType: "q4_0",
        hasVisionEncoder: true,
        hasAudioEncoder: false,
        hasToolCalling: false,
        defaultTemperature: 0.8,
        defaultTopK: 40,
        defaultTopP: 0.95,
        defaultMinP: 0.05,
        defaultRepeatPenalty: 1.1,
        chatTemplate: undefined,
      }),
    );

    await initDb(":memory:");
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "llamaforge-modelmeta-"));
    modelPath = path.join(tmpDir, "test-model.gguf");
    await Bun.write(modelPath, "dummy content");
  });

  afterAll(async () => {
    parseSpy.mockRestore();
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it("populates missing GGUF metadata and caches it for future reads", async () => {
    const entry = {
      publisher: "unsloth",
      modelName: "embe...",
      primaryPath: modelPath,
    };

    const populated = await populateMetadata(entry);

    expect(populated.metadata).toBeDefined();
    expect(populated.metadata?.architecture).toBe("gemma4");
    const stat = await fs.stat(modelPath);
    expect(populated.metadata?.fileSizeBytes).toBe(stat.size);
    expect(populated.metadata?.hasVisionEncoder).toBe(true);

    const cached = await cachedGgufMetadata(modelPath, stat.mtimeMs);
    expect(cached).toBeDefined();
    expect(cached?.architecture).toBe("gemma4");
    expect(cached?.fileSizeBytes).toBe(stat.size);
  });
});

describe("modelScanner mmproj encoder merge", () => {
  let tmpDir: string;
  let parseSpy: ReturnType<typeof spyOn>;

  beforeAll(async () => {
    parseSpy = spyOn(ggufReaderModule, "parseGgufMetadata").mockImplementation(
      async (filePath: string) => {
        const isMmproj = path.basename(filePath).toUpperCase().includes("MMPROJ");
        return {
          architecture: isMmproj ? "clip" : "gemma4",
          name: isMmproj ? "mmproj" : "Gemma",
          fileSizeBytes: 1024,
          contextLength: 8192,
          embeddingLength: 0,
          attentionHeadCount: 32,
          attentionHeadCountKv: 32,
          blockCount: 48,
          feedForwardLength: 8192,
          quantType: "q4_0",
          hasVisionEncoder: isMmproj,
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
      },
    );

    await initDb(":memory:");
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "llamaforge-mmproj-merge-"));
    await Bun.write(path.join(tmpDir, "gemma4-q4.gguf"), "primary");
    await Bun.write(path.join(tmpDir, "gemma4-mmproj.gguf"), "mmproj");
  });

  afterAll(async () => {
    parseSpy.mockRestore();
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it("merges mmproj vision flags during scanModels before the cache is written", async () => {
    const { scanModels, populateMetadata } = await import("../../src/server/modelScanner");
    const entries = await scanModels(tmpDir);
    expect(entries).toHaveLength(1);
    const entry = entries[0];
    if (!entry) {
      throw new Error("Expected scanModels to return a model entry");
    }
    const mmProjPath = entry.mmProjPath;
    if (!mmProjPath) {
      throw new Error("Expected the scanned entry to include an mmproj path");
    }
    expect(mmProjPath).toContain("mmproj");

    const populated = await populateMetadata(entry);
    expect(populated.metadata?.hasVisionEncoder).toBe(true);

    const stat = await fs.stat(entry.primaryPath);
    const mmStat = await fs.stat(mmProjPath);
    const cached = await cachedGgufMetadata(entry.primaryPath, stat.mtimeMs, {
      mmprojPath: mmProjPath,
      mmprojMtime: mmStat.mtimeMs,
    });
    expect(cached?.hasVisionEncoder).toBe(true);
  });

  it("invalidates cached encoder flags when the mmproj mtime changes", async () => {
    const { populateMetadata } = await import("../../src/server/modelScanner");
    const primaryPath = path.join(tmpDir, "gemma4-q4.gguf");
    const mmProjPath = path.join(tmpDir, "gemma4-mmproj.gguf");
    const entry = {
      publisher: "google",
      modelName: "gemma4",
      primaryPath,
      mmProjPath,
    };

    const first = await populateMetadata(entry);
    expect(first.metadata?.hasVisionEncoder).toBe(true);

    await Bun.write(mmProjPath, "mmproj-changed");
    parseSpy.mockImplementation(async (filePath: string) => {
      const isMmproj = path.basename(filePath).toUpperCase().includes("MMPROJ");
      return {
        architecture: isMmproj ? "clip" : "gemma4",
        name: isMmproj ? "mmproj" : "Gemma",
        fileSizeBytes: 1024,
        contextLength: 8192,
        embeddingLength: 0,
        attentionHeadCount: 32,
        attentionHeadCountKv: 32,
        blockCount: 48,
        feedForwardLength: 8192,
        quantType: "q4_0",
        hasVisionEncoder: isMmproj,
        hasAudioEncoder: isMmproj,
        hasToolCalling: false,
        defaultTemperature: 0.8,
        defaultTopK: 40,
        defaultTopP: 0.95,
        defaultMinP: 0.05,
        defaultRepeatPenalty: 1.1,
        chatTemplate: undefined,
        isDraftModel: false,
      };
    });

    const second = await populateMetadata(entry);
    expect(second.metadata?.hasAudioEncoder).toBe(true);
  });
});
