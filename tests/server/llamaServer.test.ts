/**
 * @packageDocumentation
 * Tests for llama-server command line argument construction and lifecycle.
 */

import { describe, expect, it } from "bun:test";
import { buildArgs, loadModel } from "../../src/server/llamaServer";
import { getAppDataDir } from "../../src/server/persistence/db";
import type { ModelLoadConfig } from "../../src/shared/types";

const baseConfig: ModelLoadConfig = {
  modelPath: "/models/model.gguf",
  contextSize: 4096,
  gpuLayers: 33,
  threads: 4,
  batchSize: 512,
  microBatchSize: 128,
  ropeScaling: "none",
  ropeFreqBase: 10000,
  ropeFreqScale: 1.0,
  kvCacheTypeK: "f16",
  kvCacheTypeV: "f16",
  mlock: true,
  noMmap: false,
  contBatching: true,
  flashAttn: "on",
  swaFull: false,
  noKvOffload: false,
  cacheReuse: 0,
  contextCheckpoints: 32,
};

describe("llamaServer", () => {
  it("buildArgs constructs correct flags array", () => {
    const config: ModelLoadConfig = {
      ...baseConfig,
      chatTemplateFile: "/tmp/custom.jinja",
    };

    const args = buildArgs(config, 12345);

    expect(args).toContain("--model");
    expect(args[args.indexOf("--model") + 1]).toBe("/models/model.gguf");

    expect(args).toContain("--port");
    expect(args[args.indexOf("--port") + 1]).toBe("12345");

    expect(args).toContain("--n-gpu-layers");
    expect(args[args.indexOf("--n-gpu-layers") + 1]).toBe("33");

    expect(args).toContain("--mlock");
    expect(args).not.toContain("--no-mmap");
    expect(args).toContain("--parallel");
    expect(args).toContain("--jinja");
    expect(args).toContain("--cont-batching");
    expect(args).toContain("--flash-attn");
    expect(args[args.indexOf("--flash-attn") + 1]).toBe("on");

    expect(args).toContain("--kv-offload");
    expect(args).toContain("--cache-reuse");
    expect(args[args.indexOf("--cache-reuse") + 1]).toBe("0");
    expect(args).toContain("--ctx-checkpoints");
    expect(args[args.indexOf("--ctx-checkpoints") + 1]).toBe("32");
    expect(args).toContain("--chat-template-file");
    expect(args[args.indexOf("--chat-template-file") + 1]).toBe("/tmp/custom.jinja");
    expect(args).toContain("--media-path");
    expect(args[args.indexOf("--media-path") + 1]).toBe(getAppDataDir());
  });

  it("adds optional arguments when provided", () => {
    const config: Partial<ModelLoadConfig> = {
      modelPath: "/test",
      mainGpu: 1,
      tensorSplit: [0.3, 0.7],
      numa: "distribute",
      logLevel: 3,
      seedOverride: 42,
    };

    const args = buildArgs(config as ModelLoadConfig, 8080);

    expect(args).toContain("--main-gpu");
    expect(args[args.indexOf("--main-gpu") + 1]).toBe("1");

    expect(args).toContain("--tensor-split");
    expect(args[args.indexOf("--tensor-split") + 1]).toBe("0.3,0.7");

    expect(args).toContain("--numa");
    expect(args[args.indexOf("--numa") + 1]).toBe("distribute");

    expect(args).toContain("--log-verbosity");
    expect(args[args.indexOf("--log-verbosity") + 1]).toBe("3");

    expect(args).toContain("--seed");
    expect(args[args.indexOf("--seed") + 1]).toBe("42");
  });

  it("adds speculative decoding flags when configured", () => {
    const config: ModelLoadConfig = {
      ...baseConfig,
      specType: "draft-mtp",
      specDraftNMax: 12,
      specDraftNMin: 2,
      specDraftPMin: 0.85,
    };

    const args = buildArgs(config, 8080);

    expect(args).toContain("--spec-type");
    expect(args[args.indexOf("--spec-type") + 1]).toBe("draft-mtp");
    expect(args).toContain("--spec-draft-n-max");
    expect(args[args.indexOf("--spec-draft-n-max") + 1]).toBe("12");
    expect(args).toContain("--spec-draft-n-min");
    expect(args[args.indexOf("--spec-draft-n-min") + 1]).toBe("2");
    expect(args).toContain("--spec-draft-p-min");
    expect(args[args.indexOf("--spec-draft-p-min") + 1]).toBe("0.85");
  });

  it("adds draft model path for draft-simple mode", () => {
    const config: ModelLoadConfig = {
      ...baseConfig,
      specType: "draft-simple",
      specDraftModelPath: "/models/draft.gguf",
      specDraftNMax: 8,
    };

    const args = buildArgs(config, 8080);

    expect(args).toContain("--spec-type");
    expect(args[args.indexOf("--spec-type") + 1]).toBe("draft-simple");
    expect(args).toContain("--spec-draft-model");
    expect(args[args.indexOf("--spec-draft-model") + 1]).toBe("/models/draft.gguf");
  });

  it("omits speculative decoding flags when mode is off", () => {
    const config: ModelLoadConfig = {
      ...baseConfig,
      specType: "off",
    };

    const args = buildArgs(config, 8080);

    expect(args).not.toContain("--spec-type");
    expect(args).not.toContain("--spec-draft-n-max");
    expect(args).not.toContain("--spec-draft-model");
  });

  it("adds image token load flags when configured", () => {
    const config: ModelLoadConfig = {
      ...baseConfig,
      gpuLayers: 0,
      threads: 1,
      batchSize: 1,
      microBatchSize: 1,
      ropeFreqBase: 0,
      ropeFreqScale: 0,
      mlock: false,
      contBatching: false,
      flashAttn: "off",
      noKvOffload: true,
      imageMaxTokens: 560,
    };

    const args = buildArgs(config, 8080);

    expect(args).toContain("--image-min-tokens");
    expect(args[args.indexOf("--image-min-tokens") + 1]).toBe("70");
    expect(args).toContain("--image-max-tokens");
    expect(args[args.indexOf("--image-max-tokens") + 1]).toBe("560");
  });

  it("always includes the fixed image minimum token flag", () => {
    const config: ModelLoadConfig = {
      ...baseConfig,
      gpuLayers: 0,
      threads: 1,
      batchSize: 1,
      microBatchSize: 1,
      ropeFreqBase: 0,
      ropeFreqScale: 0,
      mlock: false,
      contBatching: false,
      flashAttn: "off",
      noKvOffload: true,
    };

    const args = buildArgs(config, 8080);

    expect(args).toContain("--image-min-tokens");
    expect(args[args.indexOf("--image-min-tokens") + 1]).toBe("70");
    expect(args).not.toContain("--image-max-tokens");
  });

  it("rejects invalid llama-server port ranges before spawning", async () => {
    await expect(loadModel(baseConfig, "/missing/llama-server", 13000, 12000)).rejects.toThrow(
      "minimum exceeds maximum",
    );
  });
});
