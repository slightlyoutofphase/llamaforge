/**
 * @packageDocumentation
 * Tests for the router builder and settings-driven route behavior.
 */

import { beforeAll, describe, expect, it, spyOn } from "bun:test";
import fs from "node:fs/promises";
import path from "node:path";
import * as llamaServerModule from "../../src/server/llamaServer";
import { addMessage, createChat } from "../../src/server/persistence/chatRepo";
import { getAppDataDir, initDb } from "../../src/server/persistence/db";
import { createInferencePreset } from "../../src/server/persistence/presetRepo";
import { saveSettings } from "../../src/server/persistence/settingsRepo";
import { __setHardwareProbe } from "../../src/server/router";
import { ggufDisplayMetadata, noUpgradeServer, setBunEnv } from "../fixtures";

let createRouter: typeof import("../../src/server/router").createRouter;

describe("router", () => {
  const settings: any = {
    modelsPath: "/tmp/models",
    llamaServerPath: "/usr/bin/llama-server",
    llamaPortRangeMin: 8080,
    llamaPortRangeMax: 8099,
  };

  beforeAll(async () => {
    await initDb(":memory:");
    __setHardwareProbe({
      getHardwareInfo: async () => ({
        totalRamBytes: 8 * 1024 * 1024 * 1024,
        cpuThreads: 4,
        gpus: [],
      }),
    });
    const routerModule = await import("../../src/server/router.ts");
    createRouter = routerModule.createRouter;
  });

  it("GET /health returns 200 OK", async () => {
    const router = createRouter();
    const req = new Request("http://localhost/health");
    const res = await router.fetch(req, noUpgradeServer);
    expect(res?.status).toBe(200);
    expect(await res?.text()).toBe("OK");
  });

  it("production GET document routes fall back to index.html", async () => {
    const previousNodeEnv = Bun.env.NODE_ENV;
    Bun.env.NODE_ENV = "production";
    const fileSpy = spyOn(Bun, "file").mockImplementation(
      (
        filePath: string | URL | ArrayBufferLike | Uint8Array<ArrayBuffer> | number,
        _options?: BlobPropertyBag,
      ) => {
        const pathText = filePath.toString().replace(/\\/g, "/");
        const exists = pathText.endsWith("/dist/client/index.html");
        return Object.assign(new Blob(["<html><body>ok</body></html>"], { type: "text/html" }), {
          exists: async () => exists,
        }) as ReturnType<typeof Bun.file>;
      },
    );

    try {
      const router = createRouter();
      const req = new Request("http://localhost/chat/prod-route", {
        headers: { Accept: "text/html" },
      });
      const res = await router.fetch(req, noUpgradeServer);

      expect(res?.status).toBe(200);
      expect(await res?.text()).toContain("ok");
    } finally {
      fileSpy.mockRestore();
      setBunEnv("NODE_ENV", previousNodeEnv);
    }
  });

  it("production missing asset requests return 404 instead of index.html", async () => {
    const previousNodeEnv = Bun.env.NODE_ENV;
    Bun.env.NODE_ENV = "production";

    try {
      const router = createRouter();
      const req = new Request("http://localhost/assets/does-not-exist.js");
      const res = await router.fetch(req, noUpgradeServer);

      expect(res?.status).toBe(404);
      expect(await res?.text()).toBe("Not Found");
    } finally {
      setBunEnv("NODE_ENV", previousNodeEnv);
    }
  });

  it("production non-GET SPA route requests return 404", async () => {
    const previousNodeEnv = Bun.env.NODE_ENV;
    Bun.env.NODE_ENV = "production";

    try {
      const router = createRouter();
      const req = new Request("http://localhost/chat/prod-route", {
        method: "POST",
        headers: { Accept: "text/html" },
      });
      const res = await router.fetch(req, noUpgradeServer);

      expect(res?.status).toBe(404);
      expect(await res?.text()).toBe("Not Found");
    } finally {
      setBunEnv("NODE_ENV", previousNodeEnv);
    }
  });

  it("GET /api/settings returns settings", async () => {
    const router = createRouter();
    const req = new Request("http://localhost/api/settings");
    const res = await router.fetch(req, noUpgradeServer);
    expect(res?.status).toBe(200);
    const body = await res?.json();
    expect(body).toBeDefined();
  });

  it("GET /api/tools lists built-in and user TypeScript tools", async () => {
    const router = createRouter();
    const res = await router.fetch(new Request("http://localhost/api/tools"), noUpgradeServer);
    expect(res?.status).toBe(200);
    const body = (await res?.json()) as {
      tools?: Array<{ name?: string; source?: string; execute?: unknown }>;
      directories?: string[];
    };
    const names = (body.tools ?? []).map((tool) => tool.name);
    expect(names).toContain("get_datetime");
    expect(names).toContain("calculate");
    expect(names).toContain("echo_text");
    expect(body.tools?.some((tool) => tool.name === "echo_text" && tool.source === "user")).toBe(
      true,
    );
    expect(body.tools?.some((tool) => "execute" in tool && tool.execute !== undefined)).toBe(false);
    expect(Array.isArray(body.directories)).toBe(true);
    expect(body.directories?.some((directory) => directory.endsWith("tools"))).toBe(true);
  });

  it("JSON API responses close the connection for direct browser clients", async () => {
    const router = createRouter();

    const settingsRes = await router.fetch(
      new Request("http://localhost/api/settings"),
      noUpgradeServer,
    );
    const chatRes = await router.fetch(
      new Request("http://localhost/api/chats", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: "Connection Close Test" }),
      }),
      noUpgradeServer,
    );

    expect(settingsRes?.status).toBe(200);
    expect(chatRes?.status).toBe(200);
    expect(settingsRes?.headers.get("connection")).toBe("close");
    expect(chatRes?.headers.get("connection")).toBe("close");
  });

  it("POST /api/chats/:id/branch-and-edit returns a JSON 404 for missing branch messages", async () => {
    const router = createRouter();
    const chat = await createChat("Branch Edit Error");

    const res = await router.fetch(
      new Request(`http://localhost/api/chats/${chat.id}/branch-and-edit`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ messageId: "missing-message", newContent: "edited" }),
      }),
      noUpgradeServer,
    );

    expect(res?.status).toBe(404);
    expect(res?.headers.get("content-type")).toContain("application/json");
    const body = (await res?.json()) as { error?: string };
    expect(body.error).toBe("Message not found in chat");
  });

  it("PUT /api/settings rejects invalid numeric settings payloads", async () => {
    const router = createRouter();
    const res = await router.fetch(
      new Request("http://localhost/api/settings", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ requestTimeoutSeconds: -1 }),
      }),
      noUpgradeServer,
    );

    expect(res?.status).toBe(400);
    const body = (await res?.json()) as { error?: string };
    expect(body.error).toContain("requestTimeoutSeconds");
  });

  it("GET /api/models caches results and avoids preset writes or broadcasts", async () => {
    const router = createRouter();
    const modelScannerModule = await import("../../src/server/modelScanner.ts");
    const chatRepoModule = await import("../../src/server/persistence/chatRepo.ts");
    const presetRepoModule = await import("../../src/server/persistence/presetRepo.ts");
    const wsHubModule = await import("../../src/server/wsHub.ts");

    const scanSpy = spyOn(modelScannerModule, "scanModels").mockResolvedValue([
      {
        publisher: "Test Publisher",
        modelName: "Cached Model",
        primaryPath: "/tmp/models/cached.gguf",
      },
    ]);
    const metadataSpy = spyOn(chatRepoModule, "getMetadataForPath").mockResolvedValue(
      ggufDisplayMetadata({
        architecture: "llama",
        name: "Cached Model",
        fileSizeBytes: 123,
        contextLength: 4096,
        embeddingLength: undefined,
        attentionHeadCount: undefined,
        attentionHeadCountKv: undefined,
        blockCount: undefined,
        feedForwardLength: undefined,
        quantType: undefined,
      }),
    );
    const presetSpy = spyOn(presetRepoModule, "ensureModelDefaultPresets").mockResolvedValue();
    const broadcastSpy = spyOn(wsHubModule, "broadcast").mockImplementation(() => {});

    try {
      const firstRes = await router.fetch(
        new Request("http://localhost/api/models"),
        noUpgradeServer,
      );
      const secondRes = await router.fetch(
        new Request("http://localhost/api/models"),
        noUpgradeServer,
      );
      const body: any[] = (await secondRes?.json()) as any[];

      expect(firstRes?.status).toBe(200);
      expect(secondRes?.status).toBe(200);
      expect(scanSpy).toHaveBeenCalledTimes(1);
      expect(metadataSpy).toHaveBeenCalledTimes(1);
      expect(body[0]?.metadata?.name).toBe("Cached Model");
      expect(presetSpy).not.toHaveBeenCalled();
      expect(broadcastSpy).not.toHaveBeenCalled();
    } finally {
      scanSpy.mockRestore();
      metadataSpy.mockRestore();
      presetSpy.mockRestore();
      broadcastSpy.mockRestore();
    }
  });

  it("POST /api/models/rescan refreshes the cache and emits preset updates", async () => {
    const router = createRouter();
    const modelScannerModule = await import("../../src/server/modelScanner.ts");
    const chatRepoModule = await import("../../src/server/persistence/chatRepo.ts");
    const presetRepoModule = await import("../../src/server/persistence/presetRepo.ts");
    const wsHubModule = await import("../../src/server/wsHub.ts");

    const scanSpy = spyOn(modelScannerModule, "scanModels").mockResolvedValue([
      {
        publisher: "Test Publisher",
        modelName: "Fresh Model",
        primaryPath: "/tmp/models/fresh.gguf",
      },
    ]);
    const metadataSpy = spyOn(chatRepoModule, "getMetadataForPath").mockResolvedValue(null);
    const populateSpy = spyOn(modelScannerModule, "populateMetadata").mockResolvedValue({
      publisher: "Test Publisher",
      modelName: "Fresh Model",
      primaryPath: "/tmp/models/fresh.gguf",
      metadata: {
        architecture: "llama",
        name: "Fresh Model",
        fileSizeBytes: 456,
        contextLength: 8192,
        embeddingLength: undefined,
        attentionHeadCount: undefined,
        attentionHeadCountKv: undefined,
        blockCount: undefined,
        feedForwardLength: undefined,
        quantType: undefined,
        hasVisionEncoder: false,
        hasAudioEncoder: false,
        hasToolCalling: false,
        isDraftModel: false,
        defaultTemperature: undefined,
        defaultTopK: undefined,
        defaultTopP: undefined,
        defaultMinP: undefined,
        defaultRepeatPenalty: undefined,
        chatTemplate: undefined,
      },
    });
    const presetSpy = spyOn(presetRepoModule, "ensureModelDefaultPresets").mockResolvedValue();
    const broadcastSpy = spyOn(wsHubModule, "broadcast").mockImplementation(() => {});

    try {
      const res = await router.fetch(
        new Request("http://localhost/api/models/rescan", { method: "POST" }),
        noUpgradeServer,
      );
      expect(res?.status).toBe(200);
      expect(scanSpy).toHaveBeenCalledTimes(1);
      expect(populateSpy).toHaveBeenCalledTimes(1);
      expect(presetSpy).toHaveBeenCalledTimes(1);
      expect(broadcastSpy).toHaveBeenCalledTimes(1);
    } finally {
      scanSpy.mockRestore();
      metadataSpy.mockRestore();
      populateSpy.mockRestore();
      presetSpy.mockRestore();
      broadcastSpy.mockRestore();
    }
  });

  it("returns 404 for unknown endpoints", async () => {
    const router = createRouter();
    const req = new Request("http://localhost/api/unknown");
    const res = await router.fetch(req, noUpgradeServer);
    expect(res?.status).toBe(404);
  });

  it("GET /api/attachments/nonexistent returns 404", async () => {
    const router = createRouter();
    const req = new Request("http://localhost/api/attachments/nonexistent.txt");
    const res = await router.fetch(req, noUpgradeServer);
    expect(res?.status).toBe(404);
  });

  it("POST /api/chats creates a new chat", async () => {
    const router = createRouter();
    const req = new Request("http://localhost/api/chats", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "Router Test Chat", modelPath: "some/path.gguf" }),
    });
    const res = await router.fetch(req, noUpgradeServer);
    expect(res?.status).toBe(200);
    const body: any = await res?.json();
    expect(body.id).toBeDefined();
    expect(body.name).toBe("Router Test Chat");
    expect(body.modelPath).toBe("some/path.gguf");
  });

  it("GET /api/chats returns chat list", async () => {
    const router = createRouter();
    const req = new Request("http://localhost/api/chats");
    const res = await router.fetch(req, noUpgradeServer);
    expect(res?.status).toBe(200);
    const body: any = await res?.json();
    expect(Array.isArray(body)).toBe(true);
    expect(body.length).toBeGreaterThan(0);
  });

  it("GET /api/chats/:id returns a specific chat", async () => {
    const chat = await createChat("Specific Chat", "test.gguf");
    const router = createRouter();
    const req = new Request(`http://localhost/api/chats/${chat.id}`);
    const res = await router.fetch(req, noUpgradeServer);
    expect(res?.status).toBe(200);
    const body: any = await res?.json();
    expect(body.id).toBe(chat.id);
  });

  it("POST /api/chats/:id/messages accepts multipart attachments without JSON fallback parsing", async () => {
    const chat = await createChat("Multipart Chat", "test.gguf");
    const router = createRouter();
    const streamProxyModule = await import("../../src/server/streamProxy.ts");
    const proxyCompletionSpy = spyOn(streamProxyModule, "proxyCompletion").mockResolvedValue(
      "message-1",
    );
    const formData = new FormData();
    const file = new File(["image-bytes"], "image.png", { type: "image/png" });
    formData.append("content", "Describe this image");
    formData.append("file", file);

    try {
      const req = new Request(`http://localhost/api/chats/${chat.id}/messages`, {
        method: "POST",
        body: formData,
      });

      const res = await router.fetch(req, noUpgradeServer);
      expect(res?.status).toBe(200);
      expect(proxyCompletionSpy).toHaveBeenCalledTimes(1);
      const firstCall = proxyCompletionSpy.mock.calls[0]?.[0] as {
        chatId: string;
        content: string;
        attachments: File[];
      };
      expect(firstCall.chatId).toBe(chat.id);
      expect(firstCall.content).toBe("Describe this image");
      expect(firstCall.attachments).toHaveLength(1);
      expect(firstCall.attachments[0]?.name).toBe(file.name);
      expect(firstCall.attachments[0]?.type).toBe(file.type);
    } finally {
      proxyCompletionSpy.mockRestore();
    }
  });

  it("PUT /api/chats/:id updates a chat", async () => {
    const chat = await createChat("Update Me", "test.gguf");
    const router = createRouter();
    const req = new Request(`http://localhost/api/chats/${chat.id}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "Updated Chat" }),
    });
    const res = await router.fetch(req, noUpgradeServer);
    expect(res?.status).toBe(200);

    // Verify update
    const getReq = new Request(`http://localhost/api/chats/${chat.id}`);
    const getRes = await router.fetch(getReq, noUpgradeServer);
    const getBody: any = await getRes?.json();
    expect(getBody.name).toBe("Updated Chat");
  });

  it("POST /api/presets/inference creates a preset", async () => {
    const router = createRouter();
    const req = new Request("http://localhost/api/presets/inference", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "Test Config",
        config: {
          temperature: 0.8,
          topK: 40,
        },
      }),
    });
    const res = await router.fetch(req, noUpgradeServer);
    expect(res?.status).toBe(200);
    const body: any = await res?.json();
    expect(body.success).toBe(true);
  });

  it("GET /api/presets/inference returns presets", async () => {
    await createInferencePreset({
      id: "preset-a",
      name: "Preset A",
      isDefault: false,
      temperature: 0.8,
      topK: 40,
      topP: 0.95,
      minP: 0.05,
      repeatPenalty: 1.1,
      repeatLastN: 64,
      typicalP: 1.0,
      presencePenalty: 0.0,
      frequencyPenalty: 0.0,
      mirostat: 0,
      mirostatTau: 5.0,
      mirostatEta: 0.1,
      dynaTempRange: 0.0,
      dynaTempExponent: 1.0,
      seed: -1,
      maxTokens: -1,
      stopStrings: [],
      toolCallsEnabled: false,
      tools: [],
      structuredOutput: undefined,
      contextOverflowPolicy: "TruncateMiddle",
      thinkingEnabled: true,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });
    const router = createRouter();
    const req = new Request("http://localhost/api/presets/inference");
    const res = await router.fetch(req, noUpgradeServer);
    expect(res?.status).toBe(200);
    const body: any = await res?.json();
    expect(Array.isArray(body)).toBe(true);
    expect(body.some((p: any) => p.name === "Preset A")).toBe(true);
  });

  it("GET /api/hardware returns hardware info payload", async () => {
    const router = createRouter();
    const req = new Request("http://localhost/api/hardware");
    const res = await router.fetch(req, noUpgradeServer);
    expect(res?.status).toBe(200);
    const body: any = await res?.json();
    expect(body.cpuThreads).toBeDefined();
    expect(body.totalRamBytes).toBeDefined();
    expect(Array.isArray(body.gpus)).toBe(true);
  });

  it("GET /api/server/status returns current server runtime config", async () => {
    const router = createRouter();
    const req = new Request("http://localhost/api/server/status");
    const res = await router.fetch(req, noUpgradeServer);
    expect(res?.status).toBe(200);
    const body: any = await res?.json();
    expect(body).toBeDefined();
  });

  it("POST /api/server/load prefers the scanned model mmProjPath over stale request data", async () => {
    await saveSettings({
      modelsPath: settings.modelsPath,
      llamaServerPath: settings.llamaServerPath,
      llamaPortRangeMin: settings.llamaPortRangeMin,
      llamaPortRangeMax: settings.llamaPortRangeMax,
    });

    const router = createRouter();
    const modelScannerModule = await import("../../src/server/modelScanner.ts");
    const chatRepoModule = await import("../../src/server/persistence/chatRepo.ts");

    const scanSpy = spyOn(modelScannerModule, "scanModels").mockResolvedValue([
      {
        publisher: "Test Publisher",
        modelName: "Multimodal Model",
        primaryPath: "/tmp/models/multimodal.gguf",
        mmProjPath: "/tmp/models/multimodal.mmproj.gguf",
      },
    ]);
    const metadataSpy = spyOn(chatRepoModule, "getMetadataForPath").mockResolvedValue(null);
    const loadSpy = spyOn(llamaServerModule, "loadModel").mockResolvedValue(12000);

    try {
      const res = await router.fetch(
        new Request("http://localhost/api/server/load", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            modelPath: "/tmp/models/multimodal.gguf",
            mmProjPath: "/tmp/models/stale.mmproj.gguf",
            contextSize: 4096,
            contextShift: false,
            gpuLayers: 0,
            threads: 4,
            batchSize: 512,
            microBatchSize: 128,
            ropeScaling: "none",
            ropeFreqBase: 10000,
            ropeFreqScale: 1,
            kvCacheTypeK: "f16",
            kvCacheTypeV: "f16",
            mlock: false,
            noMmap: false,
            contBatching: true,
            flashAttn: "off",
            swaFull: false,
            noKvOffload: false,
            cacheReuse: 0,
          }),
        }),
        noUpgradeServer,
      );

      expect(res?.status).toBe(200);
      expect(loadSpy).toHaveBeenCalledTimes(1);
      expect(loadSpy.mock.calls[0]?.[0]).toEqual(
        expect.objectContaining({
          modelPath: "/tmp/models/multimodal.gguf",
          mmProjPath: "/tmp/models/multimodal.mmproj.gguf",
        }),
      );
    } finally {
      scanSpy.mockRestore();
      metadataSpy.mockRestore();
      loadSpy.mockRestore();
    }
  });

  it("POST /api/server/load auto-populates specDraftModelPath for draft-simple mode", async () => {
    await saveSettings({
      modelsPath: settings.modelsPath,
      llamaServerPath: settings.llamaServerPath,
      llamaPortRangeMin: settings.llamaPortRangeMin,
      llamaPortRangeMax: settings.llamaPortRangeMax,
    });

    const router = createRouter();
    const modelScannerModule = await import("../../src/server/modelScanner.ts");
    const chatRepoModule = await import("../../src/server/persistence/chatRepo.ts");

    const scanSpy = spyOn(modelScannerModule, "scanModels").mockResolvedValue([
      {
        publisher: "Test Publisher",
        modelName: "Main Model",
        primaryPath: "/tmp/models/main.gguf",
        draftModelPath: "/tmp/models/main-assistant.gguf",
      },
    ]);
    const metadataSpy = spyOn(chatRepoModule, "getMetadataForPath").mockResolvedValue(null);
    const loadSpy = spyOn(llamaServerModule, "loadModel").mockResolvedValue(12000);

    try {
      const res = await router.fetch(
        new Request("http://localhost/api/server/load", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            modelPath: "/tmp/models/main.gguf",
            contextSize: 4096,
            contextShift: false,
            gpuLayers: 0,
            threads: 4,
            batchSize: 512,
            microBatchSize: 128,
            ropeScaling: "none",
            ropeFreqBase: 10000,
            ropeFreqScale: 1,
            kvCacheTypeK: "f16",
            kvCacheTypeV: "f16",
            mlock: false,
            noMmap: false,
            contBatching: true,
            flashAttn: "off",
            swaFull: false,
            noKvOffload: false,
            cacheReuse: 0,
            specType: "draft-simple",
          }),
        }),
        noUpgradeServer,
      );

      expect(res?.status).toBe(200);
      expect(loadSpy).toHaveBeenCalledTimes(1);
      expect(loadSpy.mock.calls[0]?.[0]).toEqual(
        expect.objectContaining({
          modelPath: "/tmp/models/main.gguf",
          specDraftModelPath: "/tmp/models/main-assistant.gguf",
        }),
      );
    } finally {
      scanSpy.mockRestore();
      metadataSpy.mockRestore();
      loadSpy.mockRestore();
    }
  });

  it("POST /api/server/load keeps an explicit specDraftModelPath instead of overwriting it", async () => {
    await saveSettings({
      modelsPath: settings.modelsPath,
      llamaServerPath: settings.llamaServerPath,
      llamaPortRangeMin: settings.llamaPortRangeMin,
      llamaPortRangeMax: settings.llamaPortRangeMax,
    });

    const router = createRouter();
    const modelScannerModule = await import("../../src/server/modelScanner.ts");
    const chatRepoModule = await import("../../src/server/persistence/chatRepo.ts");

    const scanSpy = spyOn(modelScannerModule, "scanModels").mockResolvedValue([
      {
        publisher: "Test Publisher",
        modelName: "Main Model",
        primaryPath: "/tmp/models/main.gguf",
        draftModelPath: "/tmp/models/main-assistant.gguf",
      },
    ]);
    const metadataSpy = spyOn(chatRepoModule, "getMetadataForPath").mockResolvedValue(null);
    const loadSpy = spyOn(llamaServerModule, "loadModel").mockResolvedValue(12000);

    try {
      const res = await router.fetch(
        new Request("http://localhost/api/server/load", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            modelPath: "/tmp/models/main.gguf",
            contextSize: 4096,
            contextShift: false,
            gpuLayers: 0,
            threads: 4,
            batchSize: 512,
            microBatchSize: 128,
            ropeScaling: "none",
            ropeFreqBase: 10000,
            ropeFreqScale: 1,
            kvCacheTypeK: "f16",
            kvCacheTypeV: "f16",
            mlock: false,
            noMmap: false,
            contBatching: true,
            flashAttn: "off",
            swaFull: false,
            noKvOffload: false,
            cacheReuse: 0,
            specType: "draft-simple",
            specDraftModelPath: "/tmp/models/custom-assistant.gguf",
          }),
        }),
        noUpgradeServer,
      );

      expect(res?.status).toBe(200);
      expect(loadSpy).toHaveBeenCalledTimes(1);
      expect(loadSpy.mock.calls[0]?.[0]).toEqual(
        expect.objectContaining({
          modelPath: "/tmp/models/main.gguf",
          specDraftModelPath: "/tmp/models/custom-assistant.gguf",
        }),
      );
    } finally {
      scanSpy.mockRestore();
      metadataSpy.mockRestore();
      loadSpy.mockRestore();
    }
  });

  it("POST /api/server/load auto-populates specDraftModelPath for draft-mtp assistants", async () => {
    await saveSettings({
      modelsPath: settings.modelsPath,
      llamaServerPath: settings.llamaServerPath,
      llamaPortRangeMin: settings.llamaPortRangeMin,
      llamaPortRangeMax: settings.llamaPortRangeMax,
    });

    const router = createRouter();
    const modelScannerModule = await import("../../src/server/modelScanner.ts");
    const chatRepoModule = await import("../../src/server/persistence/chatRepo.ts");

    const scanSpy = spyOn(modelScannerModule, "scanModels").mockResolvedValue([
      {
        publisher: "Test Publisher",
        modelName: "Main Model",
        primaryPath: "/tmp/models/main.gguf",
        draftModelPath: "/tmp/models/main-assistant.gguf",
        draftSpecType: "draft-mtp",
      },
    ]);
    const metadataSpy = spyOn(chatRepoModule, "getMetadataForPath").mockResolvedValue(null);
    const loadSpy = spyOn(llamaServerModule, "loadModel").mockResolvedValue(12000);

    try {
      const res = await router.fetch(
        new Request("http://localhost/api/server/load", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            modelPath: "/tmp/models/main.gguf",
            contextSize: 4096,
            contextShift: false,
            gpuLayers: 0,
            threads: 4,
            batchSize: 512,
            microBatchSize: 128,
            ropeScaling: "none",
            ropeFreqBase: 10000,
            ropeFreqScale: 1,
            kvCacheTypeK: "f16",
            kvCacheTypeV: "f16",
            mlock: false,
            noMmap: false,
            contBatching: true,
            flashAttn: "off",
            swaFull: false,
            noKvOffload: false,
            cacheReuse: 0,
            specType: "draft-mtp",
          }),
        }),
        noUpgradeServer,
      );

      expect(res?.status).toBe(200);
      expect(loadSpy).toHaveBeenCalledTimes(1);
      expect(loadSpy.mock.calls[0]?.[0]).toEqual(
        expect.objectContaining({
          modelPath: "/tmp/models/main.gguf",
          specType: "draft-mtp",
          specDraftModelPath: "/tmp/models/main-assistant.gguf",
        }),
      );
    } finally {
      scanSpy.mockRestore();
      metadataSpy.mockRestore();
      loadSpy.mockRestore();
    }
  });

  it("POST /api/server/load does not inject an MTP assistant into draft-simple mode", async () => {
    await saveSettings({
      modelsPath: settings.modelsPath,
      llamaServerPath: settings.llamaServerPath,
      llamaPortRangeMin: settings.llamaPortRangeMin,
      llamaPortRangeMax: settings.llamaPortRangeMax,
    });

    const router = createRouter();
    const modelScannerModule = await import("../../src/server/modelScanner.ts");
    const chatRepoModule = await import("../../src/server/persistence/chatRepo.ts");

    const scanSpy = spyOn(modelScannerModule, "scanModels").mockResolvedValue([
      {
        publisher: "Test Publisher",
        modelName: "Main Model",
        primaryPath: "/tmp/models/main.gguf",
        draftModelPath: "/tmp/models/main-assistant.gguf",
        draftSpecType: "draft-mtp",
      },
    ]);
    const metadataSpy = spyOn(chatRepoModule, "getMetadataForPath").mockResolvedValue(null);
    const loadSpy = spyOn(llamaServerModule, "loadModel").mockResolvedValue(12000);

    try {
      const res = await router.fetch(
        new Request("http://localhost/api/server/load", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            modelPath: "/tmp/models/main.gguf",
            contextSize: 4096,
            contextShift: false,
            gpuLayers: 0,
            threads: 4,
            batchSize: 512,
            microBatchSize: 128,
            ropeScaling: "none",
            ropeFreqBase: 10000,
            ropeFreqScale: 1,
            kvCacheTypeK: "f16",
            kvCacheTypeV: "f16",
            mlock: false,
            noMmap: false,
            contBatching: true,
            flashAttn: "off",
            swaFull: false,
            noKvOffload: false,
            cacheReuse: 0,
            specType: "draft-simple",
          }),
        }),
        noUpgradeServer,
      );

      expect(res?.status).toBe(200);
      expect(loadSpy).toHaveBeenCalledTimes(1);
      const simpleCall = loadSpy.mock.calls[0]?.[0];
      expect(simpleCall?.modelPath).toBe("/tmp/models/main.gguf");
      expect(simpleCall).not.toHaveProperty("specDraftModelPath");
    } finally {
      scanSpy.mockRestore();
      metadataSpy.mockRestore();
      loadSpy.mockRestore();
    }
  });

  it("POST /api/server/unload responds before teardown finishes", async () => {
    const router = createRouter();
    const unloadSpy = spyOn(llamaServerModule, "requestUnloadModel").mockImplementation(
      () => new Promise<void>(() => {}),
    );

    try {
      const timeoutToken = Symbol("timeout");
      const responseOrTimeout = await Promise.race([
        router.fetch(
          new Request("http://localhost/api/server/unload", { method: "POST" }),
          noUpgradeServer,
        ),
        new Promise<symbol>((resolve) => setTimeout(() => resolve(timeoutToken), 100)),
      ]);

      expect(responseOrTimeout).not.toBe(timeoutToken);
      expect(responseOrTimeout).toBeInstanceOf(Response);
      const res = responseOrTimeout as Response;
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ success: true });
      expect(unloadSpy).toHaveBeenCalledTimes(1);
    } finally {
      unloadSpy.mockRestore();
    }
  });

  it("handles WS upgrade failure with 400 Bad Request naturally if the server blocks it", async () => {
    const router = createRouter();
    const req = new Request("http://localhost/ws", {
      headers: { Origin: "http://localhost:3000" },
    });

    const mockServerFailingUpgrade = {
      upgrade: () => false,
    };

    const res = await router.fetch(req, mockServerFailingUpgrade);
    expect(res?.status).toBe(400);
    expect(await res?.text()).toBe("Upgrade failed");
  });

  it("rejects WebSocket upgrades without an Origin header", async () => {
    const router = createRouter();
    const req = new Request("http://localhost/ws");
    const upgrade = { upgrade: () => true };
    const res = await router.fetch(req, upgrade);
    expect(res?.status).toBe(403);
  });

  it("rejects WebSocket upgrades from unexpected origins", async () => {
    const router = createRouter();
    const req = new Request("http://localhost/ws", {
      headers: { Origin: "https://evil.example" },
    });
    const upgrade = { upgrade: () => true };
    const res = await router.fetch(req, upgrade);
    expect(res?.status).toBe(403);
  });

  it("rejects mutating API requests from unexpected origins", async () => {
    const router = createRouter();
    const req = new Request("http://localhost/api/chats", {
      method: "POST",
      headers: {
        Origin: "https://evil.example",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ name: "Injected" }),
    });
    const res = await router.fetch(req, noUpgradeServer);
    expect(res?.status).toBe(403);
  });

  it("production hashed assets resolve under dist/client rather than as an absolute URL path", async () => {
    const previousNodeEnv = Bun.env.NODE_ENV;
    Bun.env.NODE_ENV = "production";
    const requestedPaths: string[] = [];
    const fileSpy = spyOn(Bun, "file").mockImplementation(
      (
        filePath: string | URL | ArrayBufferLike | Uint8Array<ArrayBuffer> | number,
        _options?: BlobPropertyBag,
      ) => {
        const pathText = filePath.toString().replace(/\\/g, "/");
        requestedPaths.push(pathText);
        const exists = pathText.includes("/dist/client/assets/") && pathText.endsWith("/app.js");
        return Object.assign(new Blob(["console.log(1)"], { type: "text/javascript" }), {
          exists: async () => exists,
        }) as ReturnType<typeof Bun.file>;
      },
    );

    try {
      const router = createRouter();
      const res = await router.fetch(
        new Request("http://localhost/assets/app.js"),
        noUpgradeServer,
      );

      expect(res?.status).toBe(200);
      expect(await res?.text()).toBe("console.log(1)");
      expect(requestedPaths.some((p) => p.includes("/dist/client/assets/app.js"))).toBe(true);
      expect(
        requestedPaths.some((p) => p === "/assets/app.js" || p.endsWith(":/assets/app.js")),
      ).toBe(false);
    } finally {
      fileSpy.mockRestore();
      setBunEnv("NODE_ENV", previousNodeEnv);
    }
  });

  it("production static serving keeps resolved files under dist/client", async () => {
    const previousNodeEnv = Bun.env.NODE_ENV;
    Bun.env.NODE_ENV = "production";
    const requestedPaths: string[] = [];
    const fileSpy = spyOn(Bun, "file").mockImplementation(
      (
        filePath: string | URL | ArrayBufferLike | Uint8Array<ArrayBuffer> | number,
        _options?: BlobPropertyBag,
      ) => {
        requestedPaths.push(filePath.toString());
        return Object.assign(new Blob(["ok"], { type: "text/plain" }), {
          exists: async () => false,
        }) as ReturnType<typeof Bun.file>;
      },
    );

    try {
      const router = createRouter();
      await router.fetch(
        new Request("http://localhost/assets/../../llamaforge.db"),
        noUpgradeServer,
      );
      await router.fetch(new Request("http://localhost/etc/passwd"), noUpgradeServer);

      const normalized = requestedPaths.map((p) => p.replace(/\\/g, "/"));
      expect(normalized.length).toBeGreaterThan(0);
      expect(normalized.every((p) => p.includes("/dist/client/"))).toBe(true);
      expect(
        normalized.some(
          (p) =>
            p === "/llamaforge.db" ||
            p === "/etc/passwd" ||
            p.endsWith(":/llamaforge.db") ||
            p.endsWith(":/etc/passwd"),
        ),
      ).toBe(false);
    } finally {
      fileSpy.mockRestore();
      setBunEnv("NODE_ENV", previousNodeEnv);
    }
  });

  it("GET /api/attachments refuses files outside the attachments directory", async () => {
    const appRoot = getAppDataDir();
    const secretPath = path.join(appRoot, "p0-attachment-secret.txt");
    await Bun.write(secretPath, "should-not-be-served");

    try {
      const router = createRouter();
      const dbRes = await router.fetch(
        new Request("http://localhost/api/attachments/llamaforge.db"),
        noUpgradeServer,
      );
      const slashEscapeRes = await router.fetch(
        new Request("http://localhost/api/attachments/..%5Cp0-attachment-secret.txt"),
        noUpgradeServer,
      );

      expect(dbRes?.status).toBe(404);
      expect(await dbRes?.text()).not.toContain("SQLite format 3");
      expect(slashEscapeRes?.status).toBe(400);
      expect(await slashEscapeRes?.text()).not.toContain("should-not-be-served");
    } finally {
      await fs.rm(secretPath, { force: true });
    }
  });

  it("GET /api/attachments serves files from the attachments directory", async () => {
    const relative = "attachments/p0-test-chat/p0-test-msg/hello.txt";
    const absPath = path.join(getAppDataDir(), ...relative.split("/"));
    await fs.mkdir(path.dirname(absPath), { recursive: true });
    await Bun.write(absPath, "attachment-ok");

    try {
      const router = createRouter();
      const res = await router.fetch(
        new Request(`http://localhost/api/attachments/${relative}`),
        noUpgradeServer,
      );
      expect(res?.status).toBe(200);
      expect(await res?.text()).toBe("attachment-ok");
      expect(res?.headers.get("Content-Disposition")).toContain("attachment");
    } finally {
      await fs.rm(absPath, { force: true });
    }
  });

  it("GET /api/attachments serves video with inline disposition and Range slices", async () => {
    const relative = "attachments/p0-test-chat/p0-test-msg/clip.mp4";
    const absPath = path.join(getAppDataDir(), ...relative.split("/"));
    await fs.mkdir(path.dirname(absPath), { recursive: true });
    const payload = Buffer.from("0123456789abcdef");
    await Bun.write(absPath, payload);

    try {
      const router = createRouter();
      const full = await router.fetch(
        new Request(`http://localhost/api/attachments/${relative}`),
        noUpgradeServer,
      );
      expect(full?.status).toBe(200);
      expect(full?.headers.get("Content-Disposition")).toContain("inline");
      expect(full?.headers.get("Accept-Ranges")).toBe("bytes");

      const ranged = await router.fetch(
        new Request(`http://localhost/api/attachments/${relative}`, {
          headers: { Range: "bytes=0-3" },
        }),
        noUpgradeServer,
      );
      expect(ranged?.status).toBe(206);
      expect(ranged?.headers.get("Content-Range")).toBe(`bytes 0-3/${payload.length}`);
      expect(new Uint8Array((await ranged?.arrayBuffer()) ?? new ArrayBuffer(0))).toEqual(
        new Uint8Array([48, 49, 50, 51]),
      );
    } finally {
      await fs.rm(absPath, { force: true });
    }
  });

  it("POST /api/chats/:id/continue rejects when the last message is not an assistant", async () => {
    const chat = await createChat("Continue Guard");
    await addMessage({
      id: Bun.randomUUIDv7(),
      chatId: chat.id,
      role: "user",
      content: "hi",
      rawContent: "hi",
      position: 0,
      createdAt: Date.now(),
    });
    await addMessage({
      id: Bun.randomUUIDv7(),
      chatId: chat.id,
      role: "tool",
      content: "tool-result",
      rawContent: "tool-result",
      position: 1,
      createdAt: Date.now(),
      toolCallId: "tc_1",
    });

    const router = createRouter();
    const res = await router.fetch(
      new Request(`http://localhost/api/chats/${chat.id}/continue`, { method: "POST" }),
      noUpgradeServer,
    );

    expect(res?.status).toBe(400);
    const body = (await res?.json()) as { error?: string };
    expect(body.error).toContain("assistant");
  });

  it("POST /api/presets/load rejects unknown config fields", async () => {
    const router = createRouter();
    const res = await router.fetch(
      new Request("http://localhost/api/presets/load", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: "Unsafe",
          config: {
            modelPath: "/models/model.gguf",
            extraFlag: "--smuggle",
          },
        }),
      }),
      noUpgradeServer,
    );
    expect(res?.status).toBe(400);
    const body = (await res?.json()) as { error?: string };
    expect(body.error).toContain("Unknown load preset config fields");
  });

  it("GET /api/runtime/usage reports LlamaForge process memory", async () => {
    const router = createRouter();
    const res = await router.fetch(
      new Request("http://localhost/api/runtime/usage"),
      noUpgradeServer,
    );
    expect(res?.status).toBe(200);
    const body = (await res?.json()) as { ramBytes?: number; vramBytes?: number };
    expect(typeof body.ramBytes).toBe("number");
    expect(body.ramBytes).toBeGreaterThan(0);
    expect(typeof body.vramBytes).toBe("number");
    expect(body.vramBytes).toBeGreaterThanOrEqual(0);
  });

  it("GET /api/chats/:id/context-usage returns occupancy for the selected chat", async () => {
    const chat = await createChat("Context usage chat");
    await addMessage({
      id: Bun.randomUUIDv7(),
      chatId: chat.id,
      role: "user",
      content: "hello occupancy",
      rawContent: "hello occupancy",
      position: 0,
      createdAt: Date.now(),
    });
    const router = createRouter();
    const res = await router.fetch(
      new Request(`http://localhost/api/chats/${chat.id}/context-usage`),
      noUpgradeServer,
    );
    expect(res?.status).toBe(200);
    const body = (await res?.json()) as { usedTokens?: number; contextSize?: number | null };
    expect(body.usedTokens).toBeGreaterThan(0);
    expect(body.contextSize).toBeNull();
  });

  it("GET /api/settings exposes autoloadLastModel disabled by default", async () => {
    const router = createRouter();
    const res = await router.fetch(new Request("http://localhost/api/settings"), noUpgradeServer);
    expect(res?.status).toBe(200);
    const body = (await res?.json()) as { autoloadLastModel?: boolean };
    expect(body.autoloadLastModel).toBe(false);
  });

  it("GET /api/settings exposes includeVideoAudio disabled by default", async () => {
    const router = createRouter();
    const res = await router.fetch(new Request("http://localhost/api/settings"), noUpgradeServer);
    expect(res?.status).toBe(200);
    const body = (await res?.json()) as { includeVideoAudio?: boolean };
    expect(body.includeVideoAudio).toBe(false);
  });

  it("DELETE /api/chats/:id/messages/:msgId removes that message and later ones", async () => {
    const chat = await createChat("Router Delete Message");
    const userId = Bun.randomUUIDv7();
    const assistantId = Bun.randomUUIDv7();
    await addMessage({
      id: userId,
      chatId: chat.id,
      role: "user",
      content: "hello",
      rawContent: "hello",
      position: 0,
      createdAt: Date.now(),
    });
    await addMessage({
      id: assistantId,
      chatId: chat.id,
      role: "assistant",
      content: "hi",
      rawContent: "hi",
      position: 1,
      createdAt: Date.now(),
    });

    const router = createRouter();
    const res = await router.fetch(
      new Request(`http://localhost/api/chats/${chat.id}/messages/${assistantId}`, {
        method: "DELETE",
      }),
      noUpgradeServer,
    );
    expect(res?.status).toBe(200);

    const remaining = await router.fetch(
      new Request(`http://localhost/api/chats/${chat.id}`),
      noUpgradeServer,
    );
    const body = (await remaining?.json()) as { messages?: Array<{ id: string }> };
    expect(body.messages?.map((message) => message.id)).toEqual([userId]);
  });

  it("DELETE /api/chats/:id/messages/:msgId returns 404 when the message is gone", async () => {
    const chat = await createChat("Router Delete Missing");
    const router = createRouter();
    const res = await router.fetch(
      new Request(`http://localhost/api/chats/${chat.id}/messages/missing-message`, {
        method: "DELETE",
      }),
      noUpgradeServer,
    );
    expect(res?.status).toBe(404);
  });

  it("POST /api/chats/:id/messages returns 409 when expectedHeadMessageId does not match", async () => {
    const chat = await createChat("Transcript Mismatch");
    const userId = Bun.randomUUIDv7();
    await addMessage({
      id: userId,
      chatId: chat.id,
      role: "user",
      content: "old turn",
      rawContent: "old turn",
      position: 0,
      createdAt: Date.now(),
    });

    const router = createRouter();
    const streamProxyModule = await import("../../src/server/streamProxy.ts");
    const proxyCompletionSpy = spyOn(streamProxyModule, "proxyCompletion").mockResolvedValue(
      "should-not-run",
    );
    try {
      const res = await router.fetch(
        new Request(`http://localhost/api/chats/${chat.id}/messages`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ content: "new turn", expectedHeadMessageId: null }),
        }),
        noUpgradeServer,
      );
      expect(res?.status).toBe(409);
      const body = (await res?.json()) as { code?: string; lastMessageId?: string };
      expect(body.code).toBe("TRANSCRIPT_MISMATCH");
      expect(body.lastMessageId).toBe(userId);
      expect(proxyCompletionSpy).not.toHaveBeenCalled();
    } finally {
      proxyCompletionSpy.mockRestore();
    }
  });

  it("POST /api/chats/:id/regenerate deletes later assistant rows before generating", async () => {
    const chat = await createChat("Router Regenerate");
    const userId = Bun.randomUUIDv7();
    const assistantId = Bun.randomUUIDv7();
    await addMessage({
      id: userId,
      chatId: chat.id,
      role: "user",
      content: "hello",
      rawContent: "hello",
      position: 0,
      createdAt: Date.now(),
    });
    await addMessage({
      id: assistantId,
      chatId: chat.id,
      role: "assistant",
      content: "old",
      rawContent: "old",
      position: 1,
      createdAt: Date.now(),
    });

    const streamProxyModule = await import("../../src/server/streamProxy.ts");
    const proxyCompletionSpy = spyOn(streamProxyModule, "proxyCompletion").mockImplementation(
      async () => {
        const remaining = await import("../../src/server/persistence/chatRepo").then((repo) =>
          repo.getChat(chat.id),
        );
        expect(remaining?.messages?.map((message) => message.id)).toEqual([userId]);
        return "a-new";
      },
    );

    try {
      const router = createRouter();
      const res = await router.fetch(
        new Request(`http://localhost/api/chats/${chat.id}/regenerate`, { method: "POST" }),
        noUpgradeServer,
      );
      expect(res?.status).toBe(200);
      expect(proxyCompletionSpy).toHaveBeenCalledTimes(1);
      expect(proxyCompletionSpy.mock.calls[0]?.[0]).toEqual(
        expect.objectContaining({ chatId: chat.id, isRegenerate: true }),
      );
    } finally {
      proxyCompletionSpy.mockRestore();
    }
  });
});
