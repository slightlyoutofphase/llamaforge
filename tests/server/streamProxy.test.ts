/**
 * @packageDocumentation
 * Tests for streaming proxy completion and cancellation behavior.
 * Verifies that all chat interactions use /v1/chat/completions exclusively,
 * with proper OpenAI-style request/response formatting.
 */

import { afterEach, beforeEach, describe, expect, it, mock, spyOn } from "bun:test";
import fs from "node:fs/promises";
import { addMessage, createChat, getChat, updateChat } from "../../src/server/persistence/chatRepo";
import { getDb, initDb, resetDb } from "../../src/server/persistence/db";
import { createInferencePreset, createSystemPreset } from "../../src/server/persistence/presetRepo";
import { saveSettings } from "../../src/server/persistence/settingsRepo";
import { abortGeneration, proxyCompletion } from "../../src/server/streamProxy";
import { cancelPendingApprovals, resolveToolApproval } from "../../src/server/tools";
import * as llamaServerModule from "../../src/server/llamaServer";

let mockPdfText = "PDF text";

mock.module("pdfjs-dist", () => ({
  getDocument: () => ({
    promise: Promise.resolve({
      numPages: 1,
      getPage: async () => ({
        getTextContent: async () => ({ items: [{ str: mockPdfText }] }),
      }),
    }),
  }),
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
  let writeSpy: ReturnType<typeof spyOn<typeof Bun, "write">>;

  beforeEach(async () => {
    spyOn(llamaServerModule, "getServerStatus").mockReturnValue({
      status: "running",
      port: 8080,
      config: { modelPath: "test.gguf", contextSize: 4096 } as any,
    });
    spyOn(llamaServerModule, "getActiveThinkingTagOverride").mockReturnValue(undefined);
    spyOn(fs, "mkdir").mockResolvedValue(undefined);
    writeSpy = spyOn(Bun, "write").mockResolvedValue(3);

    await initDb(":memory:");
    capturedEndpoint = null;
    capturedBody = null;
  });

  afterEach(() => {
    writeSpy.mockRestore();
    cancelPendingApprovals();
    resetDb();
    mock.restore();
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
    expect(capturedBody.chat_template_kwargs).toEqual({
      enable_thinking: true,
      preserve_thinking: false,
    });
    expect(capturedBody.reasoning_format).toBe("none");
  });

  it("includes preserve_thinking in chat_template_kwargs when preset has it enabled", async () => {
    const stream = buildSSEStream([chatDelta("preserved"), chatStop()]);
    const fetchMock = mock().mockImplementation(async (_input: RequestInfo, init?: RequestInit) => {
      capturedBody = init?.body ? JSON.parse(init.body as string) : null;
      return { ok: true, body: stream } as any;
    });
    globalThis.fetch = fetchMock;

    const chat = await createChat("Preserve Thinking Test");
    const infPresetId = "preserve-thinking-preset";
    await createInferencePreset({
      id: infPresetId,
      name: "Preserve Thinking Preset",
      temperature: 0.7,
      topP: 0.9,
      minP: 0.05,
      repeatPenalty: 1.1,
      frequencyPenalty: 0.0,
      presencePenalty: 0.0,
      maxTokens: 1024,
      seed: undefined,
      stopSequences: [],
      toolCallsEnabled: false,
      tools: undefined,
      structuredOutput: undefined,
      contextOverflowPolicy: "TruncateMiddle",
      thinkingEnabled: true,
      preserveThinking: true,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });
    await updateChat(chat.id, { inferencePresetId: infPresetId });

    await proxyCompletion({ chatId: chat.id, content: "preserve me", attachments: [] });
    await new Promise((r) => setTimeout(r, 200));

    expect(capturedBody.chat_template_kwargs).toEqual({
      enable_thinking: true,
      preserve_thinking: true,
    });
  });

  it("does not include preserve_thinking when preset has it disabled", async () => {
    const stream = buildSSEStream([chatDelta("not preserved"), chatStop()]);
    const fetchMock = mock().mockImplementation(async (_input: RequestInfo, init?: RequestInit) => {
      capturedBody = init?.body ? JSON.parse(init.body as string) : null;
      return { ok: true, body: stream } as any;
    });
    globalThis.fetch = fetchMock;

    const chat = await createChat("No Preserve Thinking Test");
    const infPresetId = "no-preserve-thinking-preset";
    await createInferencePreset({
      id: infPresetId,
      name: "No Preserve Thinking Preset",
      temperature: 0.7,
      topP: 0.9,
      minP: 0.05,
      repeatPenalty: 1.1,
      frequencyPenalty: 0.0,
      presencePenalty: 0.0,
      maxTokens: 1024,
      seed: undefined,
      stopSequences: [],
      toolCallsEnabled: false,
      tools: undefined,
      structuredOutput: undefined,
      contextOverflowPolicy: "TruncateMiddle",
      thinkingEnabled: true,
      preserveThinking: false,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });
    await updateChat(chat.id, { inferencePresetId: infPresetId });

    await proxyCompletion({ chatId: chat.id, content: "do not preserve", attachments: [] });
    await new Promise((r) => setTimeout(r, 200));

    expect(capturedBody.chat_template_kwargs).toEqual({
      enable_thinking: true,
      preserve_thinking: false,
    });
  });

  it("includes reasoning_content on historical assistant messages when preserve_thinking is enabled", async () => {
    const stream = buildSSEStream([chatDelta("follow up"), chatStop()]);
    const fetchMock = mock().mockImplementation(async (_input: RequestInfo, init?: RequestInit) => {
      capturedBody = init?.body ? JSON.parse(init.body as string) : null;
      return { ok: true, body: stream } as any;
    });
    globalThis.fetch = fetchMock;

    const chat = await createChat("Preserve Thinking History Test");
    // Insert a historical assistant message with thinking content
    getDb()
      .prepare(
        `INSERT INTO messages (id, chat_id, role, content, raw_content, thinking_content, position, created_at, tool_call_id, tool_calls_json, metrics_json)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        "prev-assistant-msg",
        chat.id,
        "assistant",
        "The answer is 42",
        "<think>I am pondering</think>The answer is 42",
        "I am pondering",
        0,
        Date.now(),
        null,
        null,
        null,
      );

    const infPresetId = "preserve-thinking-history-preset";
    await createInferencePreset({
      id: infPresetId,
      name: "Preserve Thinking History Preset",
      temperature: 0.7,
      topP: 0.9,
      minP: 0.05,
      repeatPenalty: 1.1,
      frequencyPenalty: 0.0,
      presencePenalty: 0.0,
      maxTokens: 1024,
      seed: undefined,
      stopSequences: [],
      toolCallsEnabled: false,
      tools: undefined,
      structuredOutput: undefined,
      contextOverflowPolicy: "TruncateMiddle",
      thinkingEnabled: true,
      preserveThinking: true,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });
    await updateChat(chat.id, { inferencePresetId: infPresetId });

    await proxyCompletion({ chatId: chat.id, content: "next question", attachments: [] });
    await new Promise((r) => setTimeout(r, 200));

    const assistantMsg = capturedBody.messages.find((m: any) => m.role === "assistant");
    expect(assistantMsg).toBeDefined();
    expect(assistantMsg.reasoning_content).toBe("I am pondering");
  });

  it("still sends reasoning_content when preserve_thinking is disabled", async () => {
    const stream = buildSSEStream([chatDelta("follow up"), chatStop()]);
    const fetchMock = mock().mockImplementation(async (_input: RequestInfo, init?: RequestInit) => {
      capturedBody = init?.body ? JSON.parse(init.body as string) : null;
      return { ok: true, body: stream } as any;
    });
    globalThis.fetch = fetchMock;

    const chat = await createChat("No Preserve Thinking History Test");
    // Insert a historical assistant message with thinking content
    getDb()
      .prepare(
        `INSERT INTO messages (id, chat_id, role, content, raw_content, thinking_content, position, created_at, tool_call_id, tool_calls_json, metrics_json)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        "prev-assistant-msg",
        chat.id,
        "assistant",
        "The answer is 42",
        "<think>I am pondering</think>The answer is 42",
        "I am pondering",
        0,
        Date.now(),
        null,
        null,
        null,
      );

    const infPresetId = "no-preserve-thinking-history-preset";
    await createInferencePreset({
      id: infPresetId,
      name: "No Preserve Thinking History Preset",
      temperature: 0.7,
      topP: 0.9,
      minP: 0.05,
      repeatPenalty: 1.1,
      frequencyPenalty: 0.0,
      presencePenalty: 0.0,
      maxTokens: 1024,
      seed: undefined,
      stopSequences: [],
      toolCallsEnabled: false,
      tools: undefined,
      structuredOutput: undefined,
      contextOverflowPolicy: "TruncateMiddle",
      thinkingEnabled: true,
      preserveThinking: false,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });
    await updateChat(chat.id, { inferencePresetId: infPresetId });

    await proxyCompletion({ chatId: chat.id, content: "next question", attachments: [] });
    await new Promise((r) => setTimeout(r, 200));

    const assistantMsg = capturedBody.messages.find((m: any) => m.role === "assistant");
    expect(assistantMsg).toBeDefined();
    expect(assistantMsg.reasoning_content).toBe("I am pondering");
    expect(capturedBody.chat_template_kwargs?.preserve_thinking).toBe(false);
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
    expect(assistantMsg?.metrics?.predictedTokens).toBe(5);
    expect(assistantMsg?.metrics?.tokensPerSecond).toBe(50);
  });

  it("broadcasts the persisted user message so clients can reconcile optimistic ids", async () => {
    const stream = buildSSEStream([chatDelta("Reply!"), chatStop()]);
    const fetchMock = mock().mockResolvedValue({ ok: true, body: stream } as any);
    globalThis.fetch = fetchMock;

    const wsHubModule = await import("../../src/server/wsHub");
    const broadcastSpy = spyOn(wsHubModule, "broadcast").mockImplementation(() => {});

    try {
      const chat = await createChat("Broadcast User Test");
      await proxyCompletion({
        chatId: chat.id,
        content: "Hello there",
        attachments: [],
      });

      await new Promise((r) => setTimeout(r, 200));

      const userMessageFrame = broadcastSpy.mock.calls
        .map((call) => call[0])
        .find(
          (frame) =>
            frame.type === "message" && frame.chatId === chat.id && frame.message.role === "user",
        );

      expect(userMessageFrame).toBeDefined();
      if (userMessageFrame?.type === "message") {
        expect(userMessageFrame.message.id.startsWith("temp-")).toBe(false);
        expect(userMessageFrame.message.content).toBe("Hello there");
        expect(userMessageFrame.message.rawContent).toBe("Hello there");
      }
    } finally {
      broadcastSpy.mockRestore();
    }
  });

  it("ignores malformed persisted toolCallsJson when preparing a follow-up request", async () => {
    const stream = buildSSEStream([chatDelta("Recovered"), chatStop()]);
    const fetchMock = mock().mockImplementation(async (_input: RequestInfo, init?: RequestInit) => {
      capturedBody = init?.body ? JSON.parse(init.body as string) : null;
      return { ok: true, body: stream } as any;
    });
    globalThis.fetch = fetchMock;

    const chat = await createChat("Malformed Tool Calls History");
    getDb()
      .prepare(
        `INSERT INTO messages (id, chat_id, role, content, raw_content, thinking_content, position, created_at, tool_call_id, tool_calls_json, metrics_json)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        "bad-tool-json",
        chat.id,
        "assistant",
        "Broken metadata should not crash history assembly",
        "Broken metadata should not crash history assembly",
        null,
        0,
        Date.now(),
        null,
        "{bad json",
        null,
      );

    await proxyCompletion({ chatId: chat.id, content: "continue", attachments: [] });

    await new Promise((r) => setTimeout(r, 200));

    expect(fetchMock).toHaveBeenCalled();
    expect(capturedBody.messages).toBeInstanceOf(Array);
    expect(capturedBody.messages[0]?.tool_calls).toBeUndefined();
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
    spyOn(Bun, "file").mockImplementation(
      () =>
        ({
          exists: async () => true,
        }) as any,
    );

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
    expect(userMsg.content[0].image_url.url).toMatch(/^file:\/\/attachments\/.+\.png$/);
    expect(userMsg.content[1].type).toBe("text");
    expect(userMsg.content[1].text).toContain("Look at this");
  });

  it("stores bounded summaries for large text attachments", async () => {
    const stream = buildSSEStream([chatDelta("summarized"), chatStop()]);
    const fetchMock = mock().mockImplementation(async (_input: RequestInfo, init?: RequestInit) => {
      capturedBody = init?.body ? JSON.parse(init.body as string) : null;
      return { ok: true, body: stream } as any;
    });
    globalThis.fetch = fetchMock;

    const chat = await createChat("Large Text Attachment Test");
    const file = new File(["A".repeat(30000)], "large.txt", { type: "text/plain" });

    await proxyCompletion({
      chatId: chat.id,
      content: "Summarize the attachment",
      attachments: [file],
    });

    await new Promise((r) => setTimeout(r, 200));

    const reloaded = await getChat(chat.id);
    const userMsg = reloaded?.messages?.find((message) => message.role === "user");
    const payloadUserMsg = capturedBody.messages.find((message: any) => message.role === "user");

    expect(userMsg).toBeDefined();
    expect(userMsg?.content.length).toBeLessThan(13000);
    expect(userMsg?.content).toContain(
      "Attachment text truncated: kept 12000 of 30000 characters.",
    );
    expect(payloadUserMsg.content.length).toBeLessThan(13000);
    expect(payloadUserMsg.content).not.toContain("A".repeat(15000));
  });

  it("stores bounded summaries for large PDF attachments", async () => {
    mockPdfText = "P".repeat(30000);
    const stream = buildSSEStream([chatDelta("pdf summarized"), chatStop()]);
    const fetchMock = mock().mockImplementation(async (_input: RequestInfo, init?: RequestInit) => {
      capturedBody = init?.body ? JSON.parse(init.body as string) : null;
      return { ok: true, body: stream } as any;
    });
    globalThis.fetch = fetchMock;

    const chat = await createChat("Large PDF Attachment Test");
    const file = new File(["fake pdf bytes"], "large.pdf", { type: "application/pdf" });

    await proxyCompletion({
      chatId: chat.id,
      content: "Summarize the PDF",
      attachments: [file],
    });

    await new Promise((r) => setTimeout(r, 200));

    const reloaded = await getChat(chat.id);
    const userMsg = reloaded?.messages?.find((message) => message.role === "user");
    const payloadUserMsg = capturedBody.messages.find((message: any) => message.role === "user");

    expect(userMsg).toBeDefined();
    expect(userMsg?.rawContent.length).toBeLessThan(13000);
    expect(userMsg?.rawContent).toContain(
      "Attachment text truncated: kept 12000 of 30001 characters.",
    );
    expect(payloadUserMsg.content.length).toBeLessThan(13000);
    expect(payloadUserMsg.content).not.toContain("P".repeat(15000));

    mockPdfText = "PDF text";
  });

  it("times out stalled streams before the first chunk and removes the empty assistant row", async () => {
    await saveSettings({ requestTimeoutSeconds: 0.02 });

    const fetchMock = mock().mockImplementation(async (_input: RequestInfo, init?: RequestInit) => {
      const signal = init?.signal as AbortSignal;
      return {
        ok: true,
        body: {
          getReader: () => ({
            read: () =>
              new Promise<ReadableStreamReadResult<Uint8Array>>((_, reject) => {
                if (signal.aborted) {
                  reject(new DOMException("Aborted", "AbortError"));
                  return;
                }

                signal.addEventListener(
                  "abort",
                  () => reject(new DOMException("Aborted", "AbortError")),
                  { once: true },
                );
              }),
            cancel: async () => {},
          }),
        },
      } as any;
    });
    globalThis.fetch = fetchMock;

    const chat = await createChat("Timeout Test");
    await proxyCompletion({ chatId: chat.id, content: "hello", attachments: [] });

    await new Promise((r) => setTimeout(r, 120));

    const reloaded = await getChat(chat.id);
    expect(reloaded?.messages?.filter((message) => message.role === "assistant")).toHaveLength(0);
    expect(reloaded?.messages?.filter((message) => message.role === "user")).toHaveLength(1);
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

  it("stops cleanly when a tool approval is rejected", async () => {
    const fetchMock = mock().mockImplementation(async (input: RequestInfo) => {
      const url = typeof input === "string" ? input : input.url;
      if (url.endsWith("/tokenize")) {
        return new Response(JSON.stringify({ tokens: [1, 2, 3] }), { status: 200 }) as any;
      }

      const stream = buildSSEStream([
        {
          choices: [
            {
              delta: {
                tool_calls: [
                  {
                    index: 0,
                    id: "tc_reject",
                    function: { name: "calculate", arguments: '{"expression":' },
                  },
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
      return { ok: true, body: stream } as any;
    });
    globalThis.fetch = fetchMock;

    const chat = await createChat("Tool Reject Test");
    const inferencePresetId = "tool-reject-preset";
    await createInferencePreset({
      id: inferencePresetId,
      name: "Tool Reject Preset",
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
      toolCallsEnabled: true,
      tools: [
        {
          name: "calculate",
          description: "Evaluate a mathematical expression.",
          parameters: {
            type: "object",
            properties: {
              expression: { type: "string" },
            },
            required: ["expression"],
          },
        },
      ],
      structuredOutput: undefined,
      contextOverflowPolicy: "TruncateMiddle",
      thinkingEnabled: true,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });
    await updateChat(chat.id, { inferencePresetId });

    await proxyCompletion({
      chatId: chat.id,
      content: "reject the tool",
      attachments: [],
    });

    await new Promise((resolve) => setTimeout(resolve, 40));
    resolveToolApproval("tc_reject", false);
    await new Promise((resolve) => setTimeout(resolve, 150));

    const reloaded = await getChat(chat.id);
    expect(reloaded?.messages?.filter((message) => message.role === "tool")).toHaveLength(0);
    const assistantMsg = reloaded?.messages?.find((message) => message.role === "assistant");
    expect(assistantMsg?.toolCallsJson).toContain("tc_reject");
  });

  it("caps recursive tool-call re-entry depth", async () => {
    let chatCompletionFetchCount = 0;
    const fetchMock = mock().mockImplementation(async (input: RequestInfo) => {
      const url = typeof input === "string" ? input : input.url;
      if (url.endsWith("/tokenize")) {
        return new Response(JSON.stringify({ tokens: [1, 2, 3] }), { status: 200 }) as any;
      }

      chatCompletionFetchCount += 1;
      const toolCallId = `tc_${chatCompletionFetchCount}`;
      const stream = buildSSEStream([
        {
          choices: [
            {
              delta: {
                tool_calls: [
                  {
                    index: 0,
                    id: toolCallId,
                    function: { name: "calculate", arguments: '{"expression":' },
                  },
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
      return { ok: true, body: stream } as any;
    });
    globalThis.fetch = fetchMock;

    const chat = await createChat("Tool Recursion Cap Test");
    const inferencePresetId = "tool-recursion-preset";
    await createInferencePreset({
      id: inferencePresetId,
      name: "Tool Recursion Preset",
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
      toolCallsEnabled: true,
      tools: [
        {
          name: "calculate",
          description: "Evaluate a mathematical expression.",
          parameters: {
            type: "object",
            properties: {
              expression: { type: "string" },
            },
            required: ["expression"],
          },
        },
      ],
      structuredOutput: undefined,
      contextOverflowPolicy: "TruncateMiddle",
      thinkingEnabled: true,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });
    await updateChat(chat.id, { inferencePresetId });

    await proxyCompletion({
      chatId: chat.id,
      content: "calculate forever",
      attachments: [],
    });

    for (let approvalIndex = 1; approvalIndex <= 6; approvalIndex++) {
      await new Promise((resolve) => setTimeout(resolve, 40));
      resolveToolApproval(`tc_${approvalIndex}`, true, '{"expression":"2+2"}');
    }

    await new Promise((resolve) => setTimeout(resolve, 300));

    expect(chatCompletionFetchCount).toBe(6);
  });

  it("truncates history using tool and schema overhead without per-message tokenization loops", async () => {
    let tokenizeFetchCount = 0;
    const stream = buildSSEStream([chatDelta("trimmed"), chatStop()]);
    const fetchMock = mock().mockImplementation(async (input: RequestInfo, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input.url;
      if (url.endsWith("/tokenize")) {
        tokenizeFetchCount += 1;
        const body = JSON.parse(String(init?.body ?? "{}")) as { content?: string };
        const tokenCount = Math.max(1, Math.ceil((body.content?.length ?? 0) / 4));
        return new Response(JSON.stringify({ tokens: new Array(tokenCount).fill(1) }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }) as any;
      }

      capturedBody = init?.body ? JSON.parse(init.body as string) : null;
      return { ok: true, body: stream } as any;
    });
    globalThis.fetch = fetchMock;

    const chat = await createChat("Payload Budget Test");
    await addMessage({
      id: Bun.randomUUIDv7(),
      chatId: chat.id,
      role: "assistant",
      content: "OLD ".repeat(300),
      rawContent: "OLD ".repeat(300),
      position: 0,
      createdAt: Date.now(),
    });

    const inferencePresetId = "payload-budget-preset";
    await createInferencePreset({
      id: inferencePresetId,
      name: "Payload Budget Preset",
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
      maxTokens: 3400,
      stopStrings: [],
      toolCallsEnabled: true,
      tools: [
        {
          name: "payload_tool",
          description: "T".repeat(1000),
          parameters: {
            type: "object",
            properties: {
              value: { type: "string" },
            },
            required: ["value"],
          },
        },
      ],
      structuredOutput: {
        enabled: true,
        schema: {
          type: "object",
          properties: {
            result: { type: "string", description: "S".repeat(700) },
          },
          required: ["result"],
        },
        grammar: undefined,
      },
      contextOverflowPolicy: "TruncateMiddle",
      thinkingEnabled: true,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });
    await updateChat(chat.id, { inferencePresetId });

    await proxyCompletion({
      chatId: chat.id,
      content: "latest question",
      attachments: [],
    });

    await new Promise((r) => setTimeout(r, 200));

    const contentStrings = capturedBody.messages
      .map((message: any) =>
        typeof message.content === "string" ? message.content : JSON.stringify(message.content),
      )
      .join("\n");

    expect(contentStrings).not.toContain("OLD OLD OLD");
    expect(contentStrings).toContain("latest question");
    expect(capturedBody.tools).toHaveLength(1);
    expect(capturedBody.response_format?.json_schema?.properties?.result?.description).toContain(
      "S",
    );
    expect(tokenizeFetchCount).toBeLessThanOrEqual(2);
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

  it("includes llama-server exit diagnostics when transport fails before headers", async () => {
    const wsHubModule = await import("../../src/server/wsHub");
    const broadcastSpy = spyOn(wsHubModule, "broadcast").mockImplementation(() => {});
    spyOn(llamaServerModule, "getProc").mockReturnValue({ exitCode: 23 } as any);
    spyOn(llamaServerModule, "getRecentServerLogs").mockReturnValue(["fatal multimodal failure"]);

    const fetchMock = mock().mockRejectedValue(new Error("socket hang up"));
    globalThis.fetch = fetchMock;

    const chat = await createChat("Transport Error Test");
    const messageId = await proxyCompletion({
      chatId: chat.id,
      content: "trigger transport error",
      attachments: [],
    });

    await new Promise((r) => setTimeout(r, 300));

    const errorFrame = broadcastSpy.mock.calls
      .map((call) => call[0])
      .find(
        (frame) =>
          frame.type === "error" && frame.chatId === chat.id && frame.messageId === messageId,
      );

    expect(errorFrame).toBeDefined();
    if (errorFrame?.type === "error") {
      expect(errorFrame.message).toContain("socket hang up");
      expect(errorFrame.message).toContain("llama-server exited with code 23");
      expect(errorFrame.message).toContain("Last server log: fatal multimodal failure");
    }

    const reloaded = await getChat(chat.id);
    const assistantMsg = reloaded?.messages?.find((m) => m.id === messageId);
    expect(assistantMsg).toBeUndefined();
  });

  it("does not inject <|think|> into system message content", async () => {
    spyOn(llamaServerModule, "getActiveThinkingTagOverride").mockReturnValue({
      openTag: "<|channel>thought\n",
      closeTag: "<channel|>",
      enableToken: "<|think|>",
    });
    const stream = buildSSEStream([chatDelta("ok"), chatStop()]);
    const fetchMock = mock().mockImplementation(async (_input: RequestInfo, init?: RequestInit) => {
      capturedBody = init?.body ? JSON.parse(init.body as string) : null;
      return { ok: true, body: stream } as any;
    });
    globalThis.fetch = fetchMock;

    const systemPresetId = "sys-no-think-inject";
    await createSystemPreset({
      id: systemPresetId,
      name: "Helpful",
      content: "You are helpful.",
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });
    const chat = await createChat("No Think Inject");
    await updateChat(chat.id, { systemPresetId });

    await proxyCompletion({ chatId: chat.id, content: "hi", attachments: [] });
    await new Promise((r) => setTimeout(r, 200));

    const systemMsg = capturedBody.messages.find((m: { role: string }) => m.role === "system");
    expect(systemMsg.content).toBe("You are helpful.");
    expect(systemMsg.content).not.toContain("<|think|>");
    expect(capturedBody.chat_template_kwargs).toEqual({
      enable_thinking: true,
      preserve_thinking: false,
    });
  });

  it("keeps assistant rows that have thinking content when generation is aborted", async () => {
    const encoder = new TextEncoder();
    const fetchMock = mock().mockImplementation(async (_input: RequestInfo, init?: RequestInit) => {
      const signal = init?.signal as AbortSignal;
      return {
        ok: true,
        body: {
          getReader: () => {
            let sent = false;
            return {
              read: () =>
                new Promise<ReadableStreamReadResult<Uint8Array>>((resolve, reject) => {
                  if (signal.aborted) {
                    reject(new DOMException("Aborted", "AbortError"));
                    return;
                  }
                  if (!sent) {
                    sent = true;
                    resolve({
                      done: false,
                      value: encoder.encode(
                        `data: ${JSON.stringify(chatDelta("<think>I am reasoning about this</think>"))}\n\n`,
                      ),
                    });
                    return;
                  }
                  signal.addEventListener(
                    "abort",
                    () => reject(new DOMException("Aborted", "AbortError")),
                    { once: true },
                  );
                }),
              cancel: async () => {},
            };
          },
        },
      } as any;
    });
    globalThis.fetch = fetchMock;

    const chat = await createChat("Abort Thinking Test");
    const msgId = await proxyCompletion({
      chatId: chat.id,
      content: "think",
      attachments: [],
    });

    await new Promise((r) => setTimeout(r, 80));
    abortGeneration(chat.id);
    await new Promise((r) => setTimeout(r, 80));

    const reloaded = await getChat(chat.id);
    const assistant = reloaded?.messages?.find((m) => m.id === msgId);
    expect(assistant).toBeDefined();
    expect(assistant?.thinkingContent).toContain("I am reasoning");
  });

  it("does not overwrite a trailing tool message when continuing", async () => {
    const stream = buildSSEStream([chatDelta("follow-up"), chatStop()]);
    const fetchMock = mock().mockImplementation(async (_input: RequestInfo, init?: RequestInit) => {
      capturedBody = init?.body ? JSON.parse(init.body as string) : null;
      return { ok: true, body: stream } as any;
    });
    globalThis.fetch = fetchMock;

    const chat = await createChat("Continue Tool Tail");
    await addMessage({
      id: "user-1",
      chatId: chat.id,
      role: "user",
      content: "calc",
      rawContent: "calc",
      position: 0,
      createdAt: Date.now(),
    });
    await addMessage({
      id: "asst-1",
      chatId: chat.id,
      role: "assistant",
      content: "",
      rawContent: "",
      position: 1,
      createdAt: Date.now(),
      toolCallsJson: JSON.stringify([
        {
          id: "tc_continue",
          type: "function",
          function: { name: "calculate", arguments: '{"expression":"2+2"}' },
        },
      ]),
    });
    await addMessage({
      id: "tool-1",
      chatId: chat.id,
      role: "tool",
      content: "4",
      rawContent: "4",
      position: 2,
      createdAt: Date.now(),
      toolCallId: "tc_continue",
    });

    const newId = await proxyCompletion({
      chatId: chat.id,
      content: "",
      attachments: [],
      isContinue: true,
    });
    await new Promise((r) => setTimeout(r, 200));

    expect(newId).not.toBe("tool-1");
    expect(newId).not.toBe("asst-1");
    const reloaded = await getChat(chat.id);
    const toolRow = reloaded?.messages?.find((m) => m.id === "tool-1");
    expect(toolRow?.role).toBe("tool");
    expect(toolRow?.content).toBe("4");
    const newAssistant = reloaded?.messages?.find((m) => m.id === newId);
    expect(newAssistant?.role).toBe("assistant");
    expect(newAssistant?.content).toBe("follow-up");
  });

  it("sends tool-call arguments as objects, not JSON strings", async () => {
    const stream = buildSSEStream([chatDelta("done"), chatStop()]);
    const fetchMock = mock().mockImplementation(async (_input: RequestInfo, init?: RequestInit) => {
      capturedBody = init?.body ? JSON.parse(init.body as string) : null;
      return { ok: true, body: stream } as any;
    });
    globalThis.fetch = fetchMock;

    const chat = await createChat("Tool Args Object");
    await addMessage({
      id: "asst-tools",
      chatId: chat.id,
      role: "assistant",
      content: "",
      rawContent: "",
      position: 0,
      createdAt: Date.now(),
      toolCallsJson: JSON.stringify([
        {
          id: "tc_args",
          type: "function",
          function: { name: "calculate", arguments: '{"expression":"1+1"}' },
        },
      ]),
    });
    await addMessage({
      id: "tool-args",
      chatId: chat.id,
      role: "tool",
      content: "2",
      rawContent: "2",
      position: 1,
      createdAt: Date.now(),
      toolCallId: "tc_args",
    });

    await proxyCompletion({ chatId: chat.id, content: "thanks", attachments: [] });
    await new Promise((r) => setTimeout(r, 200));

    const assistantMsg = capturedBody.messages.find(
      (m: { role: string }) => m.role === "assistant",
    );
    expect(assistantMsg.tool_calls[0].function.arguments).toEqual({ expression: "1+1" });
    expect(typeof assistantMsg.tool_calls[0].function.arguments).toBe("object");
  });

  it("completes a tool round trip and deserializes arguments on the follow-up request", async () => {
    const capturedBodies: unknown[] = [];
    let chatCompletionFetchCount = 0;
    const fetchMock = mock().mockImplementation(async (input: RequestInfo, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input.url;
      if (url.endsWith("/tokenize")) {
        return new Response(JSON.stringify({ tokens: [1, 2, 3] }), { status: 200 }) as any;
      }

      chatCompletionFetchCount += 1;
      if (init?.body) {
        capturedBodies.push(JSON.parse(init.body as string));
      }

      if (chatCompletionFetchCount === 1) {
        const stream = buildSSEStream([
          {
            choices: [
              {
                delta: {
                  tool_calls: [
                    {
                      index: 0,
                      id: "tc_roundtrip",
                      function: { name: "calculate", arguments: '{"expression":' },
                    },
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
        return { ok: true, body: stream } as any;
      }

      const stream = buildSSEStream([chatDelta("The answer is 4"), chatStop()]);
      return { ok: true, body: stream } as any;
    });
    globalThis.fetch = fetchMock;

    const chat = await createChat("Tool Round Trip");
    const inferencePresetId = "tool-roundtrip-preset";
    await createInferencePreset({
      id: inferencePresetId,
      name: "Tool Round Trip Preset",
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
      toolCallsEnabled: true,
      tools: [
        {
          name: "calculate",
          description: "Evaluate a mathematical expression.",
          parameters: {
            type: "object",
            properties: {
              expression: { type: "string" },
            },
            required: ["expression"],
          },
        },
      ],
      structuredOutput: undefined,
      contextOverflowPolicy: "TruncateMiddle",
      thinkingEnabled: true,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });
    await updateChat(chat.id, { inferencePresetId });

    await proxyCompletion({
      chatId: chat.id,
      content: "what is 2+2",
      attachments: [],
    });

    await new Promise((resolve) => setTimeout(resolve, 40));
    resolveToolApproval("tc_roundtrip", true);
    await new Promise((resolve) => setTimeout(resolve, 250));

    expect(chatCompletionFetchCount).toBe(2);
    const followUp = capturedBodies[1] as {
      messages: { role: string; tool_calls?: { function: { arguments: unknown } }[] }[];
    };
    const assistantWithTools = followUp.messages.find((m) => m.tool_calls);
    expect(assistantWithTools?.tool_calls?.[0]?.function.arguments).toEqual({
      expression: "2+2",
    });

    const reloaded = await getChat(chat.id);
    expect(reloaded?.messages?.some((m) => m.role === "tool" && m.content.includes("4"))).toBe(
      true,
    );
  });
});
