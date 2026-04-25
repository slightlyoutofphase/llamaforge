import { describe, expect, it } from "bun:test";
import { buildArgs } from "../../src/server/llamaServer";
import type { ModelLoadConfig } from "../../src/shared/types";

describe("llamaServer", () => {
  it("buildArgs constructs correct flags array", () => {
    const config: ModelLoadConfig = {
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
    };

    const args = buildArgs(config, 12345);

    expect(args).toContain("--model");
    expect(args[args.indexOf("--model") + 1]).toBe("/models/model.gguf");

    expect(args).toContain("--port");
    expect(args[args.indexOf("--port") + 1]).toBe("12345");

    expect(args).toContain("-ngl");
    expect(args[args.indexOf("-ngl") + 1]).toBe("33");

    expect(args).toContain("--mlock");
    expect(args).not.toContain("--no-mmap");
    expect(args).toContain("--parallel");
    expect(args).toContain("--jinja");
  });

  it("adds optional arguments when provided", () => {
    const config: Partial<ModelLoadConfig> = {
      modelPath: "/test",
      mainGpu: 1,
      tensorSplit: [0.3, 0.7],
      numa: "distribute",
      logLevel: 3,
      seedOverride: 42,
      chatTemplate: "chatml",
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

    expect(args).toContain("--chat-template");
    expect(args[args.indexOf("--chat-template") + 1]).toBe("chatml");
  });

  it("adds image token load flags when configured", () => {
    const config: ModelLoadConfig = {
      modelPath: "/models/model.gguf",
      contextSize: 4096,
      gpuLayers: 0,
      threads: 1,
      batchSize: 1,
      microBatchSize: 1,
      ropeScaling: "none",
      ropeFreqBase: 0,
      ropeFreqScale: 0,
      kvCacheTypeK: "f16",
      kvCacheTypeV: "f16",
      mlock: false,
      noMmap: false,
      flashAttention: false,
      imageMaxTokens: 560,
    };

    const args = buildArgs(config, 8080);

    expect(args).toContain("--image-min-tokens");
    expect(args[args.indexOf("--image-min-tokens") + 1]).toBe("70");
    expect(args).toContain("--image-max-tokens");
    expect(args[args.indexOf("--image-max-tokens") + 1]).toBe("560");
  });
});
