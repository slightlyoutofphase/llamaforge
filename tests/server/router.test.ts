import { beforeAll, describe, expect, it } from "bun:test";
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

  it("GET /api/settings returns settings", async () => {
    const router = createRouter(settings);
    const req = new Request("http://localhost/api/settings");
    const res = await router.fetch(req, {});
    expect(res?.status).toBe(200);
    const body = await res?.json();
    expect(body).toBeDefined();
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
