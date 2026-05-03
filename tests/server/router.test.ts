/**
 * @packageDocumentation
 * Tests for the router builder and settings-driven route behavior.
 */

import { beforeAll, describe, expect, it, spyOn } from "bun:test";
import * as llamaServerModule from "../../src/server/llamaServer";
import { createChat } from "../../src/server/persistence/chatRepo";
import { initDb } from "../../src/server/persistence/db";
import { createInferencePreset } from "../../src/server/persistence/presetRepo";
import { __setHardwareProbe } from "../../src/server/router";

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
    const router = createRouter(settings);
    const req = new Request("http://localhost/health");
    const res = await router.fetch(req, {});
    expect(res?.status).toBe(200);
    expect(await res?.text()).toBe("OK");
  });

  it("production GET document routes fall back to index.html", async () => {
    const previousNodeEnv = process.env.NODE_ENV;
    process.env.NODE_ENV = "production";
    const fileSpy = spyOn(Bun, "file").mockImplementation((filePath: string | URL) => {
      const pathText = filePath.toString().replace(/\\/g, "/");
      const exists = pathText.endsWith("/dist/client/index.html");
      return Object.assign(new Blob(["<html><body>ok</body></html>"], { type: "text/html" }), {
        exists: async () => exists,
      }) as BunFile;
    });

    try {
      const router = createRouter(settings);
      const req = new Request("http://localhost/chat/prod-route", {
        headers: { Accept: "text/html" },
      });
      const res = await router.fetch(req, {});

      expect(res?.status).toBe(200);
      expect(await res?.text()).toContain("ok");
    } finally {
      fileSpy.mockRestore();
      process.env.NODE_ENV = previousNodeEnv;
    }
  });

  it("production missing asset requests return 404 instead of index.html", async () => {
    const previousNodeEnv = process.env.NODE_ENV;
    process.env.NODE_ENV = "production";

    try {
      const router = createRouter(settings);
      const req = new Request("http://localhost/assets/does-not-exist.js");
      const res = await router.fetch(req, {});

      expect(res?.status).toBe(404);
      expect(await res?.text()).toBe("Not Found");
    } finally {
      process.env.NODE_ENV = previousNodeEnv;
    }
  });

  it("production non-GET SPA route requests return 404", async () => {
    const previousNodeEnv = process.env.NODE_ENV;
    process.env.NODE_ENV = "production";

    try {
      const router = createRouter(settings);
      const req = new Request("http://localhost/chat/prod-route", {
        method: "POST",
        headers: { Accept: "text/html" },
      });
      const res = await router.fetch(req, {});

      expect(res?.status).toBe(404);
      expect(await res?.text()).toBe("Not Found");
    } finally {
      process.env.NODE_ENV = previousNodeEnv;
    }
  });

  it("GET /api/settings returns settings", async () => {
    const router = createRouter(settings);
    const req = new Request("http://localhost/api/settings");
    const res = await router.fetch(req, {});
    expect(res?.status).toBe(200);
    const body = await res?.json();
    expect(body).toBeDefined();
  });

  it("PUT /api/settings rejects invalid numeric settings payloads", async () => {
    const router = createRouter(settings);
    const res = await router.fetch(
      new Request("http://localhost/api/settings", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ requestTimeoutSeconds: -1 }),
      }),
      {},
    );

    expect(res?.status).toBe(400);
    const body = (await res?.json()) as { error?: string };
    expect(body.error).toContain("requestTimeoutSeconds");
  });

  it("GET /api/models caches results and avoids preset writes or broadcasts", async () => {
    const router = createRouter(settings);
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
    const metadataSpy = spyOn(chatRepoModule, "getMetadataForPath").mockResolvedValue({
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
      hasVisionEncoder: false,
      hasAudioEncoder: false,
      defaultTemperature: undefined,
      defaultTopK: undefined,
      defaultTopP: undefined,
      defaultMinP: undefined,
      defaultRepeatPenalty: undefined,
      chatTemplate: undefined,
      bosToken: undefined,
      eosToken: undefined,
    });
    const presetSpy = spyOn(presetRepoModule, "ensureModelDefaultPresets").mockResolvedValue();
    const broadcastSpy = spyOn(wsHubModule, "broadcast").mockImplementation(() => {});

    try {
      const firstRes = await router.fetch(new Request("http://localhost/api/models"), {});
      const secondRes = await router.fetch(new Request("http://localhost/api/models"), {});
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
    const router = createRouter(settings);
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
        defaultTemperature: undefined,
        defaultTopK: undefined,
        defaultTopP: undefined,
        defaultMinP: undefined,
        defaultRepeatPenalty: undefined,
        chatTemplate: undefined,
        bosToken: undefined,
        eosToken: undefined,
      },
    });
    const presetSpy = spyOn(presetRepoModule, "ensureModelDefaultPresets").mockResolvedValue();
    const broadcastSpy = spyOn(wsHubModule, "broadcast").mockImplementation(() => {});

    try {
      const res = await router.fetch(
        new Request("http://localhost/api/models/rescan", { method: "POST" }),
        {},
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
    const router = createRouter(settings);
    const req = new Request("http://localhost/api/unknown");
    const res = await router.fetch(req, {});
    expect(res?.status).toBe(404);
  });

  it("GET /api/attachments/nonexistent returns 404", async () => {
    const router = createRouter(settings);
    const req = new Request("http://localhost/api/attachments/nonexistent.txt");
    const res = await router.fetch(req, {});
    expect(res?.status).toBe(404);
  });

  it("POST /api/chats creates a new chat", async () => {
    const router = createRouter(settings);
    const req = new Request("http://localhost/api/chats", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "Router Test Chat", modelPath: "some/path.gguf" }),
    });
    const res = await router.fetch(req, {});
    expect(res?.status).toBe(200);
    const body: any = await res?.json();
    expect(body.id).toBeDefined();
    expect(body.name).toBe("Router Test Chat");
    expect(body.modelPath).toBe("some/path.gguf");
  });

  it("GET /api/chats returns chat list", async () => {
    const router = createRouter(settings);
    const req = new Request("http://localhost/api/chats");
    const res = await router.fetch(req, {});
    expect(res?.status).toBe(200);
    const body: any = await res?.json();
    expect(Array.isArray(body)).toBe(true);
    expect(body.length).toBeGreaterThan(0);
  });

  it("GET /api/chats/:id returns a specific chat", async () => {
    const chat = await createChat("Specific Chat", "test.gguf");
    const router = createRouter(settings);
    const req = new Request(`http://localhost/api/chats/${chat.id}`);
    const res = await router.fetch(req, {});
    expect(res?.status).toBe(200);
    const body: any = await res?.json();
    expect(body.id).toBe(chat.id);
  });

  it("POST /api/chats/:id/messages accepts multipart attachments without JSON fallback parsing", async () => {
    const chat = await createChat("Multipart Chat", "test.gguf");
    const router = createRouter(settings);
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

      const res = await router.fetch(req, {});
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
    const router = createRouter(settings);
    const req = new Request(`http://localhost/api/chats/${chat.id}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "Updated Chat" }),
    });
    const res = await router.fetch(req, {});
    expect(res?.status).toBe(200);

    // Verify update
    const getReq = new Request(`http://localhost/api/chats/${chat.id}`);
    const getRes = await router.fetch(getReq, {});
    const getBody: any = await getRes?.json();
    expect(getBody.name).toBe("Updated Chat");
  });

  it("POST /api/presets/inference creates a preset", async () => {
    const router = createRouter(settings);
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
    const res = await router.fetch(req, {});
    expect(res?.status).toBe(200);
    const body: any = await res?.json();
    expect(body.success).toBe(true);
  });

  it("GET /api/presets/inference returns presets", async () => {
    await createInferencePreset({ name: "Preset A", config: {} });
    const router = createRouter(settings);
    const req = new Request("http://localhost/api/presets/inference");
    const res = await router.fetch(req, {});
    expect(res?.status).toBe(200);
    const body: any = await res?.json();
    expect(Array.isArray(body)).toBe(true);
    expect(body.some((p: any) => p.name === "Preset A")).toBe(true);
  });

  it("GET /api/hardware returns hardware info payload", async () => {
    const router = createRouter(settings);
    const req = new Request("http://localhost/api/hardware");
    const res = await router.fetch(req, {});
    expect(res?.status).toBe(200);
    const body: any = await res?.json();
    expect(body.cpuThreads).toBeDefined();
    expect(body.totalRamBytes).toBeDefined();
    expect(Array.isArray(body.gpus)).toBe(true);
  });

  it("GET /api/server/status returns current server runtime config", async () => {
    const router = createRouter(settings);
    const req = new Request("http://localhost/api/server/status");
    const res = await router.fetch(req, {});
    expect(res?.status).toBe(200);
    const body: any = await res?.json();
    expect(body).toBeDefined();
  });

  it("POST /api/server/unload responds before teardown finishes", async () => {
    const router = createRouter(settings);
    const unloadSpy = spyOn(llamaServerModule, "requestUnloadModel").mockImplementation(
      () => new Promise<void>(() => {}),
    );

    try {
      const timeoutToken = Symbol("timeout");
      const responseOrTimeout = await Promise.race([
        router.fetch(new Request("http://localhost/api/server/unload", { method: "POST" }), {}),
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
    const router = createRouter(settings);
    const req = new Request("http://localhost/ws");

    const mockServerFailingUpgrade = {
      upgrade: () => false,
    };

    const res = await router.fetch(req, mockServerFailingUpgrade);
    expect(res?.status).toBe(400);
    expect(await res?.text()).toBe("Upgrade failed");
  });
});
