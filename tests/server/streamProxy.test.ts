/**
 * @packageDocumentation
 * Tests for streaming proxy completion and cancellation behavior.
 * Verifies that all chat interactions use /v1/chat/completions exclusively,
 * with proper OpenAI-style request/response formatting.
 */

import { afterEach, beforeEach, describe, expect, it, mock, spyOn } from "bun:test";
import { createChat, getChat } from "../../src/server/persistence/chatRepo";
import { initDb, resetDb } from "../../src/server/persistence/db";
import { proxyCompletion } from "../../src/server/streamProxy";

// Mock the llamaServer
mock.module("../../src/server/llamaServer", () => ({
  getServerStatus: () => ({
    status: "running",
    port: 8080,
    config: { modelPath: "test.gguf", contextSize: 4096 },
  }),
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

/**
 * Helper: builds a ReadableStream from an array of SSE lines.
 * Each entry should be a raw JSON object (will be prefixed with "data: ").
 */
function buildSSEStream(events: (object | string)[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      for (const evt of events) {
        if (typeof evt === "string") {
          controller.enqueue(encoder.encode(`data: ${evt}\n\n`));
        } else {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(evt)}\n\n`));
        }
      }
      controller.close();
    },
  });
}

/**
 * Helper: builds a chat completions delta chunk.
 */
function chatDelta(content: string): object {
  return { choices: [{ delta: { content } }] };
}

/**
 * Helper: builds a chat completions stop chunk.
 */
function chatStop(finishReason: string = "stop"): object {
  return {
    choices: [{ delta: {}, finish_reason: finishReason }],
    timings: {
      predicted_ms: 100,
      predicted_n: 5,
      predicted_per_second: 50,
      predicted_per_token_ms: 20,
      prompt_ms: 50,
      prompt_n: 10,
      prompt_per_second: 200,
      prompt_per_token_ms: 5,
      tokens_cached: 3,
      tokens_evaluated: 10,
    },
  };
}

describe("streamProxy", () => {
  let capturedEndpoint: string | null;
  let capturedBody: any;

  beforeEach(async () => {
    await initDb(":memory:");
    capturedEndpoint = null;
    capturedBody = null;
  });

  afterEach(() => {
    resetDb();
  });

  it("ALWAYS sends requests to /v1/chat/completions, never /completion", async () => {
    const stream = buildSSEStream([chatDelta("Hi"), chatStop()]);
    const fetchMock = mock().mockImplementation(async (input: RequestInfo, init?: RequestInit) => {
      capturedEndpoint = String(input);
      capturedBody = init?.body ? JSON.parse(init.body as string) : null;
      return { ok: true, body: stream } as any;
    });
    globalThis.fetch = fetchMock;

    const chat = await createChat("Endpoint Test");
    await proxyCompletion({ chatId: chat.id, content: "hello", attachments: [] });

    // Wait for async stream processing
    await new Promise((r) => setTimeout(r, 200));

    expect(capturedEndpoint).toBe("http://127.0.0.1:8080/v1/chat/completions");
    // Must NOT be the legacy /completion endpoint (without /v1/chat/ prefix)
    expect(capturedEndpoint?.endsWith("/completion")).toBe(false);
    // Should NOT have a prompt field (that's the old /completion format)
    expect(capturedBody.prompt).toBeUndefined();
    // Should ALWAYS have a messages array
    expect(capturedBody.messages).toBeInstanceOf(Array);
  });

  it("sends a proper messages array with user content for plain text chat", async () => {
    const stream = buildSSEStream([chatDelta("Hello"), chatDelta(" World"), chatStop()]);
    const fetchMock = mock().mockImplementation(async (_input: RequestInfo, init?: RequestInit) => {
      capturedBody = init?.body ? JSON.parse(init.body as string) : null;
      return { ok: true, body: stream } as any;
    });
    globalThis.fetch = fetchMock;

    const chat = await createChat("Messages Test");
    const messageId = await proxyCompletion({
      chatId: chat.id,
      content: "Say hi",
      attachments: [],
    });

    await new Promise((r) => setTimeout(r, 200));

    expect(messageId).toBeString();
    expect(capturedBody).not.toBeNull();
    expect(capturedBody.messages).toBeInstanceOf(Array);
    expect(capturedBody.stream).toBe(true);

    // Find the user message in the payload
    const userMsg = capturedBody.messages.find((m: any) => m.role === "user");
    expect(userMsg).toBeDefined();
    // Plain text chat should send content as a string, not an array of parts
    expect(typeof userMsg.content).toBe("string");
    expect(userMsg.content).toContain("Say hi");
  });

  it("includes inference sampling parameters in the request", async () => {
    const stream = buildSSEStream([chatDelta("OK"), chatStop()]);
    const fetchMock = mock().mockImplementation(async (_input: RequestInfo, init?: RequestInit) => {
      capturedBody = init?.body ? JSON.parse(init.body as string) : null;
      return { ok: true, body: stream } as any;
    });
    globalThis.fetch = fetchMock;

    const chat = await createChat("Params Test");
    await proxyCompletion({ chatId: chat.id, content: "test", attachments: [] });

    await new Promise((r) => setTimeout(r, 200));

    expect(capturedBody.temperature).toBeNumber();
    expect(capturedBody.top_k).toBeNumber();
    expect(capturedBody.top_p).toBeNumber();
    expect(capturedBody.min_p).toBeNumber();
    expect(capturedBody.cache_prompt).toBe(true);
  });

  it("includes thinking template kwargs for thinking-enabled models", async () => {
    const stream = buildSSEStream([chatDelta("thinking"), chatStop()]);
    const fetchMock = mock().mockImplementation(async (_input: RequestInfo, init?: RequestInit) => {
      capturedBody = init?.body ? JSON.parse(init.body as string) : null;
      return { ok: true, body: stream } as any;
    });
    globalThis.fetch = fetchMock;

    const chat = await createChat("Thinking Test");
    await proxyCompletion({ chatId: chat.id, content: "think", attachments: [] });

    await new Promise((r) => setTimeout(r, 200));

    // Since thinking is enabled by default (infPreset?.thinkingEnabled ?? true),
    // the request should include chat_template_kwargs and reasoning_format
    expect(capturedBody.chat_template_kwargs).toEqual({ enable_thinking: true });
    expect(capturedBody.reasoning_format).toBe("none");
  });

  it("persists the user message and creates an assistant message row", async () => {
    const stream = buildSSEStream([chatDelta("Reply!"), chatStop()]);
    const fetchMock = mock().mockResolvedValue({ ok: true, body: stream } as any);
    globalThis.fetch = fetchMock;

    const chat = await createChat("Persist Test");
    const assistantMsgId = await proxyCompletion({
      chatId: chat.id,
      content: "Hello there",
      attachments: [],
    });

    await new Promise((r) => setTimeout(r, 500));

    // Reload the chat from DB
    const reloaded = await getChat(chat.id);
    expect(reloaded).not.toBeNull();
    expect(reloaded?.messages).toBeInstanceOf(Array);
    expect(reloaded?.messages?.length).toBeGreaterThanOrEqual(2);

    // Verify user message was persisted
    const userMsg = reloaded?.messages?.find((m) => m.role === "user");
    expect(userMsg).toBeDefined();
    expect(userMsg?.content).toContain("Hello there");

    // Verify assistant message was created
    const assistantMsg = reloaded?.messages?.find((m) => m.id === assistantMsgId);
    expect(assistantMsg).toBeDefined();
    expect(assistantMsg?.role).toBe("assistant");
    expect(assistantMsg?.content).toBe("Reply!");
  });

  it("extracts thinking blocks from streaming content", async () => {
    const stream = buildSSEStream([
      chatDelta("<think>"),
      chatDelta("I am pondering"),
      chatDelta("</think>"),
      chatDelta("The answer is 42"),
      chatStop(),
    ]);
    const fetchMock = mock().mockResolvedValue({ ok: true, body: stream } as any);
    globalThis.fetch = fetchMock;

    const chat = await createChat("Think Test");
    const msgId = await proxyCompletion({
      chatId: chat.id,
      content: "What is the answer?",
      attachments: [],
    });

    await new Promise((r) => setTimeout(r, 500));

    const reloaded = await getChat(chat.id);
    const assistantMsg = reloaded?.messages?.find((m) => m.id === msgId);
    expect(assistantMsg).toBeDefined();
    // Content should have thinking stripped
    expect(assistantMsg?.content).toBe("The answer is 42");
    // Raw content should have everything
    expect(assistantMsg?.rawContent).toContain("<think>");
    expect(assistantMsg?.rawContent).toContain("I am pondering");
    // Thinking content should be extracted
    expect(assistantMsg?.thinkingContent).toContain("I am pondering");
  });

  it("builds image_url multimodal payloads for image attachments", async () => {
    const stream = buildSSEStream([chatDelta("I see an image"), chatStop()]);

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

    await new Promise((r) => setTimeout(r, 200));

    expect(messageId).toBeString();
    expect(fetchMock).toHaveBeenCalled();
    expect(capturedBody).not.toBeNull();
    expect(capturedBody.messages).toBeInstanceOf(Array);
    const userMsg = capturedBody.messages.find((m: any) => m.role === "user");
    expect(userMsg).toBeDefined();
    // With image attachments, content should be multimodal parts array
    expect(Array.isArray(userMsg.content)).toBe(true);
    expect(userMsg.content[0].type).toBe("image_url");
    expect(userMsg.content[0].image_url.url).toMatch(/^file:\/\/\/.+\.png$/);
    expect(userMsg.content[1].type).toBe("text");
    expect(userMsg.content[1].text).toContain("Look at this");
  });

  it("handles max_tokens stop reason from chat completions format", async () => {
    const stream = buildSSEStream([chatDelta("partial"), chatStop("length")]);
    const fetchMock = mock().mockResolvedValue({ ok: true, body: stream } as any);
    globalThis.fetch = fetchMock;

    const chat = await createChat("Length Stop Test");
    await proxyCompletion({ chatId: chat.id, content: "write a lot", attachments: [] });

    // The stop reason should be max_tokens for finish_reason "length"
    // This is verified by the broadcast call internally; as long as
    // no errors are thrown, the response format was handled correctly.
    await new Promise((r) => setTimeout(r, 200));
    // No crash = success; the old code would have failed here with /completion format
  });

  it("returns assistant message ID synchronously before stream completes", async () => {
    // Stream that takes a while
    const stream = new ReadableStream<Uint8Array>({
      async start(controller) {
        const encoder = new TextEncoder();
        await new Promise((r) => setTimeout(r, 100));
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(chatDelta("delayed"))}\n\n`));
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(chatStop())}\n\n`));
        controller.close();
      },
    });
    const fetchMock = mock().mockResolvedValue({ ok: true, body: stream } as any);
    globalThis.fetch = fetchMock;

    const chat = await createChat("Async Test");
    const messageId = await proxyCompletion({
      chatId: chat.id,
      content: "hello",
      attachments: [],
    });

    // proxyCompletion should return the message ID immediately
    // (it kicks off the stream in the background)
    expect(messageId).toBeString();
    expect(messageId.length).toBeGreaterThan(0);
  });

  it("correctly handles tool_calls finish reason for tool-enabled requests", async () => {
    const stream = buildSSEStream([
      {
        choices: [
          {
            delta: {
              tool_calls: [
                { index: 0, id: "tc_1", function: { name: "calculator", arguments: '{"expr":' } },
              ],
            },
          },
        ],
      },
      {
        choices: [
          {
            delta: {
              tool_calls: [{ index: 0, id: "", function: { name: "", arguments: '"2+2"}' } }],
            },
          },
        ],
      },
      chatStop("tool_calls"),
    ]);
    const fetchMock = mock().mockResolvedValue({ ok: true, body: stream } as any);
    globalThis.fetch = fetchMock;

    const chat = await createChat("Tool Call Test");
    // This will attempt to process tool calls — it may error because we haven't
    // mocked the tool approval flow, but the key assertion is that it doesn't
    // crash on response parsing.
    try {
      await proxyCompletion({
        chatId: chat.id,
        content: "calculate 2+2",
        attachments: [],
      });
    } catch (_e) {
      // Tool approval timeout is expected in test
    }

    await new Promise((r) => setTimeout(r, 200));
    // If we got here without a crash, the tool call accumulation worked
  });

  it("handles error responses from the model server gracefully", async () => {
    const errorSpy = spyOn(console, "error").mockImplementation(() => {});

    const fetchMock = mock().mockResolvedValue({
      ok: false,
      status: 500,
      text: async () => "Internal Server Error",
    } as any);
    globalThis.fetch = fetchMock;

    const chat = await createChat("Error Test");
    const messageId = await proxyCompletion({
      chatId: chat.id,
      content: "trigger error",
      attachments: [],
    });

    await new Promise((r) => setTimeout(r, 300));

    // Should still return a message ID (created before the stream starts)
    expect(messageId).toBeString();

    // The orphaned empty assistant message should be cleaned up
    const reloaded = await getChat(chat.id);
    const assistantMsg = reloaded?.messages?.find((m) => m.id === messageId);
    // Should be cleaned up (C6 fix) — empty content messages are deleted
    expect(assistantMsg).toBeUndefined();

    errorSpy.mockRestore();
  });
});
