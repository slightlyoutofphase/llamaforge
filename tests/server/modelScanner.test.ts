/**
 * @packageDocumentation
 * Tests for GGUF model scanning and filesystem discovery.
 */

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { scanModels } from "../../src/server/modelScanner";

describe("modelScanner", () => {
  let tmpDir: string;

  beforeAll(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "llamaforge-test-"));

    // Create PublisherA / Model-7B
    const mod1 = path.join(tmpDir, "PublisherA", "Model-7B");
    await fs.mkdir(mod1, { recursive: true });
    await fs.writeFile(path.join(mod1, "model-7b-q4.gguf"), "mock");

    // Create PublisherA / Model-13B with multiple
    const mod2 = path.join(tmpDir, "PublisherA", "Model-13B");
    await fs.mkdir(mod2, { recursive: true });
    await fs.writeFile(path.join(mod2, "model-13b-q4.gguf"), "mock");
    await fs.writeFile(path.join(mod2, "model-13b-q8.gguf"), "mock");
    await fs.writeFile(path.join(mod2, "mmproj-13b.gguf"), "mock"); // exactly one mmproj

    // Create PublisherB / Model-Vision (only mmproj)
    const mod3 = path.join(tmpDir, "PublisherB", "Model-Vision");
    await fs.mkdir(mod3, { recursive: true });
    await fs.writeFile(path.join(mod3, "mmproj-vision.gguf"), "mock");
  });

  afterAll(async () => {
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
});
