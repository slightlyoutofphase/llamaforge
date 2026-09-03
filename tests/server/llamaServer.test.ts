/**
 * @packageDocumentation
 * Tests for llama-server command line argument construction and lifecycle.
 */

import { describe, expect, it, spyOn } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { buildArgs, getServerStatus, loadModel } from "../../src/server/llamaServer";
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
    };

    const args = buildArgs(config, 12345);

    expect(args).toContain("--model");
    expect(args[args.indexOf("--model") + 1]).toBe("/models/model.gguf");

    expect(args).toContain("--port");
    expect(args[args.indexOf("--port") + 1]).toBe("12345");

    expect(args).toContain("--n-gpu-layers");
    expect(args[args.indexOf("--n-gpu-layers") + 1]).toBe("33");

    expect(args).toContain("--load-mode");
    expect(args[args.indexOf("--load-mode") + 1]).toBe("mmap+mlock");
    expect(args).not.toContain("--mlock");
    expect(args).not.toContain("--no-mmap");
    expect(args).not.toContain("--parallel");
    expect(args).not.toContain("--jinja");
    expect(args).toContain("--cont-batching");
    expect(args).toContain("--flash-attn");
    expect(args[args.indexOf("--flash-attn") + 1]).toBe("on");

    expect(args).toContain("--kv-offload");
    expect(args).toContain("--cache-reuse");
    expect(args[args.indexOf("--cache-reuse") + 1]).toBe("0");
    expect(args).toContain("--ctx-checkpoints");
    expect(args[args.indexOf("--ctx-checkpoints") + 1]).toBe("32");
    expect(args).not.toContain("--chat-template-file");
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

  it("adds image-max-tokens when configured and omits image-min-tokens by default", () => {
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

    expect(args).not.toContain("--image-min-tokens");
    expect(args).toContain("--image-max-tokens");
    expect(args[args.indexOf("--image-max-tokens") + 1]).toBe("560");
    expect(args[args.indexOf("--ubatch-size") + 1]).toBe("1120");
    expect(Number(args[args.indexOf("--batch-size") + 1])).toBeGreaterThanOrEqual(1120);
  });

  it("emits image-min-tokens only when set alongside image-max-tokens", () => {
    const withBoth: ModelLoadConfig = {
      ...baseConfig,
      imageMaxTokens: 560,
      imageMinTokens: 70,
    };
    const withMinOnly: ModelLoadConfig = {
      ...baseConfig,
      imageMinTokens: 70,
    };

    const bothArgs = buildArgs(withBoth, 8080);
    const minOnlyArgs = buildArgs(withMinOnly, 8080);

    expect(bothArgs).toContain("--image-min-tokens");
    expect(bothArgs[bothArgs.indexOf("--image-min-tokens") + 1]).toBe("70");
    expect(minOnlyArgs).not.toContain("--image-min-tokens");
    expect(minOnlyArgs).not.toContain("--image-max-tokens");
  });

  it("does not emit image-min-tokens when no image budget is configured", () => {
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

    expect(args).not.toContain("--image-min-tokens");
    expect(args).not.toContain("--image-max-tokens");
    expect(args[args.indexOf("--ubatch-size") + 1]).toBe("1");
  });

  it("rejects invalid llama-server port ranges before spawning", async () => {
    await expect(loadModel(baseConfig, "/missing/llama-server", 13000, 12000)).rejects.toThrow(
      "minimum exceeds maximum",
    );
  });

  it("resets status to idle when load fails after status is set to loading", async () => {
    const dummyBin = path.join(os.tmpdir(), `llamaforge-dummy-bin-${Date.now()}`);
    await Bun.write(dummyBin, "not-an-executable");
    if (process.platform !== "win32") {
      await fs.chmod(dummyBin, 0o755);
    }
    const writeSpy = spyOn(Bun, "write").mockRejectedValue(new Error("disk full"));
    try {
      await expect(
        loadModel(
          { ...baseConfig, chatTemplateContent: "{{ bos_token }}" },
          dummyBin,
          18000,
          18010,
        ),
      ).rejects.toThrow("disk full");
      expect(getServerStatus().status).toBe("idle");
    } finally {
      writeSpy.mockRestore();
      await fs.unlink(dummyBin).catch(() => undefined);
    }
  });
});
