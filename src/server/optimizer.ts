/**
 * @packageDocumentation
 * Optimization algorithm for suggesting model load parameters based on hardware capabilities.
 */

import {
  applyImageTokenBatchFloor,
  DEFAULT_IMAGE_MAX_TOKENS,
  DEFAULT_IMAGE_MIN_TOKENS,
} from "../shared/imageTokens";
import type { GgufDisplayMetadata, HardwareInfo, ModelLoadConfig } from "../shared/types";

type ConfirmedGpuBackend = "cuda" | "rocm" | "metal" | "vulkan";

/**
 * Determines whether a GPU backend represents a confirmed accelerator runtime.
 *
 * @param backend - Backend identifier reported by hardware probing.
 * @returns `true` when the backend can safely be treated as GPU-accelerated.
 */
function isConfirmedGpuBackend(
  backend: HardwareInfo["gpus"][number]["backend"],
): backend is ConfirmedGpuBackend {
  return backend === "cuda" || backend === "rocm" || backend === "metal" || backend === "vulkan";
}

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

  const confirmedGpus = hardware.gpus.filter((gpu) => isConfirmedGpuBackend(gpu.backend));
  const hasGpu = confirmedGpus.length > 0;
  suggested.flashAttn = hasGpu ? "auto" : "off";

  const totalVram = confirmedGpus.reduce((acc, g) => acc + Math.max(0, g.vramBytes), 0);
  const blockCount = Math.max(0, metadata.blockCount ?? 0);
  const contextLength = metadata.contextLength ?? 4096;
  const embeddingLength = Math.max(256, metadata.embeddingLength ?? 4096);
  const attentionHeadCount = Math.max(1, metadata.attentionHeadCount ?? 1);
  const attentionHeadCountKv = Math.max(1, metadata.attentionHeadCountKv ?? attentionHeadCount);

  const runtimeReserveBytes = 512 * 1024 * 1024;
  const layerSizeOverhead = 1.1;
  const kvElementSize = 2;
  const headDim = embeddingLength / attentionHeadCount;
  const bytesPerCtxToken =
    blockCount > 0 ? 2 * blockCount * attentionHeadCountKv * headDim * kvElementSize : 1;
  const baselineContextTokens = Math.min(4096, contextLength);
  const kvReserveBytes = blockCount > 0 ? baselineContextTokens * bytesPerCtxToken : 0;
  const availableForWeights = Math.max(0, totalVram - runtimeReserveBytes - kvReserveBytes);
  const bytesPerLayer =
    blockCount > 0 && metadata.fileSizeBytes > 0
      ? (metadata.fileSizeBytes / blockCount) * layerSizeOverhead
      : 0;
  let gpuLayers = 0;

  if (hasGpu && bytesPerLayer > 0) {
    gpuLayers = Math.floor(availableForWeights / bytesPerLayer);
    gpuLayers = Math.max(0, Math.min(gpuLayers, blockCount));
  }

  suggested.gpuLayers = gpuLayers;

  const threadCount = Math.max(1, Math.min(Math.max(1, hardware.cpuThreads - 1), 8));
  suggested.threads = threadCount;

  suggested.contextSize = 4096;
  if (blockCount > 0 && metadata.contextLength) {
    const weightBytes = gpuLayers * (metadata.fileSizeBytes / blockCount) * layerSizeOverhead;
    const ramHeadroom = Math.max(
      0,
      hardware.totalRamBytes - metadata.fileSizeBytes - 2 * 1024 * 1024 * 1024,
    );
    const headroom =
      gpuLayers > 0 ? Math.max(0, totalVram - weightBytes - runtimeReserveBytes) : ramHeadroom;
    let suggestedCtx = Math.floor(headroom / Math.max(1, bytesPerCtxToken));
    suggestedCtx = Math.min(suggestedCtx, contextLength);
    if (suggestedCtx >= 32768) suggested.contextSize = 32768;
    else if (suggestedCtx >= 16384) suggested.contextSize = 16384;
    else if (suggestedCtx >= 8192) suggested.contextSize = 8192;
    else if (suggestedCtx >= 4096) suggested.contextSize = 4096;
    else if (suggestedCtx >= 2048) suggested.contextSize = 2048;
  }

  const useGpuLoad = gpuLayers > 0;
  const batchSize = useGpuLoad ? 2048 : 512;
  const microBatchSize = useGpuLoad ? 512 : 128;

  const imageBudget = metadata.hasVisionEncoder ? DEFAULT_IMAGE_MAX_TOKENS : undefined;
  if (imageBudget !== undefined) {
    suggested.imageMaxTokens = imageBudget;
    suggested.imageMinTokens = DEFAULT_IMAGE_MIN_TOKENS;
  }
  const floored = applyImageTokenBatchFloor(
    batchSize,
    microBatchSize,
    imageBudget,
    metadata.architecture,
  );
  suggested.batchSize = floored.batchSize;
  suggested.microBatchSize = floored.microBatchSize;

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
