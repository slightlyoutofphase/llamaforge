/**
 * @packageDocumentation
 * Tests for streaming proxy completion and cancellation behavior.
 */

import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import { createChat } from "../../src/server/persistence/chatRepo";
import { initDb, resetDb } from "../../src/server/persistence/db";
import { proxyCompletion } from "../../src/server/streamProxy";

// Mock the llamaServer
mock.module("../../src/server/llamaServer", () => ({
  getServerStatus: () => ({ status: "running", port: 8080 }),
  getCurrentConfig: () => ({
    primaryPath: "test.gguf",
  }),
}));

mock.module("node:fs/promises", () => ({
  default: {
    mkdir: async () => {},
    writeFile: async () => {},
    readFile: async (_path: string) => Buffer.from("abc"),
    access: async () => {},
  },
  mkdir: async () => {},
  writeFile: async () => {},
  readFile: async (_path: string) => Buffer.from("abc"),
  access: async () => {},
}));

describe("streamProxy", () => {
  beforeEach(async () => {
    await initDb(":memory:");
  });

  afterEach(() => {
    resetDb();
  });

  it("handles a successful stream response without thinking blocks", async () => {
    // Generate a mock stream
    const encoder = new TextEncoder();
    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(encoder.encode('data: {"content": "Hello"}\n\n'));
        controller.enqueue(encoder.encode('data: {"content": " World"}\n\n'));
        controller.enqueue(encoder.encode('data: {"stop": true}\n\n'));
        controller.close();
      },
    });

    // Mock fetch
    const fetchMock = mock().mockResolvedValue({ ok: true, body: stream } as any);
    globalThis.fetch = fetchMock;

    const chat = await createChat("Proxy Test");
    const messageId = await proxyCompletion({
      chatId: chat.id,
      content: "Hi",
      attachments: [],
    });

    expect(messageId).toBeString();
    expect(fetchMock).toHaveBeenCalled();
    const completionCall = fetchMock.mock.calls.find((c: any) =>
      String(c[0]).endsWith("/completion"),
    );
    const reqBody = JSON.parse(completionCall[1].body);
    expect(reqBody.stream).toBe(true);
    expect(reqBody.prompt).toBeString();
  });

  it("builds image_url multimodal payloads for image attachments", async () => {
    const encoder = new TextEncoder();
    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(encoder.encode('data: {"choices":[{"delta":{"content":"Hello"}}]}\n\n'));
        controller.enqueue(
          encoder.encode('data: {"choices":[{"delta":{"content":" World"}}]}\n\n'),
        );
        controller.enqueue(encoder.encode('data: {"choices":[{"finish_reason":"stop"}]}\n\n'));
        controller.close();
      },
    });

    let capturedBody: any = null;
    const fetchMock = mock().mockImplementation(async (_input: RequestInfo, init?: RequestInit) => {
      capturedBody = init?.body ? JSON.parse(init.body as string) : null;
      return { ok: true, body: stream } as any;
    });
    globalThis.fetch = fetchMock;

    const chat = await createChat("Multimodal Flow");
    const file = new File(["abc"], "img.png", { type: "image/png" });
    const messageId = await proxyCompletion({
      chatId: chat.id,
      content: "Look at this",
      attachments: [file],
    });

    expect(messageId).toBeString();
    expect(fetchMock).toHaveBeenCalled();
    expect(capturedBody).not.toBeNull();
    expect(capturedBody.messages).toBeInstanceOf(Array);
    const userMsg = capturedBody.messages.find((m: any) => m.role === "user");
    expect(userMsg).toBeDefined();
    expect(Array.isArray(userMsg.content)).toBe(true);
    expect(userMsg.content[0].type).toBe("image_url");
    expect(userMsg.content[0].image_url.url).toMatch(/^file:\/\/\/.+\.png$/);
    expect(userMsg.content[1].type).toBe("text");
    expect(userMsg.content[1].text).toContain("Look at this");
  });

  it("extracts thinking blocks correctly", async () => {
    const encoder = new TextEncoder();
    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(encoder.encode('data: {"content": "<think>"}\n\n'));
        controller.enqueue(encoder.encode('data: {"content": "I am thinking"}\n\n'));
        controller.enqueue(encoder.encode('data: {"content": "</think>"}\n\n'));
        controller.enqueue(encoder.encode('data: {"content": "Done"}\n\n'));
        controller.enqueue(encoder.encode('data: {"stop": true}\n\n'));
        controller.close();
      },
    });

    const fetchMock = mock().mockResolvedValue({ ok: true, body: stream } as any);
    globalThis.fetch = fetchMock;

    const chat = await createChat("Think Test");

    // We also need to mock chatTemplateEngine to return a think config
    mock.module("../../src/server/chatTemplateEngine", () => ({
      buildPrompt: async () => ({
        messages: [{ role: "user", content: "Hi" }],
        thinkingConfig: { start: "<think>", end: "</think>" },
        formattingConfig: { systemTemplate: "", format: "" },
      }),
    }));

    const messageId = await proxyCompletion({
      chatId: chat.id,
      content: "Think",
      attachments: [],
    });

    expect(messageId).toBeString();
  });
});
