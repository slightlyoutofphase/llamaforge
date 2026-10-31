/**
 * @packageDocumentation
 * Tests for the optimizer logic that suggests load configuration values.
 */

import { describe, expect, it } from "bun:test";
import type { GgufDisplayMetadata, HardwareInfo } from "@shared/types";
import { optimizeLoadConfig } from "../../src/server/optimizer";
import { ggufDisplayMetadata } from "../fixtures";

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

  const mockMeta: GgufDisplayMetadata = ggufDisplayMetadata({
    architecture: "llama",
    name: "Llama 3 8B",
    fileSizeBytes: 5 * 1024 * 1024 * 1024,
    blockCount: 32,
    contextLength: 8192,
    embeddingLength: 4096,
    attentionHeadCount: 32,
  });

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
    // Layer weights are inflated by 1.1 and a 4096-token KV reserve is taken
    // before layers are counted, so this offload stays well under a full fit.
    const config = optimizeLoadConfig(mockHardware, giantMeta);
    expect(config.gpuLayers).toBeLessThan(18);
    expect(config.gpuLayers).toBeGreaterThan(0);
  });

  it("suggests 0 layers if no GPU", () => {
    const cpuOnly: HardwareInfo = { ...mockHardware, gpus: [] };
    const config = optimizeLoadConfig(cpuOnly, mockMeta);
    expect(config.gpuLayers).toBe(0);
    expect(config.threads).toBe(8); // Math.min(16-1, 8)
    expect(config.contextSize).toBeGreaterThan(4096);
  });

  it("stays conservative for unconfirmed WMI-only GPU entries", () => {
    const descriptiveOnlyGpu: HardwareInfo = {
      ...mockHardware,
      gpus: [
        {
          name: "NVIDIA GeForce RTX 4090",
          vramBytes: 24 * 1024 * 1024 * 1024,
          backend: "unknown",
        },
      ],
    };

    const config = optimizeLoadConfig(descriptiveOnlyGpu, mockMeta);
    expect(config.gpuLayers).toBe(0);
    expect(config.flashAttn).toBe("off");
    expect(config.batchSize).toBe(512);
    expect(config.microBatchSize).toBe(128);
  });

  it("raises ubatch to fit the default vision image-token budget", () => {
    const visionMeta: GgufDisplayMetadata = {
      ...mockMeta,
      architecture: "gemma4",
      hasVisionEncoder: true,
      hasAudioEncoder: false,
    };
    const config = optimizeLoadConfig(mockHardware, visionMeta);
    expect(config.imageMaxTokens).toBe(560);
    expect(config.imageMinTokens).toBe(70);
    expect(config.microBatchSize).toBe(560);
    expect((config.batchSize ?? 0) >= (config.microBatchSize ?? 0)).toBe(true);
  });

  it("does not raise ubatch for non-Gemma vision models", () => {
    const visionMeta: GgufDisplayMetadata = {
      ...mockMeta,
      architecture: "qwen3vl",
      hasVisionEncoder: true,
      hasAudioEncoder: false,
    };
    const config = optimizeLoadConfig(mockHardware, visionMeta);
    expect(config.imageMaxTokens).toBe(560);
    expect(config.imageMinTokens).toBe(70);
    expect(config.microBatchSize).toBe(512);
  });

  it("handles Grouped Query Attention architectures successfully saving VRAM", () => {
    const gqaMeta: GgufDisplayMetadata = {
      ...mockMeta,
      attentionHeadCount: 32,
      attentionHeadCountKv: 8, // GQA
    };

    const gqaConfig = optimizeLoadConfig(mockHardware, gqaMeta);
    const regularConfig = optimizeLoadConfig(mockHardware, mockMeta);

    // On a 4090 both configs saturate the model's native 8192 context window.
    expect(gqaConfig.contextSize).toBe(8192);
    expect(gqaConfig.gpuLayers).toBe(32);
    expect(regularConfig.contextSize).toBe(8192);
    expect(regularConfig.gpuLayers).toBe(32);

    // Leave enough KV-cache headroom that GQA and MHA land in different context brackets.
    // 1GB weights on 6GB VRAM: ~4.5GB KV budget. MHA ~512KB/token → 8192; GQA ~128KB/token → 32768.
    const constrainedGpu: HardwareInfo = {
      ...mockHardware,
      gpus: [{ name: "Potato", vramBytes: 6 * 1024 * 1024 * 1024, backend: "cuda" }],
    };
    const compactWeights: Pick<GgufDisplayMetadata, "fileSizeBytes" | "contextLength"> = {
      fileSizeBytes: 1 * 1024 * 1024 * 1024,
      contextLength: 100000,
    };
    const tinyGqaConfig = optimizeLoadConfig(constrainedGpu, { ...gqaMeta, ...compactWeights });
    const tinyMhaConfig = optimizeLoadConfig(constrainedGpu, { ...mockMeta, ...compactWeights });

    expect(tinyGqaConfig.contextSize).toBe(32768);
    expect(tinyMhaConfig.contextSize).toBe(8192);
    expect(tinyGqaConfig.contextSize ?? 0).toBeGreaterThan(tinyMhaConfig.contextSize ?? 0);
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
