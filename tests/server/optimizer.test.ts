/**
 * @packageDocumentation
 * Tests for the optimizer logic that suggests load configuration values.
 */

import { describe, expect, it } from "bun:test";
import type { GgufDisplayMetadata, HardwareInfo } from "@shared/types";
import { optimizeLoadConfig } from "../../src/server/optimizer";

describe("optimizer", () => {
  const mockHardware: HardwareInfo = {
    cpuThreads: 16,
    totalRamBytes: 32 * 1024 * 1024 * 1024,
    gpus: [
      {
        name: "NVIDIA RTX 4090",
        vramBytes: 24 * 1024 * 1024 * 1024,
        backend: "cuda",
      },
    ],
  };

  const mockMeta: GgufDisplayMetadata = {
    architecture: "llama",
    name: "Llama 3 8B",
    fileSizeBytes: 5 * 1024 * 1024 * 1024,
    blockCount: 32,
    contextLength: 8192,
    embeddingLength: 4096,
    attentionHeadCount: 32,
  };

  it("suggests full offload for 8B model on 4090", () => {
    const config = optimizeLoadConfig(mockHardware, mockMeta);
    expect(config.gpuLayers).toBe(32);
    expect(config.flashAttn).toBe("auto");
    expect(config.contextSize).toBe(8192);
  });

  it("suggests partial offload for giant model", () => {
    const giantMeta: GgufDisplayMetadata = {
      ...mockMeta,
      fileSizeBytes: 100 * 1024 * 1024 * 1024, // 100GB
      blockCount: 80,
    };
    // 24GB VRAM. 500MB margin -> 23.5GB.
    // bytesPerLayer = 100GB / (80 * 1.1) = 1.13GB.
    // 23.5 / 1.13 ~ 20 layers.
    const config = optimizeLoadConfig(mockHardware, giantMeta);
    expect(config.gpuLayers).toBeLessThan(80);
    expect(config.gpuLayers).toBeGreaterThan(0);
  });

  it("suggests 0 layers if no GPU", () => {
    const cpuOnly: HardwareInfo = { ...mockHardware, gpus: [] };
    const config = optimizeLoadConfig(cpuOnly, mockMeta);
    expect(config.gpuLayers).toBe(0);
    expect(config.threads).toBe(8); // Math.min(16-1, 8)
  });

  it("handles Grouped Query Attention architectures successfully saving VRAM", () => {
    const gqaMeta: GgufDisplayMetadata = {
      ...mockMeta,
      attentionHeadCount: 32,
      attentionHeadCountKv: 8, // GQA
    };

    // GQA means much less bytesPerCtxToken, which should allow hitting the higher context brackets
    // with less VRAM usage compared to MHA
    const gqaConfig = optimizeLoadConfig(mockHardware, gqaMeta);
    const _regularConfig = optimizeLoadConfig(mockHardware, mockMeta);

    // In our 4090 mock they both hit 8192 bounds, but verifying they both process correctly
    expect(gqaConfig.contextSize).toBe(8192);
    expect(gqaConfig.gpuLayers).toBe(32);

    // If we lower VRAM to barely fit contexts, GQA outperforms
    const tinyGpu: HardwareInfo = {
      ...mockHardware,
      gpus: [{ name: "Potato", vramBytes: 6 * 1024 * 1024 * 1024, backend: "cuda" }],
    };

    // Force a huge context length
    const hugeGqa: GgufDisplayMetadata = { ...gqaMeta, contextLength: 100000 };
    const hugeMha: GgufDisplayMetadata = { ...mockMeta, contextLength: 100000 };

    const tinyGqaConfig = optimizeLoadConfig(tinyGpu, hugeGqa);
    const tinyMhaConfig = optimizeLoadConfig(tinyGpu, hugeMha);

    // GQA should afford larger context size than MHA on the tiny GPU
    expect(tinyGqaConfig.contextSize || 0).toBeGreaterThanOrEqual(tinyMhaConfig.contextSize || 0);
  });

  it("correctly enables mlock when file size is strictly less than half of total RAM", () => {
    const cpuOnlyLowRam: HardwareInfo = {
      ...mockHardware,
      gpus: [],
      totalRamBytes: 8 * 1024 * 1024 * 1024,
    };
    const config = optimizeLoadConfig(cpuOnlyLowRam, mockMeta);
    // 5GB file > 4GB half-ram -> mlock false
    expect(config.mlock).toBe(false);

    const cpuOnlyHighRam: HardwareInfo = {
      ...mockHardware,
      gpus: [],
      totalRamBytes: 32 * 1024 * 1024 * 1024,
    };
    const config2 = optimizeLoadConfig(cpuOnlyHighRam, mockMeta);
    // 5GB file < 16GB half-ram -> mlock true
    expect(config2.mlock).toBe(true);
  });
});
