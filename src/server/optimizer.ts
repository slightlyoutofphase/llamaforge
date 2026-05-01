/**
 * @packageDocumentation
 * Optimization algorithm for suggesting model load parameters based on hardware capabilities.
 */

import type { GgufDisplayMetadata, HardwareInfo, ModelLoadConfig } from "@shared/types.js";

/**
 * Calculates optimized load parameters for a given model on specific hardware.
 *
 * @param hardware - Probed system hardware information.
 * @param metadata - GGUF metadata for the target model.
 * @returns Suggested partial {@link ModelLoadConfig} with optimized fields.
 */
export function optimizeLoadConfig(
  hardware: HardwareInfo,
  metadata: GgufDisplayMetadata,
): Partial<ModelLoadConfig> {
  const suggested: Partial<ModelLoadConfig> = {};

  const hasGpu = hardware.gpus.length > 0;
  suggested.flashAttn = hasGpu ? "auto" : "off";

  const totalVram = hardware.gpus.reduce((acc, g) => acc + Math.max(0, g.vramBytes), 0);
  const blockCount = Math.max(0, metadata.blockCount ?? 0);
  const contextLength = metadata.contextLength ?? 4096;
  const embeddingLength = Math.max(4096, metadata.embeddingLength ?? 4096);
  const attentionHeadCount = Math.max(1, metadata.attentionHeadCount ?? 1);
  const attentionHeadCountKv = Math.max(1, metadata.attentionHeadCountKv ?? attentionHeadCount);

  const availableVram = Math.max(0, totalVram - 512 * 1024 * 1024);
  let gpuLayers = 0;

  if (hasGpu && blockCount > 0 && metadata.fileSizeBytes > 0) {
    const bytesPerLayer = metadata.fileSizeBytes / (blockCount * 1.1);
    gpuLayers = Math.floor(availableVram / Math.max(1, bytesPerLayer));
    gpuLayers = Math.max(0, Math.min(gpuLayers, blockCount));
  }

  suggested.gpuLayers = gpuLayers;

  const threadCount = Math.max(1, Math.min(Math.max(1, hardware.cpuThreads - 1), 8));
  suggested.threads = threadCount;

  suggested.contextSize = 4096;
  if (blockCount > 0 && metadata.contextLength) {
    const kvElementSize = 2;
    const headDim = embeddingLength / attentionHeadCount;
    const bytesPerCtxToken = 2 * blockCount * attentionHeadCountKv * headDim * kvElementSize;
    const totalEstimatedBytesPerLayer = metadata.fileSizeBytes / blockCount;
    const vramOccupiedByLayers = gpuLayers * totalEstimatedBytesPerLayer;
    const headroom = Math.max(0, totalVram - vramOccupiedByLayers - 512 * 1024 * 1024);
    let suggestedCtx = Math.floor(headroom / Math.max(1, bytesPerCtxToken));
    suggestedCtx = Math.min(suggestedCtx, contextLength);
    if (suggestedCtx >= 32768) suggested.contextSize = 32768;
    else if (suggestedCtx >= 16384) suggested.contextSize = 16384;
    else if (suggestedCtx >= 8192) suggested.contextSize = 8192;
    else if (suggestedCtx >= 4096) suggested.contextSize = 4096;
    else if (suggestedCtx >= 2048) suggested.contextSize = 2048;
  }

  const useGpuLoad = gpuLayers > 0;
  suggested.batchSize = useGpuLoad ? 2048 : 512;
  suggested.microBatchSize = useGpuLoad ? 512 : 128;

  suggested.mlock =
    metadata.fileSizeBytes > 0 && metadata.fileSizeBytes < hardware.totalRamBytes * 0.5;

  if (blockCount > 0 && gpuLayers > blockCount * 0.5) {
    suggested.kvCacheTypeK = "q8_0";
    suggested.kvCacheTypeV = "q8_0";
  } else {
    suggested.kvCacheTypeK = "f16";
    suggested.kvCacheTypeV = "f16";
  }

  return suggested;
}
