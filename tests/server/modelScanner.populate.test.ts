import { afterAll, beforeAll, describe, expect, it, mock } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { initDb } from "../../src/server/persistence/db";
import { cachedGgufMetadata } from "../../src/server/persistence/chatRepo";

mock.module("../../src/server/ggufReader", () => ({
  parseGgufMetadata: async (_filePath: string) => ({
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
    defaultTemperature: 0.8,
    defaultTopK: 40,
    defaultTopP: 0.95,
    defaultMinP: 0.05,
    defaultRepeatPenalty: 1.1,
    chatTemplate: undefined,
    bosToken: undefined,
    eosToken: undefined,
  }),
}));

import { populateMetadata } from "../../src/server/modelScanner";

describe("modelScanner metadata population", () => {
  let tmpDir: string;
  let modelPath: string;

  beforeAll(async () => {
    await initDb(":memory:");
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "llamaforge-modelmeta-"));
    modelPath = path.join(tmpDir, "test-model.gguf");
    await fs.writeFile(modelPath, "dummy content");
  });

  afterAll(async () => {
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
