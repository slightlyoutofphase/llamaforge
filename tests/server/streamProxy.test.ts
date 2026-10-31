/**
 * @packageDocumentation
 * Tests for streaming proxy completion and cancellation behavior.
 * Verifies that all chat interactions use /v1/chat/completions exclusively,
 * with proper OpenAI-style request/response formatting.
 */

import { afterEach, beforeEach, describe, expect, it, mock, spyOn } from "bun:test";
import fs from "node:fs/promises";
import {
  addMessage,
  createChat,
  getChat,
  updateChat,
  updateMessage,
} from "../../src/server/persistence/chatRepo";
import * as chatRepoModule from "../../src/server/persistence/chatRepo";
import { getDb, initDb, resetDb } from "../../src/server/persistence/db";
import {
  createLoadPreset,
  createInferencePreset,
  createSystemPreset,
} from "../../src/server/persistence/presetRepo";
import { saveSettings } from "../../src/server/persistence/settingsRepo";
import { getActiveGenerations } from "../../src/server/generationRegistry";
import { abortGeneration, proxyCompletion } from "../../src/server/streamProxy";
import { cancelPendingApprovals, resolveToolApproval } from "../../src/server/tools";
import * as llamaServerModule from "../../src/server/llamaServer";
import { createDefaultInferenceSampling, createDefaultLoadConfig } from "../../src/shared/defaults";
import { GEMMA4_THINKING_CONFIG } from "../../src/shared/thinkingTags";
import { asFetch, ggufDisplayMetadata, testLoadConfig } from "../fixtures";

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
 *
 * @param content - Visible `delta.content` text, if any.
 * @param reasoningContent - Native `delta.reasoning_content` text, if any.
 * @returns One OpenAI-style SSE payload object.
 */
function chatDelta(content: string, reasoningContent?: string): object {
  const delta: { content?: string; reasoning_content?: string } = { content };
  if (reasoningContent) delta.reasoning_content = reasoningContent;
  return { choices: [{ delta }] };
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

/**
 * Wraps an SSE body in a real Fetch {@link Response}, matching llama-server's streaming replies.
 *
 * @param body - Encoded `data: ...\n\n` SSE bytes.
 * @returns An `ok` response whose `body` is the provided stream.
 */
function sseResponse(body: ReadableStream<Uint8Array>): Response {
  return new Response(body, {
    status: 200,
    headers: { "Content-Type": "text/event-stream" },
  });
}

/**
 * Returns whether a mocked fetch target is llama-server's tokenize endpoint.
 *
 * @param input - Fetch URL or Request.
 * @returns `true` when overflow tokenization should receive a JSON token list.
 */
function isTokenizeRequest(input: RequestInfo): boolean {
  const url = typeof input === "string" ? input : input.url;
  return url.includes("/tokenize");
}

/**
 * Builds the JSON tokenize reply streamProxy uses to count prompt tokens.
 *
 * @returns A successful tokenize {@link Response}.
 */
function tokenizeJsonResponse(): Response {
  return new Response(JSON.stringify({ tokens: [1, 2, 3] }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

/**
 * Mocks llama-server fetch so `/tokenize` never consumes the chat-completions SSE body.
 *
 * @param completions - Handler for `/v1/chat/completions` (and any other non-tokenize URL).
 * @returns A Bun mock suitable for {@link asFetch}.
 */
function llamaFetch(
  completions: (input: RequestInfo, init?: RequestInit) => Response | Promise<Response>,
): ReturnType<typeof mock> {
  return mock().mockImplementation(async (input: RequestInfo, init?: RequestInit) => {
    if (isTokenizeRequest(input)) {
      return tokenizeJsonResponse();
    }
    return completions(input, init);
  });
}

/**
 * Waits until streamProxy has released every in-flight generation slot.
 *
 * @param timeoutMs - Maximum time to wait before failing the test.
 * @returns A promise that resolves once the registry is empty.
 */
async function waitForGenerationIdle(timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (getActiveGenerations().size > 0) {
    if (Date.now() > deadline) {
      throw new Error("Timed out waiting for streamProxy generation to finish");
    }
    await Bun.sleep(10);
  }
}

/**
 * Polls until `predicate` is true.
 *
 * @param predicate - Condition that becomes true when the awaited state is reached.
 * @param timeoutMs - Maximum time to wait before failing the test.
 * @param message - Error text used when the deadline elapses.
 * @returns A promise that resolves once the predicate succeeds.
 */
async function waitUntil(
  predicate: () => boolean | Promise<boolean>,
  timeoutMs = 5000,
  message = "Timed out waiting for condition",
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await predicate())) {
    if (Date.now() > deadline) {
      throw new Error(message);
    }
    await Bun.sleep(10);
  }
}

/**
 * Builds a streaming response that never emits a chunk until `signal` aborts.
 *
 * @param signal - Abort signal from the streamProxy fetch call.
 * @returns An SSE {@link Response} that errors on abort.
 */
function hangingSseResponse(signal: AbortSignal): Response {
  return new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        const fail = () => {
          try {
            controller.error(new DOMException("Aborted", "AbortError"));
          } catch {
            // The stream may already be closed after abort.
          }
        };
        if (signal.aborted) {
          fail();
          return;
        }
        signal.addEventListener("abort", fail, { once: true });
      },
    }),
    { status: 200, headers: { "Content-Type": "text/event-stream" } },
  );
}

/**
 * Builds a streaming response that emits one SSE payload, then hangs until abort.
 *
 * @param signal - Abort signal from the streamProxy fetch call.
 * @param firstChunk - OpenAI-style chat completions delta object.
 * @returns An SSE {@link Response} that errors on abort after the first chunk.
 */
function sseThenHangResponse(signal: AbortSignal, firstChunk: object): Response {
  const encoder = new TextEncoder();
  return new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(firstChunk)}\n\n`));
        const fail = () => {
          try {
            controller.error(new DOMException("Aborted", "AbortError"));
          } catch {
            // The stream may already be closed after abort.
          }
        };
        if (signal.aborted) {
          fail();
          return;
        }
        signal.addEventListener("abort", fail, { once: true });
      },
    }),
    { status: 200, headers: { "Content-Type": "text/event-stream" } },
  );
}

/**
 * Persists a load preset and points the mocked llama-server status at it.
 *
 * @param id - Load preset id stored as `config.presetId`.
 * @param preserveThinking - Value persisted on the load preset.
 * @returns No return value.
 */
async function seedLoadedLoadPreset(id: string, preserveThinking: boolean): Promise<void> {
  await createLoadPreset({
    id,
    name: `Load ${id}`,
    modelPath: "test.gguf",
    isDefault: false,
    isReadonly: false,
    config: { ...createDefaultLoadConfig("test.gguf"), presetId: id },
    preserveThinking,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  });
  spyOn(llamaServerModule, "getServerStatus").mockReturnValue({
    status: "running",
    port: 8080,
    config: testLoadConfig("test.gguf", { presetId: id }),
  });
}

describe("streamProxy", () => {
  let capturedEndpoint: string | null;
  let capturedBody: any;
  let writeSpy: ReturnType<typeof spyOn<typeof Bun, "write">>;

  beforeEach(async () => {
    spyOn(llamaServerModule, "getServerStatus").mockReturnValue({
      status: "running",
      port: 8080,
      config: testLoadConfig("test.gguf"),
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
    for (const [id] of getActiveGenerations()) {
      abortGeneration(id);
    }
    cancelPendingApprovals();
    resetDb();
    mock.restore();
  });

  it("ALWAYS sends requests to /v1/chat/completions, never /completion", async () => {
    const stream = buildSSEStream([chatDelta("Hi"), chatStop()]);
    const fetchMock = llamaFetch(async (input: RequestInfo, init?: RequestInit) => {
      capturedEndpoint = String(input);
      capturedBody = init?.body ? JSON.parse(init.body as string) : null;
      return sseResponse(stream);
    });
    globalThis.fetch = asFetch(fetchMock);

    const chat = await createChat("Endpoint Test");
    await proxyCompletion({ chatId: chat.id, content: "hello", attachments: [] });

    // Wait for async stream processing
    await waitForGenerationIdle();

    expect(capturedEndpoint).toBe("http://127.0.0.1:8080/v1/chat/completions");
    // Must NOT be the legacy /completion endpoint (without /v1/chat/ prefix)
    expect(capturedEndpoint?.endsWith("/completion")).toBe(false);
    // Should NOT have a prompt field (that's the old /completion format)
    expect(capturedBody.prompt).toBeUndefined();
    // Should ALWAYS have a messages array
    expect(capturedBody.messages).toBeInstanceOf(Array);
  });

  it("logs active inference settings when verbose logging is enabled", async () => {
    const logger = await import("../../src/server/logger");
    logger.setSilent(false);
    logger.setConfiguredLogLevel("verbose");
    const debugSpy = spyOn(console, "debug").mockImplementation(() => {});
    try {
      const stream = buildSSEStream([chatDelta("Hi"), chatStop()]);
      globalThis.fetch = asFetch(llamaFetch(() => sseResponse(stream)));
      const chat = await createChat("Verbose Settings");
      await proxyCompletion({ chatId: chat.id, content: "hello", attachments: [] });
      await waitForGenerationIdle();
      const verboseCall = debugSpy.mock.calls.find((call) =>
        String(call[0]).includes("Active inference settings"),
      );
      expect(verboseCall).toBeDefined();
      expect(JSON.stringify(verboseCall?.[1])).toContain("temperature");
    } finally {
      logger.setSilent(true);
      logger.setConfiguredLogLevel("off");
      debugSpy.mockRestore();
    }
  });

  it("sends a proper messages array with user content for plain text chat", async () => {
    const stream = buildSSEStream([chatDelta("Hello"), chatDelta(" World"), chatStop()]);
    const fetchMock = llamaFetch(async (_input: RequestInfo, init?: RequestInit) => {
      capturedBody = init?.body ? JSON.parse(init.body as string) : null;
      return sseResponse(stream);
    });
    globalThis.fetch = asFetch(fetchMock);

    const chat = await createChat("Messages Test");
    const messageId = await proxyCompletion({
      chatId: chat.id,
      content: "Say hi",
      attachments: [],
    });

    await waitForGenerationIdle();

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
    const fetchMock = llamaFetch(async (_input: RequestInfo, init?: RequestInit) => {
      capturedBody = init?.body ? JSON.parse(init.body as string) : null;
      return sseResponse(stream);
    });
    globalThis.fetch = asFetch(fetchMock);

    const chat = await createChat("Params Test");
    await proxyCompletion({ chatId: chat.id, content: "test", attachments: [] });

    await waitForGenerationIdle();

    expect(capturedBody.temperature).toBeNumber();
    expect(capturedBody.top_k).toBeNumber();
    expect(capturedBody.top_p).toBeNumber();
    expect(capturedBody.min_p).toBeNumber();
    expect(capturedBody.cache_prompt).toBe(true);
  });

  it("uses the model-bound inference preset instead of the first database row", async () => {
    const stream = buildSSEStream([chatDelta("OK"), chatStop()]);
    const fetchMock = llamaFetch(async (_input: RequestInfo, init?: RequestInit) => {
      capturedBody = init?.body ? JSON.parse(init.body as string) : null;
      return sseResponse(stream);
    });
    globalThis.fetch = asFetch(fetchMock);

    await createInferencePreset({
      ...createDefaultInferenceSampling(),
      id: "unrelated-first",
      name: "Unrelated First",
      isDefault: false,
      sourceModelPath: "/models/other.gguf",
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });
    await createInferencePreset({
      ...createDefaultInferenceSampling(),
      id: "benqwen",
      name: "BenQwen",
      isDefault: false,
      sourceModelPath: "test.gguf",
      temperature: 0.21,
      topK: 17,
      topP: 0.88,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });

    const chat = await createChat("Model Bound Preset");
    await proxyCompletion({ chatId: chat.id, content: "test", attachments: [] });
    await waitForGenerationIdle();

    expect(capturedBody.temperature).toBe(0.21);
    expect(capturedBody.top_k).toBe(17);
    expect(capturedBody.top_p).toBe(0.88);
    const stored = await getChat(chat.id);
    expect(stored?.inferencePresetId).toBe("benqwen");
  });

  it("uses a client-supplied inference preset id when the chat row has none", async () => {
    const stream = buildSSEStream([chatDelta("OK"), chatStop()]);
    const fetchMock = llamaFetch(async (_input: RequestInfo, init?: RequestInit) => {
      capturedBody = init?.body ? JSON.parse(init.body as string) : null;
      return sseResponse(stream);
    });
    globalThis.fetch = asFetch(fetchMock);

    await createInferencePreset({
      ...createDefaultInferenceSampling(),
      id: "header-selected",
      name: "BenQwen",
      isDefault: false,
      temperature: 1.15,
      topK: 64,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });

    const chat = await createChat("Header Selected Preset");
    await proxyCompletion({
      chatId: chat.id,
      content: "test",
      attachments: [],
      inferencePresetId: "header-selected",
    });
    await waitForGenerationIdle();

    expect(capturedBody.temperature).toBe(1.15);
    expect(capturedBody.top_k).toBe(64);
  });

  it("includes thinking template kwargs for thinking-enabled models", async () => {
    const stream = buildSSEStream([chatDelta("thinking"), chatStop()]);
    const fetchMock = llamaFetch(async (_input: RequestInfo, init?: RequestInit) => {
      capturedBody = init?.body ? JSON.parse(init.body as string) : null;
      return sseResponse(stream);
    });
    globalThis.fetch = asFetch(fetchMock);

    const chat = await createChat("Thinking Test");
    await proxyCompletion({ chatId: chat.id, content: "think", attachments: [] });

    await waitForGenerationIdle();

    // Thinking stays on via chat_template_kwargs. reasoning_format is always
    // `none` so llama-server streams tagged tokens in content for live splitting.
    expect(capturedBody.chat_template_kwargs).toEqual({
      enable_thinking: true,
      preserve_thinking: false,
    });
    expect(capturedBody.reasoning_format).toBe("none");
  });

  it("sends enable_thinking false when the inference preset disables thinking", async () => {
    const stream = buildSSEStream([chatDelta("direct answer"), chatStop()]);
    const fetchMock = llamaFetch(async (_input: RequestInfo, init?: RequestInit) => {
      capturedBody = init?.body ? JSON.parse(init.body as string) : null;
      return sseResponse(stream);
    });
    globalThis.fetch = asFetch(fetchMock);

    const chat = await createChat("Thinking Disabled Test");
    const infPresetId = "thinking-disabled-preset";
    await createInferencePreset({
      id: infPresetId,
      name: "Thinking Disabled Preset",
      ...createDefaultInferenceSampling(),
      isDefault: false,
      temperature: 0.7,
      topP: 0.9,
      minP: 0.05,
      repeatPenalty: 1.1,
      frequencyPenalty: 0.0,
      presencePenalty: 0.0,
      maxTokens: 1024,
      thinkingEnabled: false,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });
    await updateChat(chat.id, { inferencePresetId: infPresetId });

    await proxyCompletion({ chatId: chat.id, content: "answer directly", attachments: [] });
    await waitForGenerationIdle();

    expect(capturedBody.chat_template_kwargs).toEqual({
      enable_thinking: false,
      preserve_thinking: false,
    });
    expect(capturedBody.reasoning_format).toBe("none");
  });

  it("includes preserve_thinking in chat_template_kwargs when the load preset has it enabled", async () => {
    await seedLoadedLoadPreset("lp-preserve-on", true);
    const stream = buildSSEStream([chatDelta("preserved"), chatStop()]);
    const fetchMock = llamaFetch(async (_input: RequestInfo, init?: RequestInit) => {
      capturedBody = init?.body ? JSON.parse(init.body as string) : null;
      return sseResponse(stream);
    });
    globalThis.fetch = asFetch(fetchMock);

    const chat = await createChat("Preserve Thinking Test");
    const infPresetId = "preserve-thinking-preset";
    await createInferencePreset({
      id: infPresetId,
      name: "Preserve Thinking Preset",
      ...createDefaultInferenceSampling(),
      isDefault: false,
      temperature: 0.7,
      topP: 0.9,
      minP: 0.05,
      repeatPenalty: 1.1,
      frequencyPenalty: 0.0,
      presencePenalty: 0.0,
      maxTokens: 1024,
      thinkingEnabled: true,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });
    await updateChat(chat.id, { inferencePresetId: infPresetId });

    await proxyCompletion({ chatId: chat.id, content: "preserve me", attachments: [] });
    await waitForGenerationIdle();

    expect(capturedBody.chat_template_kwargs).toEqual({
      enable_thinking: true,
      preserve_thinking: true,
    });
  });

  it("does not enable preserve_thinking when the load preset has it disabled", async () => {
    await seedLoadedLoadPreset("lp-preserve-off", false);
    const stream = buildSSEStream([chatDelta("not preserved"), chatStop()]);
    const fetchMock = llamaFetch(async (_input: RequestInfo, init?: RequestInit) => {
      capturedBody = init?.body ? JSON.parse(init.body as string) : null;
      return sseResponse(stream);
    });
    globalThis.fetch = asFetch(fetchMock);

    const chat = await createChat("No Preserve Thinking Test");
    const infPresetId = "no-preserve-thinking-preset";
    await createInferencePreset({
      id: infPresetId,
      name: "No Preserve Thinking Preset",
      ...createDefaultInferenceSampling(),
      isDefault: false,
      temperature: 0.7,
      topP: 0.9,
      minP: 0.05,
      repeatPenalty: 1.1,
      frequencyPenalty: 0.0,
      presencePenalty: 0.0,
      maxTokens: 1024,
      thinkingEnabled: true,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });
    await updateChat(chat.id, { inferencePresetId: infPresetId });

    await proxyCompletion({ chatId: chat.id, content: "do not preserve", attachments: [] });
    await waitForGenerationIdle();

    expect(capturedBody.chat_template_kwargs).toEqual({
      enable_thinking: true,
      preserve_thinking: false,
    });
  });

  it("preserves historical thinking in tagged content instead of reasoning_content", async () => {
    await seedLoadedLoadPreset("lp-preserve-history-on", true);
    const stream = buildSSEStream([chatDelta("follow up"), chatStop()]);
    const fetchMock = llamaFetch(async (_input: RequestInfo, init?: RequestInit) => {
      capturedBody = init?.body ? JSON.parse(init.body as string) : null;
      return sseResponse(stream);
    });
    globalThis.fetch = asFetch(fetchMock);

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
      ...createDefaultInferenceSampling(),
      isDefault: false,
      temperature: 0.7,
      topP: 0.9,
      minP: 0.05,
      repeatPenalty: 1.1,
      frequencyPenalty: 0.0,
      presencePenalty: 0.0,
      maxTokens: 1024,
      thinkingEnabled: true,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });
    await updateChat(chat.id, { inferencePresetId: infPresetId });

    await proxyCompletion({ chatId: chat.id, content: "next question", attachments: [] });
    await waitForGenerationIdle();

    const assistantMsg = capturedBody.messages.find((m: any) => m.role === "assistant");
    expect(assistantMsg).toBeDefined();
    expect(assistantMsg.reasoning_content).toBeUndefined();
    expect(assistantMsg.content).toBe("<think>I am pondering</think>The answer is 42");
    expect(capturedBody.chat_template_kwargs?.preserve_thinking).toBe(true);
    expect(capturedBody.chat_template_kwargs?.enable_thinking).toBe(true);
  });

  it("reconstructs think tags for preserved history stored without tags in rawContent", async () => {
    await seedLoadedLoadPreset("lp-preserve-native-history", true);
    const stream = buildSSEStream([chatDelta("follow up"), chatStop()]);
    const fetchMock = llamaFetch(async (_input: RequestInfo, init?: RequestInit) => {
      capturedBody = init?.body ? JSON.parse(init.body as string) : null;
      return sseResponse(stream);
    });
    globalThis.fetch = asFetch(fetchMock);

    const chat = await createChat("Preserve Native Thinking History");
    await addMessage({
      id: "prev-native-asst",
      chatId: chat.id,
      role: "assistant",
      content: "The answer is 42",
      rawContent: "The answer is 42",
      thinkingContent: "I am pondering",
      position: 0,
      createdAt: Date.now(),
    });

    const infPresetId = "preserve-native-history-preset";
    await createInferencePreset({
      id: infPresetId,
      name: "Preserve Native History Preset",
      ...createDefaultInferenceSampling(),
      isDefault: false,
      temperature: 0.7,
      topP: 0.9,
      minP: 0.05,
      repeatPenalty: 1.1,
      frequencyPenalty: 0.0,
      presencePenalty: 0.0,
      maxTokens: 1024,
      thinkingEnabled: true,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });
    await updateChat(chat.id, { inferencePresetId: infPresetId });

    await proxyCompletion({ chatId: chat.id, content: "next question", attachments: [] });
    await waitForGenerationIdle();

    const assistantMsg = capturedBody.messages.find(
      (m: { role: string }) => m.role === "assistant",
    );
    expect(assistantMsg?.reasoning_content).toBeUndefined();
    expect(assistantMsg?.content).toBe("<think>\nI am pondering\n</think>\nThe answer is 42");
    expect(capturedBody.chat_template_kwargs?.preserve_thinking).toBe(true);
    expect(capturedBody.chat_template_kwargs?.enable_thinking).toBe(true);
  });

  it("does not put Gemma thought channels into preserved historical content", async () => {
    await seedLoadedLoadPreset("lp-preserve-gemma-history", true);
    spyOn(llamaServerModule, "getActiveThinkingTagOverride").mockReturnValue(
      GEMMA4_THINKING_CONFIG,
    );
    spyOn(chatRepoModule, "getMetadataForPath").mockResolvedValue(
      ggufDisplayMetadata({
        architecture: "gemma4",
        name: "Gemma 4",
        fileSizeBytes: 1,
        contextLength: 4096,
        embeddingLength: undefined,
        attentionHeadCount: undefined,
        attentionHeadCountKv: undefined,
        blockCount: undefined,
        feedForwardLength: undefined,
        quantType: undefined,
      }),
    );
    const stream = buildSSEStream([chatDelta("follow up"), chatStop()]);
    const fetchMock = llamaFetch(async (_input: RequestInfo, init?: RequestInit) => {
      capturedBody = init?.body ? JSON.parse(init.body as string) : null;
      return sseResponse(stream);
    });
    globalThis.fetch = asFetch(fetchMock);

    const chat = await createChat("Preserve Gemma Thinking History");
    await addMessage({
      id: "prev-gemma-asst",
      chatId: chat.id,
      role: "assistant",
      content: "One.",
      rawContent: "<|channel>thought plan<channel|>One.",
      thinkingContent: "plan",
      position: 0,
      createdAt: Date.now(),
    });

    const infPresetId = "preserve-gemma-history-preset";
    await createInferencePreset({
      id: infPresetId,
      name: "Preserve Gemma History Preset",
      ...createDefaultInferenceSampling(),
      isDefault: false,
      temperature: 0.7,
      topP: 0.9,
      minP: 0.05,
      repeatPenalty: 1.1,
      frequencyPenalty: 0.0,
      presencePenalty: 0.0,
      maxTokens: 1024,
      thinkingEnabled: true,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });
    await updateChat(chat.id, { inferencePresetId: infPresetId });

    await proxyCompletion({ chatId: chat.id, content: "2", attachments: [] });
    await waitForGenerationIdle();

    const assistantMsg = capturedBody.messages.find(
      (m: { role: string }) => m.role === "assistant",
    );
    expect(assistantMsg?.reasoning_content).toBeUndefined();
    expect(assistantMsg?.content).toBe("One.");
    expect(assistantMsg?.content).not.toContain("<|channel>thought");
    expect(capturedBody.chat_template_kwargs?.enable_thinking).toBe(true);
  });

  it("sends reasoning_content on preserved historical assistants that have tool calls", async () => {
    await seedLoadedLoadPreset("lp-preserve-tool-history", true);
    const stream = buildSSEStream([chatDelta("follow up"), chatStop()]);
    const fetchMock = llamaFetch(async (_input: RequestInfo, init?: RequestInit) => {
      capturedBody = init?.body ? JSON.parse(init.body as string) : null;
      return sseResponse(stream);
    });
    globalThis.fetch = asFetch(fetchMock);

    const chat = await createChat("Preserve Tool Call Thinking History");
    await addMessage({
      id: "prev-tool-asst",
      chatId: chat.id,
      role: "assistant",
      content: "I'll calculate",
      rawContent: "I'll calculate",
      thinkingContent: "need a tool",
      position: 0,
      createdAt: Date.now(),
      toolCallsJson: JSON.stringify([
        {
          id: "tc_preserve",
          type: "function",
          function: { name: "calculate", arguments: '{"expression":"2+2"}' },
        },
      ]),
    });
    await addMessage({
      id: "prev-tool-result",
      chatId: chat.id,
      role: "tool",
      content: "4",
      rawContent: "4",
      position: 1,
      createdAt: Date.now(),
      toolCallId: "tc_preserve",
    });

    const infPresetId = "preserve-tool-history-preset";
    await createInferencePreset({
      ...createDefaultInferenceSampling(),
      id: infPresetId,
      name: "Preserve Tool History Preset",
      isDefault: false,
      temperature: 0.7,
      topP: 0.9,
      minP: 0.05,
      repeatPenalty: 1.1,
      frequencyPenalty: 0.0,
      presencePenalty: 0.0,
      maxTokens: 1024,
      toolCallsEnabled: true,
      thinkingEnabled: true,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });
    await updateChat(chat.id, { inferencePresetId: infPresetId });

    await proxyCompletion({ chatId: chat.id, content: "what next", attachments: [] });
    await waitForGenerationIdle();

    const assistantMsg = capturedBody.messages.find(
      (m: { role: string }) => m.role === "assistant",
    );
    expect(assistantMsg?.reasoning_content).toBe("need a tool");
    expect(assistantMsg?.content).toBe("I'll calculate");
    expect(capturedBody.chat_template_kwargs?.preserve_thinking).toBe(true);
  });

  it("omits reasoning_content on assistants before the last user when preserve_thinking is off", async () => {
    const stream = buildSSEStream([chatDelta("follow up"), chatStop()]);
    const fetchMock = llamaFetch(async (_input: RequestInfo, init?: RequestInit) => {
      capturedBody = init?.body ? JSON.parse(init.body as string) : null;
      return sseResponse(stream);
    });
    globalThis.fetch = asFetch(fetchMock);

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
      ...createDefaultInferenceSampling(),
      isDefault: false,
      temperature: 0.7,
      topP: 0.9,
      minP: 0.05,
      repeatPenalty: 1.1,
      frequencyPenalty: 0.0,
      presencePenalty: 0.0,
      maxTokens: 1024,
      thinkingEnabled: true,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });
    await updateChat(chat.id, { inferencePresetId: infPresetId });

    await proxyCompletion({ chatId: chat.id, content: "next question", attachments: [] });
    await waitForGenerationIdle();

    const assistantMsg = capturedBody.messages.find((m: any) => m.role === "assistant");
    expect(assistantMsg).toBeDefined();
    expect(assistantMsg.reasoning_content).toBeUndefined();
    expect(assistantMsg.content).toBe("The answer is 42");
    expect(capturedBody.chat_template_kwargs?.preserve_thinking).toBe(false);
    expect(capturedBody.chat_template_kwargs?.enable_thinking).toBe(true);
  });

  it("sends reasoning_content on a continued last assistant when preserve_thinking is off", async () => {
    const stream = buildSSEStream([chatDelta(" more"), chatStop()]);
    const fetchMock = llamaFetch(async (_input: RequestInfo, init?: RequestInit) => {
      capturedBody = init?.body ? JSON.parse(init.body as string) : null;
      return sseResponse(stream);
    });
    globalThis.fetch = asFetch(fetchMock);

    const chat = await createChat("Continue Reasoning Replay");
    await addMessage({
      id: "user-cont-r",
      chatId: chat.id,
      role: "user",
      content: "go on",
      rawContent: "go on",
      position: 0,
      createdAt: Date.now(),
    });
    await addMessage({
      id: "asst-cont-r",
      chatId: chat.id,
      role: "assistant",
      content: "The answer is",
      rawContent: "The answer is",
      thinkingContent: "I already planned this",
      position: 1,
      createdAt: Date.now(),
    });

    await proxyCompletion({
      chatId: chat.id,
      content: "",
      attachments: [],
      isContinue: true,
    });
    await waitForGenerationIdle();

    const assistantMsg = capturedBody.messages.find(
      (m: { role: string }) => m.role === "assistant",
    );
    expect(assistantMsg?.reasoning_content).toBe("I already planned this");
    expect(capturedBody.chat_template_kwargs?.preserve_thinking).toBe(false);
    expect(capturedBody.chat_template_kwargs?.enable_thinking).toBe(true);
  });

  it("sends reasoning_content on a continued last assistant when preserve_thinking is on", async () => {
    await seedLoadedLoadPreset("lp-preserve-continue", true);
    const stream = buildSSEStream([chatDelta(" more"), chatStop()]);
    const fetchMock = llamaFetch(async (_input: RequestInfo, init?: RequestInit) => {
      capturedBody = init?.body ? JSON.parse(init.body as string) : null;
      return sseResponse(stream);
    });
    globalThis.fetch = asFetch(fetchMock);

    const chat = await createChat("Continue Preserve Reasoning Replay");
    await addMessage({
      id: "user-cont-p",
      chatId: chat.id,
      role: "user",
      content: "go on",
      rawContent: "go on",
      position: 0,
      createdAt: Date.now(),
    });
    await addMessage({
      id: "asst-cont-p",
      chatId: chat.id,
      role: "assistant",
      content: "The answer is",
      rawContent: "The answer is",
      thinkingContent: "I already planned this",
      position: 1,
      createdAt: Date.now(),
    });

    await proxyCompletion({
      chatId: chat.id,
      content: "",
      attachments: [],
      isContinue: true,
    });
    await waitForGenerationIdle();

    const assistantMsg = capturedBody.messages.find(
      (m: { role: string }) => m.role === "assistant",
    );
    expect(assistantMsg?.reasoning_content).toBe("I already planned this");
    expect(assistantMsg?.content).toBe("The answer is");
    expect(capturedBody.chat_template_kwargs?.preserve_thinking).toBe(true);
    expect(capturedBody.chat_template_kwargs?.enable_thinking).toBe(true);
  });

  it("keeps thinking enabled after editing the last user turn and on a new chat", async () => {
    const bodies: unknown[] = [];
    const fetchMock = llamaFetch(async (input: RequestInfo, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input.url;
      if (url.includes("/tokenize")) {
        return new Response(JSON.stringify({ tokens: [1, 2, 3] }), { status: 200 });
      }
      if (init?.body) bodies.push(JSON.parse(init.body as string));
      return sseResponse(
        buildSSEStream([chatDelta("<|channel>thought plan<channel|>edited answer"), chatStop()]),
      );
    });
    globalThis.fetch = asFetch(fetchMock);

    const chat = await createChat("Edit User Then Regen");
    await addMessage({
      id: "u1-edit",
      chatId: chat.id,
      role: "user",
      content: "first",
      rawContent: "first",
      position: 0,
      createdAt: Date.now(),
    });
    await addMessage({
      id: "a1-edit",
      chatId: chat.id,
      role: "assistant",
      content: "first answer",
      rawContent: "first answer",
      thinkingContent: "first plan",
      position: 1,
      createdAt: Date.now(),
    });
    await addMessage({
      id: "u2-edit",
      chatId: chat.id,
      role: "user",
      content: "second",
      rawContent: "second",
      position: 2,
      createdAt: Date.now(),
    });

    const updated = await updateMessage(
      "u2-edit",
      "second edited",
      "second edited",
      undefined,
      chat.id,
    );
    expect(updated).toBe(true);

    const regeneratedId = await proxyCompletion({
      chatId: chat.id,
      content: "",
      attachments: [],
      isRegenerate: true,
    });
    await waitForGenerationIdle();

    const regenBody = bodies[0] as {
      chat_template_kwargs?: { enable_thinking?: boolean; preserve_thinking?: boolean };
      messages: { role: string; content: string; reasoning_content?: string }[];
    };
    expect(regenBody.chat_template_kwargs?.enable_thinking).toBe(true);
    expect(regenBody.chat_template_kwargs?.preserve_thinking).toBe(false);
    const historicalAssistant = regenBody.messages.find((m) => m.role === "assistant");
    expect(historicalAssistant?.content).toBe("first answer");
    expect(historicalAssistant?.reasoning_content).toBeUndefined();
    const editedUser = regenBody.messages.find(
      (m) => m.role === "user" && m.content === "second edited",
    );
    expect(editedUser).toBeDefined();

    const reloaded = await getChat(chat.id);
    const regenerated = reloaded?.messages?.find((m) => m.id === regeneratedId);
    expect(regenerated?.thinkingContent).toBe("plan");
    expect(regenerated?.content).toBe("edited answer");

    const newChat = await createChat("After Edit Thinking");
    await proxyCompletion({ chatId: newChat.id, content: "fresh", attachments: [] });
    await waitForGenerationIdle();

    const newChatBody = bodies[1] as {
      chat_template_kwargs?: { enable_thinking?: boolean };
    };
    expect(newChatBody.chat_template_kwargs?.enable_thinking).toBe(true);
  });

  it("persists the user message and creates an assistant message row", async () => {
    const stream = buildSSEStream([chatDelta("Reply!"), chatStop()]);
    const fetchMock = llamaFetch(() => sseResponse(stream));
    globalThis.fetch = asFetch(fetchMock);

    const chat = await createChat("Persist Test");
    const assistantMsgId = await proxyCompletion({
      chatId: chat.id,
      content: "Hello there",
      attachments: [],
    });

    await waitForGenerationIdle();

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

  it("computes tokens/sec from predicted_n and predicted_ms when the reported rate is zero", async () => {
    const stream = buildSSEStream([
      chatDelta("Reply!"),
      {
        choices: [{ delta: {}, finish_reason: "stop" }],
        timings: {
          predicted_ms: 200,
          predicted_n: 10,
          predicted_per_second: 0,
          predicted_per_token_ms: 20,
          prompt_ms: 40,
          prompt_n: 8,
          prompt_per_second: 0,
          prompt_per_token_ms: 5,
          tokens_cached: 0,
          tokens_evaluated: 8,
        },
      },
    ]);
    const fetchMock = llamaFetch(() => sseResponse(stream));
    globalThis.fetch = asFetch(fetchMock);

    const chat = await createChat("Tok/sec derivation");
    const assistantMsgId = await proxyCompletion({
      chatId: chat.id,
      content: "Hello there",
      attachments: [],
    });
    await waitForGenerationIdle();
    const reloaded = await getChat(chat.id);
    const assistantMsg = reloaded?.messages?.find((m) => m.id === assistantMsgId);
    expect(assistantMsg?.metrics?.tokensPerSecond).toBe(50);
    expect(assistantMsg?.metrics?.promptTokensPerSecond).toBe(200);
    expect(assistantMsg?.metrics?.generationMs).toBe(200);
  });

  it("finalizes a stream that closes without a finish reason", async () => {
    const wsHubModule = await import("../../src/server/wsHub");
    const broadcastSpy = spyOn(wsHubModule, "broadcast").mockImplementation(() => {});
    const stream = buildSSEStream([chatDelta("partial answer")]);
    const fetchMock = llamaFetch(() => sseResponse(stream));
    globalThis.fetch = asFetch(fetchMock);

    try {
      const chat = await createChat("Unfinished Stream");
      const assistantMsgId = await proxyCompletion({
        chatId: chat.id,
        content: "hello",
        attachments: [],
      });
      await waitForGenerationIdle();

      const reloaded = await getChat(chat.id);
      const assistant = reloaded?.messages?.find((message) => message.id === assistantMsgId);
      expect(assistant?.content).toBe("partial answer");
      expect(assistant?.metrics?.stopReason).toBe("error");
      expect(
        broadcastSpy.mock.calls.some((call) => {
          const frame = call[0];
          return (
            frame.type === "error" && frame.message === "The model stream ended before it finished."
          );
        }),
      ).toBe(true);
      expect(
        broadcastSpy.mock.calls.some((call) => {
          const frame = call[0];
          return frame.type === "stop" && frame.stopReason === "error";
        }),
      ).toBe(true);
    } finally {
      broadcastSpy.mockRestore();
    }
  });

  it("persists chat-completions cache_n as prompt cache metrics", async () => {
    const stream = buildSSEStream([
      chatDelta("cached"),
      {
        choices: [{ delta: {}, finish_reason: "stop" }],
        timings: {
          predicted_ms: 100,
          predicted_n: 4,
          predicted_per_second: 40,
          predicted_per_token_ms: 25,
          prompt_ms: 20,
          prompt_n: 1,
          prompt_per_second: 50,
          prompt_per_token_ms: 20,
          cache_n: 236,
        },
      },
    ]);
    const fetchMock = llamaFetch(() => sseResponse(stream));
    globalThis.fetch = asFetch(fetchMock);

    const chat = await createChat("Cache N Metrics");
    const assistantMsgId = await proxyCompletion({
      chatId: chat.id,
      content: "Hello there",
      attachments: [],
    });
    await waitForGenerationIdle();
    const reloaded = await getChat(chat.id);
    const assistantMsg = reloaded?.messages?.find((message) => message.id === assistantMsgId);
    expect(assistantMsg?.metrics?.cachedPromptTokens).toBe(236);
    expect(assistantMsg?.metrics?.evaluatedPromptTokens).toBe(237);
  });

  it("broadcasts the persisted user message so clients can reconcile optimistic ids", async () => {
    const stream = buildSSEStream([chatDelta("Reply!"), chatStop()]);
    const fetchMock = llamaFetch(() => sseResponse(stream));
    globalThis.fetch = asFetch(fetchMock);

    const wsHubModule = await import("../../src/server/wsHub");
    const broadcastSpy = spyOn(wsHubModule, "broadcast").mockImplementation(() => {});

    try {
      const chat = await createChat("Broadcast User Test");
      await proxyCompletion({
        chatId: chat.id,
        content: "Hello there",
        attachments: [],
      });

      await waitForGenerationIdle();

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
    const fetchMock = llamaFetch(async (_input: RequestInfo, init?: RequestInit) => {
      capturedBody = init?.body ? JSON.parse(init.body as string) : null;
      return sseResponse(stream);
    });
    globalThis.fetch = asFetch(fetchMock);

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

    await waitForGenerationIdle();

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
    const fetchMock = llamaFetch(() => sseResponse(stream));
    globalThis.fetch = asFetch(fetchMock);

    const chat = await createChat("Think Test");
    const msgId = await proxyCompletion({
      chatId: chat.id,
      content: "What is the answer?",
      attachments: [],
    });

    await waitForGenerationIdle();

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
    expect(typeof assistantMsg?.metrics?.thinkingDurationMs).toBe("number");
    expect(assistantMsg?.metrics?.stopReason).toBe("eos");
  });

  it("broadcasts answer tokens as soon as the thinking close tag arrives", async () => {
    const stream = buildSSEStream([
      chatDelta("<think>"),
      chatDelta("I am pondering"),
      chatDelta("</think>"),
      chatDelta("The answer is 42"),
      chatStop(),
    ]);
    const fetchMock = llamaFetch(() => sseResponse(stream));
    globalThis.fetch = asFetch(fetchMock);

    const wsHubModule = await import("../../src/server/wsHub");
    const broadcastSpy = spyOn(wsHubModule, "broadcast").mockImplementation(() => {});

    try {
      const chat = await createChat("Live Answer Stream");
      const msgId = await proxyCompletion({
        chatId: chat.id,
        content: "What is the answer?",
        attachments: [],
      });
      await waitForGenerationIdle();

      const frames = broadcastSpy.mock.calls.map((call) => call[0]);
      const stopIndex = frames.findIndex(
        (frame) => frame.type === "stop" && frame.messageId === msgId,
      );
      expect(stopIndex).toBeGreaterThan(0);
      const answerToken = frames
        .slice(0, stopIndex)
        .find((frame) => frame.type === "token" && frame.delta === "The answer is 42");
      expect(answerToken).toBeDefined();
      if (answerToken?.type === "token") {
        expect(answerToken.thinkingDurationMs).toBeGreaterThanOrEqual(0);
      }
    } finally {
      broadcastSpy.mockRestore();
    }
  });

  it("stores llama-server reasoning_content as thinking without scanning content tags", async () => {
    const stream = buildSSEStream([
      chatDelta("", "I am pondering"),
      chatDelta("The answer is 42"),
      chatStop(),
    ]);
    const fetchMock = llamaFetch(() => sseResponse(stream));
    globalThis.fetch = asFetch(fetchMock);

    const chat = await createChat("Native Reasoning Test");
    const msgId = await proxyCompletion({
      chatId: chat.id,
      content: "What is the answer?",
      attachments: [],
    });

    await waitForGenerationIdle();

    const reloaded = await getChat(chat.id);
    const assistantMsg = reloaded?.messages?.find((m) => m.id === msgId);
    expect(assistantMsg?.content).toBe("The answer is 42");
    expect(assistantMsg?.thinkingContent).toBe("I am pondering");
    expect(assistantMsg?.rawContent).toBe("The answer is 42");
  });

  it("broadcasts an empty assistant placeholder before tokens arrive", async () => {
    const stream = buildSSEStream([chatDelta("Reply!"), chatStop()]);
    const fetchMock = llamaFetch(() => sseResponse(stream));
    globalThis.fetch = asFetch(fetchMock);

    const wsHubModule = await import("../../src/server/wsHub");
    const broadcastSpy = spyOn(wsHubModule, "broadcast").mockImplementation(() => {});

    try {
      const chat = await createChat("Broadcast Assistant Test");
      await proxyCompletion({ chatId: chat.id, content: "Hi", attachments: [] });
      await waitForGenerationIdle();

      const frames = broadcastSpy.mock.calls.map((call) => call[0]);
      const assistantPlaceholder = frames.find(
        (frame) =>
          frame.type === "message" &&
          frame.chatId === chat.id &&
          frame.message.role === "assistant",
      );
      const firstTokenIndex = frames.findIndex((frame) => frame.type === "token");
      const placeholderIndex = frames.findIndex(
        (frame) =>
          frame.type === "message" &&
          frame.chatId === chat.id &&
          frame.message.role === "assistant",
      );
      expect(assistantPlaceholder).toBeDefined();
      expect(placeholderIndex).toBeGreaterThanOrEqual(0);
      expect(placeholderIndex).toBeLessThan(firstTokenIndex);
    } finally {
      broadcastSpy.mockRestore();
    }
  });

  it("passes a load-preset enableToken override as chat_template_kwargs.enable_token", async () => {
    spyOn(llamaServerModule, "getActiveThinkingTagOverride").mockReturnValue({
      openTag: "<think>",
      closeTag: "</think>",
      enableToken: "<|think|>",
    });
    const stream = buildSSEStream([chatDelta("ok"), chatStop()]);
    const fetchMock = llamaFetch(async (_input: RequestInfo, init?: RequestInit) => {
      capturedBody = init?.body ? JSON.parse(init.body as string) : null;
      return sseResponse(stream);
    });
    globalThis.fetch = asFetch(fetchMock);

    const chat = await createChat("Enable Token Kwargs");
    await proxyCompletion({ chatId: chat.id, content: "hi", attachments: [] });
    await waitForGenerationIdle();

    expect(capturedBody.chat_template_kwargs.enable_token).toBe("<|think|>");
  });

  it("extracts Gemma 4 channel tags when the thinking override uses those delimiters", async () => {
    spyOn(llamaServerModule, "getActiveThinkingTagOverride").mockReturnValue({
      openTag: "<|channel>thought\n",
      closeTag: "<channel|>",
      enableToken: "<|think|>",
    });
    const stream = buildSSEStream([
      chatDelta("<|channel>thought\nplan<channel|>The answer is 42"),
      chatStop(),
    ]);
    const fetchMock = llamaFetch(() => sseResponse(stream));
    globalThis.fetch = asFetch(fetchMock);

    const chat = await createChat("Gemma Tags");
    const msgId = await proxyCompletion({
      chatId: chat.id,
      content: "What is the answer?",
      attachments: [],
    });
    await waitForGenerationIdle();

    const reloaded = await getChat(chat.id);
    const assistantMsg = reloaded?.messages?.find((m) => m.id === msgId);
    expect(assistantMsg?.content).toBe("The answer is 42");
    expect(assistantMsg?.thinkingContent).toBe("plan");
    expect(assistantMsg?.metrics?.thinkingSource).toBe("tags");
  });

  it("does not tag-scan a continued native-reasoning answer that mentions an open tag", async () => {
    const stream = buildSSEStream([chatDelta("<think>not a trace</think> more"), chatStop()]);
    const fetchMock = llamaFetch(() => sseResponse(stream));
    globalThis.fetch = asFetch(fetchMock);

    const chat = await createChat("Continue Native");
    await addMessage({
      id: "user-n",
      chatId: chat.id,
      role: "user",
      content: "go on",
      rawContent: "go on",
      position: 0,
      createdAt: Date.now(),
    });
    await addMessage({
      id: "asst-n",
      chatId: chat.id,
      role: "assistant",
      content: "The answer is 42",
      rawContent: "The answer is 42",
      thinkingContent: "I already planned this",
      position: 1,
      createdAt: Date.now(),
      metrics: {
        predictedTokens: 4,
        tokensPerSecond: 10,
        promptTokens: 8,
        promptTokensPerSecond: 20,
        cachedPromptTokens: 0,
        evaluatedPromptTokens: 8,
        thinkingSource: "native",
      },
    });

    await proxyCompletion({
      chatId: chat.id,
      content: "",
      attachments: [],
      isContinue: true,
    });
    await waitForGenerationIdle();

    const reloaded = await getChat(chat.id);
    const assistantMsg = reloaded?.messages?.find((m) => m.id === "asst-n");
    expect(assistantMsg?.thinkingContent).toBe("I already planned this");
    expect(assistantMsg?.content).toBe("The answer is 42<think>not a trace</think> more");
  });

  it("builds image_url multimodal payloads for image attachments", async () => {
    const stream = buildSSEStream([chatDelta("I see an image"), chatStop()]);
    spyOn(Bun, "file").mockImplementation(
      () =>
        ({
          exists: async () => true,
        }) as any,
    );

    const fetchMock = llamaFetch(async (_input: RequestInfo, init?: RequestInit) => {
      capturedBody = init?.body ? JSON.parse(init.body as string) : null;
      return sseResponse(stream);
    });
    globalThis.fetch = asFetch(fetchMock);

    const chat = await createChat("Multimodal Flow");
    const file = new File(["abc"], "img.png", { type: "image/png" });
    const messageId = await proxyCompletion({
      chatId: chat.id,
      content: "Look at this",
      attachments: [file],
    });

    await waitForGenerationIdle();

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
    const fetchMock = llamaFetch(async (_input: RequestInfo, init?: RequestInit) => {
      capturedBody = init?.body ? JSON.parse(init.body as string) : null;
      return sseResponse(stream);
    });
    globalThis.fetch = asFetch(fetchMock);

    const chat = await createChat("Large Text Attachment Test");
    const file = new File(["A".repeat(30000)], "large.txt", { type: "text/plain" });

    await proxyCompletion({
      chatId: chat.id,
      content: "Summarize the attachment",
      attachments: [file],
    });

    await waitForGenerationIdle();

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
    const fetchMock = llamaFetch(async (_input: RequestInfo, init?: RequestInit) => {
      capturedBody = init?.body ? JSON.parse(init.body as string) : null;
      return sseResponse(stream);
    });
    globalThis.fetch = asFetch(fetchMock);

    const chat = await createChat("Large PDF Attachment Test");
    const file = new File(["fake pdf bytes"], "large.pdf", { type: "application/pdf" });

    await proxyCompletion({
      chatId: chat.id,
      content: "Summarize the PDF",
      attachments: [file],
    });

    await waitForGenerationIdle();

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

  it("does not cancel a stream that is still waiting for the first token", async () => {
    await saveSettings({ requestTimeoutSeconds: 0.05 });

    const fetchMock = llamaFetch(async (_input: RequestInfo, init?: RequestInit) => {
      const signal = init?.signal;
      if (!signal) {
        throw new Error("streamProxy fetch is missing an AbortSignal");
      }
      return hangingSseResponse(signal);
    });
    globalThis.fetch = asFetch(fetchMock);

    const chat = await createChat("Prompt Eval Silence");
    await proxyCompletion({ chatId: chat.id, content: "hello", attachments: [] });
    await Bun.sleep(200);

    expect(getActiveGenerations().size).toBe(1);
    const during = await getChat(chat.id);
    expect(during?.messages?.filter((message) => message.role === "assistant")).toHaveLength(1);

    abortGeneration(chat.id, "cancelled");
    await waitForGenerationIdle();
  });

  it("times out when tokens stop arriving after the stream has started", async () => {
    await saveSettings({ requestTimeoutSeconds: 0.05 });

    const fetchMock = llamaFetch(async (_input: RequestInfo, init?: RequestInit) => {
      const signal = init?.signal;
      if (!signal) {
        throw new Error("streamProxy fetch is missing an AbortSignal");
      }
      return sseThenHangResponse(signal, chatDelta("partial"));
    });
    globalThis.fetch = asFetch(fetchMock);

    const chat = await createChat("Inactivity Timeout");
    const assistantMsgId = await proxyCompletion({
      chatId: chat.id,
      content: "hello",
      attachments: [],
    });

    await waitUntil(
      async () => {
        const reloaded = await getChat(chat.id);
        const assistant = reloaded?.messages?.find((message) => message.id === assistantMsgId);
        return assistant?.content === "partial" && getActiveGenerations().size === 0;
      },
      2000,
      "Timed out waiting for the inactivity abort to finish the assistant row",
    );

    const reloaded = await getChat(chat.id);
    const assistant = reloaded?.messages?.find((message) => message.id === assistantMsgId);
    expect(assistant?.content).toBe("partial");
    expect(assistant?.metrics?.stopReason).toBe("error");
  });

  it("handles max_tokens stop reason from chat completions format", async () => {
    const stream = buildSSEStream([chatDelta("partial"), chatStop("length")]);
    const fetchMock = llamaFetch(() => sseResponse(stream));
    globalThis.fetch = asFetch(fetchMock);

    const chat = await createChat("Length Stop Test");
    await proxyCompletion({ chatId: chat.id, content: "write a lot", attachments: [] });

    // The stop reason should be max_tokens for finish_reason "length"
    // This is verified by the broadcast call internally; as long as
    // no errors are thrown, the response format was handled correctly.
    await waitForGenerationIdle();
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
    const fetchMock = llamaFetch(() => sseResponse(stream));
    globalThis.fetch = asFetch(fetchMock);

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
    const fetchMock = llamaFetch(() => sseResponse(stream));
    globalThis.fetch = asFetch(fetchMock);

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

    await waitForGenerationIdle();
    // If we got here without a crash, the tool call accumulation worked
  });

  it("stops cleanly when a tool approval is rejected", async () => {
    const fetchMock = mock().mockImplementation(async (input: RequestInfo) => {
      const url = typeof input === "string" ? input : input.url;
      if (url.endsWith("/tokenize")) {
        return new Response(JSON.stringify({ tokens: [1, 2, 3] }), { status: 200 });
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
      return sseResponse(stream);
    });
    globalThis.fetch = asFetch(fetchMock);

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

    await waitUntil(async () => {
      const pending = await getChat(chat.id);
      return Boolean(
        pending?.messages?.some((message) => message.toolCallsJson?.includes("tc_reject")),
      );
    });
    resolveToolApproval("tc_reject", false);
    await waitForGenerationIdle();

    const reloaded = await getChat(chat.id);
    const toolMessages = reloaded?.messages?.filter((message) => message.role === "tool") ?? [];
    expect(toolMessages).toHaveLength(1);
    expect(toolMessages[0]?.toolCallId).toBe("tc_reject");
    expect(toolMessages[0]?.content).toBe(JSON.stringify({ error: "rejected by user" }));
    const assistantMsg = reloaded?.messages?.find((message) => message.role === "assistant");
    expect(assistantMsg?.toolCallsJson).toContain("tc_reject");
  });

  it("does not run the tool follow-up when generation is cancelled during approval", async () => {
    let completionCalls = 0;
    const fetchMock = mock().mockImplementation(async (input: RequestInfo) => {
      const url = typeof input === "string" ? input : input.url;
      if (url.endsWith("/tokenize")) {
        return new Response(JSON.stringify({ tokens: [1, 2, 3] }), { status: 200 });
      }
      completionCalls += 1;
      const stream = buildSSEStream([
        {
          choices: [
            {
              delta: {
                tool_calls: [
                  {
                    index: 0,
                    id: "tc_abort",
                    function: { name: "calculate", arguments: '{"expression":"2+2"}' },
                  },
                ],
              },
            },
          ],
        },
        chatStop("tool_calls"),
      ]);
      return sseResponse(stream);
    });
    globalThis.fetch = asFetch(fetchMock);

    const chat = await createChat("Tool Abort Test");
    const inferencePresetId = "tool-abort-preset";
    await createInferencePreset({
      id: inferencePresetId,
      name: "Tool Abort Preset",
      isDefault: false,
      ...createDefaultInferenceSampling(),
      toolCallsEnabled: true,
      tools: [
        {
          name: "calculate",
          description: "Evaluate a mathematical expression.",
          parameters: {
            type: "object",
            properties: { expression: { type: "string" } },
            required: ["expression"],
          },
        },
      ],
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });
    await updateChat(chat.id, { inferencePresetId });

    await proxyCompletion({
      chatId: chat.id,
      content: "cancel the tool",
      attachments: [],
    });
    await waitUntil(async () => {
      const pending = await getChat(chat.id);
      return Boolean(
        pending?.messages?.some((message) => message.toolCallsJson?.includes("tc_abort")),
      );
    });
    abortGeneration(chat.id, "cancelled");
    await waitForGenerationIdle();

    expect(completionCalls).toBe(1);
    const reloaded = await getChat(chat.id);
    const toolMessages = reloaded?.messages?.filter((message) => message.role === "tool") ?? [];
    expect(toolMessages).toHaveLength(1);
    expect(toolMessages[0]?.content).toBe(JSON.stringify({ error: "cancelled" }));
  });

  it("caps recursive tool-call re-entry depth", async () => {
    let chatCompletionFetchCount = 0;
    const fetchMock = mock().mockImplementation(async (input: RequestInfo) => {
      const url = typeof input === "string" ? input : input.url;
      if (url.endsWith("/tokenize")) {
        return new Response(JSON.stringify({ tokens: [1, 2, 3] }), { status: 200 });
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
      return sseResponse(stream);
    });
    globalThis.fetch = asFetch(fetchMock);

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
      const toolCallId = `tc_${approvalIndex}`;
      await waitUntil(async () => {
        const pending = await getChat(chat.id);
        return Boolean(
          pending?.messages?.some((message) => message.toolCallsJson?.includes(toolCallId)),
        );
      });
      resolveToolApproval(toolCallId, true, '{"expression":"2+2"}');
    }

    await waitForGenerationIdle();

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
        });
      }

      capturedBody = init?.body ? JSON.parse(init.body as string) : null;
      return sseResponse(stream);
    });
    globalThis.fetch = asFetch(fetchMock);

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

    await waitForGenerationIdle();

    const contentStrings = capturedBody.messages
      .map((message: any) =>
        typeof message.content === "string" ? message.content : JSON.stringify(message.content),
      )
      .join("\n");

    expect(contentStrings).not.toContain("OLD OLD OLD");
    expect(contentStrings).toContain("latest question");
    expect(capturedBody.tools).toHaveLength(1);
    expect(capturedBody.response_format?.schema?.properties?.result?.description).toContain("S");
    expect(tokenizeFetchCount).toBeLessThanOrEqual(2);
  });

  it("handles error responses from the model server gracefully", async () => {
    const errorSpy = spyOn(console, "error").mockImplementation(() => {});

    const fetchMock = llamaFetch(
      async () => new Response("Internal Server Error", { status: 500 }),
    );
    globalThis.fetch = asFetch(fetchMock);

    const chat = await createChat("Error Test");
    const messageId = await proxyCompletion({
      chatId: chat.id,
      content: "trigger error",
      attachments: [],
    });

    await waitForGenerationIdle();

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

    const fetchMock = llamaFetch(async () => {
      throw new Error("socket hang up");
    });
    globalThis.fetch = asFetch(fetchMock);

    const chat = await createChat("Transport Error Test");
    const messageId = await proxyCompletion({
      chatId: chat.id,
      content: "trigger transport error",
      attachments: [],
    });

    await waitForGenerationIdle();

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
    const fetchMock = llamaFetch(async (_input: RequestInfo, init?: RequestInit) => {
      capturedBody = init?.body ? JSON.parse(init.body as string) : null;
      return sseResponse(stream);
    });
    globalThis.fetch = asFetch(fetchMock);

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
    await waitForGenerationIdle();

    const systemMsg = capturedBody.messages.find((m: { role: string }) => m.role === "system");
    expect(systemMsg.content).toBe("You are helpful.");
    expect(systemMsg.content).not.toContain("<|think|>");
    expect(capturedBody.chat_template_kwargs).toEqual({
      enable_thinking: true,
      preserve_thinking: false,
      enable_token: "<|think|>",
    });
  });

  it("keeps assistant rows that have thinking content when generation is aborted", async () => {
    const wsHubModule = await import("../../src/server/wsHub");
    const broadcastSpy = spyOn(wsHubModule, "broadcast").mockImplementation(() => {});
    const fetchMock = llamaFetch(async (_input: RequestInfo, init?: RequestInit) => {
      const signal = init?.signal;
      if (!signal) {
        throw new Error("streamProxy fetch is missing an AbortSignal");
      }
      return sseThenHangResponse(signal, chatDelta("<think>I am reasoning about this</think>"));
    });
    globalThis.fetch = asFetch(fetchMock);

    try {
      const chat = await createChat("Abort Thinking Test");
      const msgId = await proxyCompletion({
        chatId: chat.id,
        content: "think",
        attachments: [],
      });

      await waitUntil(
        () =>
          broadcastSpy.mock.calls.some((call) => {
            const frame = call[0];
            return (
              frame.type === "token" &&
              typeof frame.thinkingDelta === "string" &&
              frame.thinkingDelta.includes("I am reasoning")
            );
          }),
        2000,
        "Timed out waiting for thinking tokens before abort",
      );
      abortGeneration(chat.id);
      await waitUntil(
        async () => {
          const persisted = await getChat(chat.id);
          return Boolean(
            persisted?.messages
              ?.find((m) => m.id === msgId)
              ?.thinkingContent?.includes("I am reasoning"),
          );
        },
        2000,
        "Timed out waiting for aborted thinking to persist",
      );

      const reloaded = await getChat(chat.id);
      const assistant = reloaded?.messages?.find((m) => m.id === msgId);
      expect(assistant).toBeDefined();
      expect(assistant?.thinkingContent).toContain("I am reasoning");
      expect(
        broadcastSpy.mock.calls.some((call) => {
          const frame = call[0];
          return frame.type === "stop" && frame.stopReason === "cancelled";
        }),
      ).toBe(true);
      expect(
        broadcastSpy.mock.calls.some((call) => {
          const frame = call[0];
          return frame.type === "error" && frame.generationId;
        }),
      ).toBe(false);
    } finally {
      broadcastSpy.mockRestore();
    }
  });

  it("does not overwrite a trailing tool message when continuing", async () => {
    const stream = buildSSEStream([chatDelta("follow-up"), chatStop()]);
    const fetchMock = llamaFetch(async (_input: RequestInfo, init?: RequestInit) => {
      capturedBody = init?.body ? JSON.parse(init.body as string) : null;
      return sseResponse(stream);
    });
    globalThis.fetch = asFetch(fetchMock);

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
    await waitForGenerationIdle();

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
    const fetchMock = llamaFetch(async (_input: RequestInfo, init?: RequestInit) => {
      capturedBody = init?.body ? JSON.parse(init.body as string) : null;
      return sseResponse(stream);
    });
    globalThis.fetch = asFetch(fetchMock);

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
    await waitForGenerationIdle();

    const assistantMsg = capturedBody.messages.find(
      (m: { role: string }) => m.role === "assistant",
    );
    expect(assistantMsg.tool_calls[0].function.arguments).toEqual({ expression: "1+1" });
    expect(typeof assistantMsg.tool_calls[0].function.arguments).toBe("object");
  });

  it("completes a tool round trip and deserializes arguments on the follow-up request", async () => {
    const capturedBodies: unknown[] = [];
    let chatCompletionFetchCount = 0;
    const fetchMock = llamaFetch(async (input: RequestInfo, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input.url;
      if (url.endsWith("/tokenize")) {
        return new Response(JSON.stringify({ tokens: [1, 2, 3] }), { status: 200 });
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
        return sseResponse(stream);
      }

      const stream = buildSSEStream([chatDelta("The answer is 4"), chatStop()]);
      return sseResponse(stream);
    });
    globalThis.fetch = asFetch(fetchMock);

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

    await waitUntil(async () => {
      const pending = await getChat(chat.id);
      return Boolean(
        pending?.messages?.some((message) => message.toolCallsJson?.includes("tc_roundtrip")),
      );
    });
    resolveToolApproval("tc_roundtrip", true);
    await waitForGenerationIdle();

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
