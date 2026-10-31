/**
 * @packageDocumentation
 * Tests for shared client store behavior and state transitions.
 */

import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import { act, cleanup } from "@testing-library/react";
import { asFetch, testLoadConfig } from "../fixtures";

let useAppStore: typeof import("../../src/client/store").useAppStore;
let useUiStore: typeof import("../../src/client/uiStore").useUiStore;
const nativeFetch = globalThis.fetch;

describe("stores logic", () => {
  beforeEach(async () => {
    const storeModule = await import(`../../src/client/store.ts?cachebust=${Date.now()}`);
    useAppStore = storeModule.useAppStore;
    const uiModule = await import(`../../src/client/uiStore.ts?cachebust=${Date.now()}`);
    useUiStore = uiModule.useUiStore;

    act(() => {
      useAppStore.setState({ serverStatus: "idle", isConnected: false });
    });
  });

  afterEach(() => {
    globalThis.fetch = nativeFetch;
    cleanup();
  });

  it("uiStore toggles correctly", () => {
    // Basic test to verify rightPanelView setter
    const { setRightPanelView } = useUiStore.getState();
    act(() => {
      setRightPanelView("settings");
    });
    expect(useUiStore.getState().rightPanelView).toBe("settings");
  });

  it("appStore initializes correctly", () => {
    expect(useAppStore.getState().serverStatus).toBe("idle");
    expect(useAppStore.getState().isConnected).toBe(false);
  });

  it("appStore handles notifications", () => {
    const { addNotification, removeNotification } = useAppStore.getState();

    addNotification("Test Toast", "success");
    let state = useAppStore.getState();
    expect(state.notifications.length).toBe(1);
    expect(state.notifications[0]?.message).toBe("Test Toast");
    expect(state.notifications[0]?.type).toBe("success");

    const id = state.notifications[0]?.id;
    expect(id).toBeString();
    if (typeof id !== "string") {
      throw new Error("expected a notification id");
    }
    removeNotification(id);
    state = useAppStore.getState();
    expect(state.notifications.length).toBe(0);
  });

  it("appStore handles global error state", () => {
    const { setError, clearError } = useAppStore.getState();

    setError("Fatal error", "Retry", () => {});
    let state = useAppStore.getState();
    expect(state.errorMessage).toBe("Fatal error");
    expect(state.errorActionLabel).toBe("Retry");
    expect(typeof state.errorAction).toBe("function");

    clearError();
    state = useAppStore.getState();
    expect(state.errorMessage).toBeNull();
  });

  it("appStore keeps the latest 5000 log lines", () => {
    const { addLog } = useAppStore.getState();

    for (let index = 0; index < 5100; index++) {
      addLog("info", `line-${index}`);
    }

    const state = useAppStore.getState();
    expect(state.logs.length).toBeLessThanOrEqual(5000);
    expect(state.logs[0]).toBe("[info] line-500");
    expect(state.logs[state.logs.length - 1]).toBe("[info] line-5099");
    expect(state.logs[1]).toBe("[info] line-501");
  });

  it("sendMessage rolls back optimistic message on failure", async () => {
    const originalFetch = globalThis.fetch;
    const fetchMock = mock().mockResolvedValue(new Response(null, { status: 500 }));
    globalThis.fetch = asFetch(fetchMock);

    act(() => {
      useAppStore.setState({ currentChatId: "chat-1", messages: [], isGenerating: false });
    });

    await act(async () => {
      await expect(useAppStore.getState().sendMessage("Hello world")).rejects.toThrow(
        "Message send failed.",
      );
    });

    const state = useAppStore.getState();
    expect(state.messages).toHaveLength(0);
    expect(state.isGenerating).toBe(false);
    expect(state.errorMessage).toBe("Message send failed.");

    globalThis.fetch = originalFetch;
  });

  it("sendMessage sends FormData with files for attachments", async () => {
    const originalFetch = globalThis.fetch;
    let capturedInit: RequestInit | undefined;
    let capturedUrl: string | undefined;
    const fetchMock = mock().mockImplementation(async (input: RequestInfo, init?: RequestInit) => {
      capturedInit = init;
      capturedUrl = typeof input === "string" ? input : input.url;
      return new Response(null, { status: 200 });
    });
    globalThis.fetch = asFetch(fetchMock);

    act(() => {
      useAppStore.setState({ currentChatId: "chat-1", messages: [], isGenerating: false });
    });

    const file = new File(["hello"], "test.txt", { type: "text/plain" });
    await act(async () => {
      await useAppStore.getState().sendMessage("Hello world", [file]);
    });

    expect(capturedUrl).toBe("/api/chats/chat-1/messages");
    expect(capturedInit?.method).toBe("POST");
    expect(capturedInit?.headers).toBeUndefined();
    expect(capturedInit?.body).toBeInstanceOf(FormData);
    const body = capturedInit?.body as FormData;
    expect(body.get("content")).toBe("Hello world");
    expect(body.get("expectedHeadMessageId")).toBe("");
    const uploadedFile = body.getAll("file")[0];
    expect(uploadedFile).toBeInstanceOf(File);
    expect((uploadedFile as File).name).toBe(file.name);
    expect((uploadedFile as File).size).toBe(file.size);
    expect(await (uploadedFile as File).text()).toBe("hello");

    globalThis.fetch = originalFetch;
  });

  it("sendMessage refuses to send while chat history is syncing", async () => {
    act(() => {
      useAppStore.setState({
        currentChatId: "chat-1",
        messages: [],
        isGenerating: false,
        isSyncingHistory: true,
      });
    });

    await act(async () => {
      await expect(useAppStore.getState().sendMessage("Hello")).rejects.toThrow(
        "Please wait for the chat history to finish updating before sending.",
      );
    });

    expect(useAppStore.getState().messages).toHaveLength(0);
    useAppStore.setState({ isSyncingHistory: false });
  });

  it("sendMessage reloads the transcript when the server reports a head mismatch", async () => {
    const originalFetch = globalThis.fetch;
    const fetchMock = mock().mockImplementation(async (input: RequestInfo) => {
      const url = typeof input === "string" ? input : input.url;
      if (url === "/api/chats/chat-1/messages") {
        return new Response(
          JSON.stringify({
            error: "Chat history on the server does not match this window.",
            code: "TRANSCRIPT_MISMATCH",
            lastMessageId: "old-user",
          }),
          { status: 409, headers: { "Content-Type": "application/json" } },
        );
      }
      if (url === "/api/chats/chat-1" || url.startsWith("/api/chats/chat-1?")) {
        return new Response(
          JSON.stringify({
            id: "chat-1",
            name: "AudioTest2",
            messages: [
              {
                id: "old-user",
                chatId: "chat-1",
                role: "user",
                content: "old video turn",
                rawContent: "old video turn",
                position: 0,
                createdAt: 1,
              },
              {
                id: "old-asst",
                chatId: "chat-1",
                role: "assistant",
                content: "old reply",
                rawContent: "old reply",
                position: 1,
                createdAt: 2,
              },
            ],
            totalMessages: 2,
            systemPresetId: null,
            inferencePresetId: null,
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      if (typeof url === "string" && url.endsWith("/context-usage")) {
        return new Response(JSON.stringify({ usedTokens: 0, contextSize: null }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      return new Response(null, { status: 404 });
    });
    globalThis.fetch = asFetch(fetchMock);

    act(() => {
      useAppStore.setState({
        currentChatId: "chat-1",
        messages: [],
        isGenerating: false,
        isWaitingForToolApproval: false,
        isSyncingHistory: false,
        currentChatMetadata: { name: "AudioTest2", systemPresetId: null, inferencePresetId: null },
      });
    });

    await act(async () => {
      await expect(
        useAppStore.getState().sendMessage("Transcribe the audio attachment."),
      ).rejects.toThrow("Chat history was out of date and has been reloaded. Please send again.");
    });

    const state = useAppStore.getState();
    expect(state.messages.map((message) => message.id)).toEqual(["old-user", "old-asst"]);
    expect(state.messages.some((message) => message.id.startsWith("temp-"))).toBe(false);
    expect(state.isGenerating).toBe(false);

    globalThis.fetch = originalFetch;
  });

  it("sendMessage shows a non-mismatch 409 without reloading the transcript", async () => {
    const originalFetch = globalThis.fetch;
    const fetchMock = mock().mockImplementation(async (input: RequestInfo) => {
      const url = typeof input === "string" ? input : input.url;
      if (url === "/api/chats/chat-1/messages") {
        return new Response(JSON.stringify({ error: "Llama-server is not running." }), {
          status: 409,
          headers: { "Content-Type": "application/json" },
        });
      }
      return new Response(JSON.stringify({ messages: [{ id: "should-not-load" }] }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    });
    globalThis.fetch = asFetch(fetchMock);

    act(() => {
      useAppStore.setState({
        currentChatId: "chat-1",
        messages: [],
        isGenerating: false,
        isSyncingHistory: false,
        errorMessage: null,
      });
    });

    await act(async () => {
      await expect(useAppStore.getState().sendMessage("hello")).rejects.toThrow(
        "Llama-server is not running.",
      );
    });

    const state = useAppStore.getState();
    expect(state.errorMessage).toBe("Llama-server is not running.");
    expect(state.messages).toHaveLength(0);
    expect(
      fetchMock.mock.calls.some((call) => {
        const url = typeof call[0] === "string" ? call[0] : (call[0] as Request).url;
        return url === "/api/chats/chat-1" || url.startsWith("/api/chats/chat-1?");
      }),
    ).toBe(false);

    globalThis.fetch = originalFetch;
  });

  it("does not merge older messages after the chat changes", async () => {
    let release: (response: Response) => void = () => {};
    const fetchMock = mock(
      () =>
        new Promise<Response>((resolve) => {
          release = resolve;
        }),
    );
    globalThis.fetch = asFetch(fetchMock);
    const current = {
      id: "current",
      chatId: "chat-1",
      role: "user" as const,
      content: "current",
      rawContent: "current",
      position: 5,
      createdAt: 1,
    };
    act(() => {
      useAppStore.setState({
        currentChatId: "chat-1",
        messages: [current],
        totalMessages: 10,
      });
    });

    const pending = useAppStore.getState().loadMoreMessages();
    act(() => {
      useAppStore.setState({
        currentChatId: "chat-2",
        messages: [{ ...current, id: "other", chatId: "chat-2", position: 0 }],
        totalMessages: 1,
      });
    });
    release(
      new Response(
        JSON.stringify({
          messages: [{ ...current, id: "older", position: 1 }],
          totalMessages: 99,
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    );
    await pending;

    const state = useAppStore.getState();
    expect(state.messages.map((message) => message.id)).toEqual(["other"]);
    expect(state.totalMessages).toBe(1);
  });

  it("issues one request when older messages are requested twice", async () => {
    let release: (response: Response) => void = () => {};
    const fetchMock = mock(
      () =>
        new Promise<Response>((resolve) => {
          release = resolve;
        }),
    );
    globalThis.fetch = asFetch(fetchMock);
    act(() => {
      useAppStore.setState({
        currentChatId: "chat-1",
        messages: [
          {
            id: "current",
            chatId: "chat-1",
            role: "user",
            content: "current",
            rawContent: "current",
            position: 5,
            createdAt: 1,
          },
        ],
        totalMessages: 10,
      });
    });

    const first = useAppStore.getState().loadMoreMessages();
    const second = useAppStore.getState().loadMoreMessages();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    release(
      new Response(JSON.stringify({ messages: [], totalMessages: 10 }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );
    await Promise.all([first, second]);
  });

  it("unloadModel resets server status on success", async () => {
    const originalFetch = globalThis.fetch;
    const fetchMock = mock().mockResolvedValue(new Response(null, { status: 200 }));
    globalThis.fetch = asFetch(fetchMock);

    act(() => {
      useAppStore.setState({ serverStatus: "running", errorMessage: "oops" });
    });

    await act(async () => {
      await useAppStore.getState().unloadModel();
    });

    const state = useAppStore.getState();
    expect(state.serverStatus).toBe("idle");
    expect(state.errorMessage).toBeNull();

    globalThis.fetch = originalFetch;
  });

  it("loadModel refreshes server status after a successful model load", async () => {
    const originalFetch = globalThis.fetch;
    const fetchMock = mock().mockImplementation(async (input) => {
      if (typeof input === "string" && input === "/api/server/load") {
        return new Response(JSON.stringify({ port: 1234 }), { status: 200 });
      }
      return new Response(null, { status: 404 });
    });
    globalThis.fetch = asFetch(fetchMock);

    const originalFetchServerStatus = useAppStore.getState().fetchServerStatus;
    const fetchServerStatusSpy = mock().mockResolvedValue(undefined);
    act(() => {
      useAppStore.setState({ fetchServerStatus: fetchServerStatusSpy });
    });

    await act(async () => {
      await useAppStore.getState().loadModel(
        testLoadConfig("/models/test.gguf", {
          gpuLayers: 33,
          threads: 1,
          batchSize: 1,
          microBatchSize: 1,
          ropeFreqBase: 10000,
          ropeFreqScale: 1,
          mlock: false,
          flashAttn: "off",
        }),
      );
    });

    expect(fetchServerStatusSpy).toHaveBeenCalled();
    act(() => {
      useAppStore.setState({ fetchServerStatus: originalFetchServerStatus });
    });
    globalThis.fetch = originalFetch;
  });

  it("leaves no error banner when a model load is cancelled", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = asFetch(
      mock(async () => {
        return new Response(
          JSON.stringify({ error: "Model load was cancelled.", code: "LOAD_CANCELLED" }),
          { status: 409, headers: { "Content-Type": "application/json" } },
        );
      }),
    );
    act(() => {
      useAppStore.setState({ errorMessage: "previous", serverStatus: "idle" });
    });
    await act(async () => {
      const loaded = await useAppStore.getState().loadModel(testLoadConfig("/models/test.gguf"));
      expect(loaded).toBe(false);
    });
    expect(useAppStore.getState().errorMessage).toBeNull();
    expect(useAppStore.getState().serverStatus).toBe("idle");
    globalThis.fetch = originalFetch;
  });

  it("loadChat('default-chat') creates a chat when the requested chat is missing", async () => {
    const originalFetch = globalThis.fetch;
    const fetchMock = mock().mockImplementation(async (input, init) => {
      if (typeof input === "string" && input.endsWith("/api/chats/default-chat")) {
        return new Response("Not Found", { status: 404 });
      }
      if (typeof input === "string" && input === "/api/chats" && init?.method === "POST") {
        return new Response(JSON.stringify({ id: "new-chat", name: "New Chat" }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      return new Response(null, { status: 404 });
    });
    globalThis.fetch = asFetch(fetchMock);

    act(() => {
      useAppStore.setState({ currentChatId: null, messages: [], currentChatMetadata: null });
    });

    await act(async () => {
      await useAppStore.getState().loadChat("default-chat");
    });

    const state = useAppStore.getState();
    expect(state.currentChatId).toBe("new-chat");
    expect(state.currentChatMetadata?.name).toBe("New Chat");
    expect(state.messages).toHaveLength(0);

    globalThis.fetch = originalFetch;
  });

  it("loadModel opens Settings when llama-server is not configured", async () => {
    const originalFetch = globalThis.fetch;
    const sharedUiStoreModule = await import("../../src/client/uiStore");
    const fetchMock = mock().mockResolvedValue(
      new Response(
        JSON.stringify({
          error: "No llama-server binary path configured",
          code: "NOT_CONFIGURED",
        }),
        {
          status: 400,
          headers: { "Content-Type": "application/json" },
        },
      ),
    );
    globalThis.fetch = asFetch(fetchMock);

    act(() => {
      sharedUiStoreModule.useUiStore.setState({ rightPanelView: null, activePresetId: null });
    });

    await act(async () => {
      await useAppStore.getState().loadModel(
        testLoadConfig("/models/test.gguf", {
          gpuLayers: 33,
          threads: 1,
          batchSize: 1,
          microBatchSize: 1,
          ropeFreqBase: 10000,
          ropeFreqScale: 1,
          mlock: false,
          flashAttn: "off",
        }),
      );
    });

    const state = useAppStore.getState();
    expect(state.serverStatus).toBe("idle");
    expect(state.errorActionLabel).toBe("Settings");
    expect(sharedUiStoreModule.useUiStore.getState().rightPanelView).toBe("settings");

    globalThis.fetch = originalFetch;
  });

  it("loadChat ignores stale responses and keeps sends on the latest chat", async () => {
    const originalFetch = globalThis.fetch;

    let resolveChatA: ((value: Response) => void) | undefined;
    let resolveChatB: ((value: Response) => void) | undefined;
    const sentMessageUrls: string[] = [];

    const chatAResponse = new Promise<Response>((resolve) => {
      resolveChatA = resolve;
    });
    const chatBResponse = new Promise<Response>((resolve) => {
      resolveChatB = resolve;
    });

    const fetchMock = mock().mockImplementation(async (input: RequestInfo, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input.url;
      if (url === "/api/chats/chat-a") {
        return chatAResponse;
      }
      if (url === "/api/chats/chat-b") {
        return chatBResponse;
      }
      if (url === "/api/chats/chat-b/messages") {
        sentMessageUrls.push(url);
        return new Response(null, { status: 200 });
      }
      if (url === "/api/chats/chat-a/messages") {
        sentMessageUrls.push(url);
        return new Response(null, { status: 200 });
      }
      if (url.endsWith("/context-usage")) {
        return new Response(JSON.stringify({ usedTokens: 0, contextSize: null }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      throw new Error(`Unexpected fetch: ${url} ${init?.method ?? "GET"}`);
    });
    globalThis.fetch = asFetch(fetchMock);

    act(() => {
      useAppStore.setState({
        currentChatId: null,
        messages: [],
        currentChatMetadata: null,
        isGenerating: false,
      });
    });

    const loadChatA = useAppStore.getState().loadChat("chat-a");
    const loadChatB = useAppStore.getState().loadChat("chat-b");

    resolveChatB?.(
      new Response(
        JSON.stringify({
          id: "chat-b",
          name: "Chat B",
          messages: [
            {
              id: "msg-b",
              chatId: "chat-b",
              role: "user",
              content: "newer chat",
              rawContent: "newer chat",
              position: 0,
              createdAt: 1,
            },
          ],
          totalMessages: 1,
          systemPresetId: null,
          inferencePresetId: null,
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    );
    await act(async () => {
      await loadChatB;
    });

    resolveChatA?.(
      new Response(
        JSON.stringify({
          id: "chat-a",
          name: "Chat A",
          messages: [
            {
              id: "msg-a",
              chatId: "chat-a",
              role: "user",
              content: "stale chat",
              rawContent: "stale chat",
              position: 0,
              createdAt: 1,
            },
          ],
          totalMessages: 1,
          systemPresetId: null,
          inferencePresetId: null,
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    );
    await act(async () => {
      await loadChatA;
    });

    let state = useAppStore.getState();
    expect(state.currentChatId).toBe("chat-b");
    expect(state.currentChatMetadata?.name).toBe("Chat B");
    expect(state.messages).toHaveLength(1);
    expect(state.messages[0]?.chatId).toBe("chat-b");

    await act(async () => {
      await useAppStore.getState().sendMessage("hello latest chat");
    });

    state = useAppStore.getState();
    expect(sentMessageUrls).toEqual(["/api/chats/chat-b/messages"]);
    expect(state.currentChatId).toBe("chat-b");

    globalThis.fetch = originalFetch;
  });

  it("fetchServerStatus creates a fallback loadedModel when the active model path is not in scanned models", async () => {
    const originalFetch = globalThis.fetch;
    const response = {
      status: "running",
      port: 1234,
      config: { modelPath: "/models/foo.gguf" },
    };
    const fetchMock = mock().mockResolvedValue(
      new Response(JSON.stringify(response), { status: 200 }),
    );
    globalThis.fetch = asFetch(fetchMock);

    act(() => {
      useAppStore.setState({ models: [], loadedModel: null });
    });

    await act(async () => {
      await useAppStore.getState().fetchServerStatus();
    });

    const state = useAppStore.getState();
    expect(state.serverStatus).toBe("running");
    expect(state.loadedModel).not.toBeNull();
    expect(state.loadedModel?.primaryPath).toBe("/models/foo.gguf");
    expect(state.loadedModel?.modelName).toBe("foo.gguf");

    globalThis.fetch = originalFetch;
  });

  it("disconnectWs disables reconnect and clears connection state", () => {
    const { disconnectWs } = useAppStore.getState();

    act(() => {
      useAppStore.setState({
        isConnected: true,
        isGenerating: true,
        isWaitingForToolApproval: true,
        shouldReconnect: true,
      });
      disconnectWs();
    });

    const state = useAppStore.getState();
    expect(state.isConnected).toBe(false);
    expect(state.isGenerating).toBe(false);
    expect(state.isWaitingForToolApproval).toBe(false);
    expect(state.currentGenerationId).toBeNull();
    expect(state.shouldReconnect).toBe(false);
  });

  it("replaces optimistic user messages when the server confirms the persisted id", () => {
    const originalWebSocket = globalThis.WebSocket;

    class MockWebSocket {
      static CONNECTING = 0;
      static OPEN = 1;
      static CLOSED = 3;
      static instance: MockWebSocket | null = null;
      readyState = MockWebSocket.OPEN;
      onopen: (() => void) | null = null;
      onmessage: ((event: { data: string }) => void) | null = null;
      onclose: (() => void) | null = null;

      constructor() {
        MockWebSocket.instance = this;
      }

      send() {}

      close() {
        this.readyState = MockWebSocket.CLOSED;
        this.onclose?.();
      }
    }

    globalThis.WebSocket = MockWebSocket as unknown as typeof WebSocket;

    act(() => {
      useAppStore.setState({
        currentChatId: "chat-1",
        messages: [
          {
            id: "temp-123",
            chatId: "chat-1",
            role: "user",
            content: "Hello there",
            rawContent: "Hello there",
            position: 0,
            createdAt: 1,
          },
        ],
        isGenerating: true,
      });
      useAppStore.getState().connectWs();
    });

    act(() => {
      MockWebSocket.instance?.onopen?.();
      MockWebSocket.instance?.onmessage?.({
        data: JSON.stringify({
          type: "message",
          chatId: "chat-1",
          message: {
            id: "msg-1",
            chatId: "chat-1",
            role: "user",
            content: "Hello there",
            rawContent: "Hello there",
            position: 0,
            createdAt: 1,
          },
        }),
      });
    });

    const state = useAppStore.getState();
    expect(state.messages).toHaveLength(1);
    expect(state.messages[0]?.id).toBe("msg-1");
    expect(state.messages[0]?.role).toBe("user");

    globalThis.WebSocket = originalWebSocket;
  });

  it("tracks tool approval pending separately from token streaming", () => {
    const originalWebSocket = globalThis.WebSocket;
    const sentFrames: string[] = [];

    class MockWebSocket {
      static CONNECTING = 0;
      static OPEN = 1;
      static CLOSED = 3;
      static instance: MockWebSocket | null = null;
      readyState = MockWebSocket.OPEN;
      onopen: (() => void) | null = null;
      onmessage: ((event: { data: string }) => void) | null = null;
      onclose: (() => void) | null = null;

      constructor() {
        MockWebSocket.instance = this;
      }

      send(data: string) {
        sentFrames.push(data);
      }

      close() {
        this.readyState = MockWebSocket.CLOSED;
        this.onclose?.();
      }
    }

    globalThis.WebSocket = MockWebSocket as unknown as typeof WebSocket;

    act(() => {
      useAppStore.setState({
        currentChatId: "chat-1",
        messages: [
          {
            id: "assistant-1",
            chatId: "chat-1",
            role: "assistant",
            content: "Planning a tool call",
            rawContent: "Planning a tool call",
            position: 0,
            createdAt: 1,
          },
        ],
        isGenerating: false,
        isWaitingForToolApproval: false,
      });
      useAppStore.getState().connectWs();
    });

    act(() => {
      MockWebSocket.instance?.onopen?.();
      MockWebSocket.instance?.onmessage?.({
        data: JSON.stringify({
          type: "tool_call",
          chatId: "chat-1",
          messageId: "assistant-1",
          generationId: "gen-1",
          toolCalls: [
            {
              id: "tool-1",
              type: "function",
              function: { name: "calculate", arguments: '{"expression":"2+2"}' },
            },
          ],
        }),
      });
    });

    let state = useAppStore.getState();
    expect(state.isGenerating).toBe(false);
    expect(state.isWaitingForToolApproval).toBe(true);

    act(() => {
      MockWebSocket.instance?.onmessage?.({
        data: JSON.stringify({
          type: "tool_approval_state",
          chatId: "chat-1",
          messageId: "assistant-1",
          generationId: "gen-1",
          pending: false,
          resumeGeneration: true,
          reason: "approved",
        }),
      });
    });

    state = useAppStore.getState();
    expect(state.isGenerating).toBe(true);
    expect(state.isWaitingForToolApproval).toBe(false);

    act(() => {
      useAppStore.getState().stopGeneration();
    });

    expect(sentFrames.some((frame) => frame.includes('"type":"cancel"'))).toBe(true);
    globalThis.WebSocket = originalWebSocket;
  });

  it("does not recreate a deleted assistant from a late token frame", () => {
    const originalWebSocket = globalThis.WebSocket;

    class MockWebSocket {
      static CONNECTING = 0;
      static OPEN = 1;
      static CLOSED = 3;
      static instance: MockWebSocket | null = null;
      readyState = MockWebSocket.OPEN;
      onopen: (() => void) | null = null;
      onmessage: ((event: { data: string }) => void) | null = null;
      onclose: (() => void) | null = null;
      constructor() {
        MockWebSocket.instance = this;
      }
      send() {}
      close() {
        this.readyState = MockWebSocket.CLOSED;
        this.onclose?.();
      }
    }

    globalThis.WebSocket = MockWebSocket as unknown as typeof WebSocket;

    act(() => {
      useAppStore.setState({
        currentChatId: "chat-1",
        messages: [
          {
            id: "u1",
            chatId: "chat-1",
            role: "user",
            content: "hello",
            rawContent: "hello",
            position: 0,
            createdAt: 1,
          },
        ],
        isGenerating: false,
        isSyncingHistory: false,
        currentGenerationId: null,
      });
      useAppStore.getState().connectWs();
    });

    act(() => {
      MockWebSocket.instance?.onmessage?.({
        data: JSON.stringify({
          type: "token",
          chatId: "chat-1",
          messageId: "deleted-assistant",
          generationId: "gen-old",
          delta: "ghost",
        }),
      });
    });

    expect(useAppStore.getState().messages.map((message) => message.id)).toEqual(["u1"]);
    globalThis.WebSocket = originalWebSocket;
  });

  it("applies thinking tokens that arrive before the assistant placeholder during generate", () => {
    const originalWebSocket = globalThis.WebSocket;

    class MockWebSocket {
      static CONNECTING = 0;
      static OPEN = 1;
      static CLOSED = 3;
      static instance: MockWebSocket | null = null;
      readyState = MockWebSocket.OPEN;
      onopen: (() => void) | null = null;
      onmessage: ((event: { data: string }) => void) | null = null;
      onclose: (() => void) | null = null;
      constructor() {
        MockWebSocket.instance = this;
      }
      send() {}
      close() {
        this.readyState = MockWebSocket.CLOSED;
        this.onclose?.();
      }
    }

    globalThis.WebSocket = MockWebSocket as unknown as typeof WebSocket;

    act(() => {
      useAppStore.setState({
        currentChatId: "chat-1",
        messages: [
          {
            id: "u2",
            chatId: "chat-1",
            role: "user",
            content: "edited",
            rawContent: "edited",
            position: 0,
            createdAt: 1,
          },
        ],
        isGenerating: true,
        isSyncingHistory: false,
        currentGenerationId: null,
      });
      useAppStore.getState().connectWs();
    });

    act(() => {
      MockWebSocket.instance?.onmessage?.({
        data: JSON.stringify({
          type: "token",
          chatId: "chat-1",
          messageId: "a-regen",
          generationId: "gen-edit",
          delta: "",
          thinkingDelta: "plan",
        }),
      });
    });

    const assistant = useAppStore.getState().messages.find((message) => message.id === "a-regen");
    expect(assistant?.thinkingContent).toBe("plan");
    globalThis.WebSocket = originalWebSocket;
  });

  it("creates a missing assistant from stop while generating, but not after history sync", () => {
    const originalWebSocket = globalThis.WebSocket;

    class MockWebSocket {
      static CONNECTING = 0;
      static OPEN = 1;
      static CLOSED = 3;
      static instance: MockWebSocket | null = null;
      readyState = MockWebSocket.OPEN;
      onopen: (() => void) | null = null;
      onmessage: ((event: { data: string }) => void) | null = null;
      onclose: (() => void) | null = null;
      constructor() {
        MockWebSocket.instance = this;
      }
      send() {}
      close() {
        this.readyState = MockWebSocket.CLOSED;
        this.onclose?.();
      }
    }

    globalThis.WebSocket = MockWebSocket as unknown as typeof WebSocket;
    const emptyTimings = {
      tokens_cached: 0,
      tokens_evaluated: 0,
      predicted_ms: 0,
      predicted_n: 0,
      predicted_per_second: 0,
      predicted_per_token_ms: 0,
      prompt_ms: 0,
      prompt_n: 0,
      prompt_per_second: 0,
      prompt_per_token_ms: 0,
    };

    act(() => {
      useAppStore.setState({
        currentChatId: "chat-1",
        messages: [],
        isGenerating: true,
        isSyncingHistory: false,
      });
      useAppStore.getState().connectWs();
    });

    act(() => {
      MockWebSocket.instance?.onmessage?.({
        data: JSON.stringify({
          type: "stop",
          chatId: "chat-1",
          messageId: "a-empty",
          stopReason: "eos",
          timings: emptyTimings,
          fullContent: "",
        }),
      });
    });

    expect(useAppStore.getState().messages.map((message) => message.id)).toEqual(["a-empty"]);

    act(() => {
      useAppStore.setState({
        messages: [
          {
            id: "u1",
            chatId: "chat-1",
            role: "user",
            content: "hello",
            rawContent: "hello",
            position: 0,
            createdAt: 1,
          },
        ],
        isGenerating: false,
        isSyncingHistory: true,
      });
    });

    act(() => {
      MockWebSocket.instance?.onmessage?.({
        data: JSON.stringify({
          type: "stop",
          chatId: "chat-1",
          messageId: "ghost-stop",
          stopReason: "eos",
          timings: emptyTimings,
          fullContent: "nope",
        }),
      });
    });

    expect(useAppStore.getState().messages.map((message) => message.id)).toEqual(["u1"]);
    globalThis.WebSocket = originalWebSocket;
  });

  it("disconnect stops live tokens and tells the server to abort", () => {
    const originalWebSocket = globalThis.WebSocket;
    const sent: string[] = [];

    class MockWebSocket {
      static CONNECTING = 0;
      static OPEN = 1;
      static CLOSING = 2;
      static CLOSED = 3;
      static instance: MockWebSocket | null = null;
      readyState = MockWebSocket.OPEN;
      onopen: (() => void) | null = null;
      onmessage: ((event: { data: string }) => void) | null = null;
      onclose: (() => void) | null = null;
      constructor() {
        MockWebSocket.instance = this;
      }
      send(data: string) {
        sent.push(data);
      }
      close() {
        this.readyState = MockWebSocket.CLOSED;
        this.onclose?.();
      }
    }

    globalThis.WebSocket = MockWebSocket as unknown as typeof WebSocket;

    act(() => {
      useAppStore.setState({
        currentChatId: "chat-1",
        messages: [
          {
            id: "a1",
            chatId: "chat-1",
            role: "assistant",
            content: "partial",
            rawContent: "partial",
            position: 0,
            createdAt: 1,
          },
        ],
        isGenerating: true,
        currentGenerationId: "gen-1",
        shouldReconnect: true,
      });
      useAppStore.getState().connectWs();
      MockWebSocket.instance?.onopen?.();
    });

    act(() => {
      useAppStore.getState().disconnectWs();
    });

    act(() => {
      MockWebSocket.instance?.onmessage?.({
        data: JSON.stringify({
          type: "token",
          chatId: "chat-1",
          messageId: "a1",
          generationId: "gen-1",
          delta: " more",
        }),
      });
    });

    const state = useAppStore.getState();
    expect(sent.some((frame) => frame.includes('"type":"session_close"'))).toBe(true);
    expect(state.isGenerating).toBe(false);
    expect(state.shouldReconnect).toBe(false);
    expect(state.messages[0]?.content).toBe("partial");
    globalThis.WebSocket = originalWebSocket;
  });

  it("ignores token frames after a successful unload", async () => {
    const originalWebSocket = globalThis.WebSocket;
    const originalFetch = globalThis.fetch;

    class MockWebSocket {
      static CONNECTING = 0;
      static OPEN = 1;
      static CLOSED = 3;
      static instance: MockWebSocket | null = null;
      readyState = MockWebSocket.OPEN;
      onopen: (() => void) | null = null;
      onmessage: ((event: { data: string }) => void) | null = null;
      onclose: (() => void) | null = null;
      constructor() {
        MockWebSocket.instance = this;
      }
      send() {}
      close() {
        this.readyState = MockWebSocket.CLOSED;
        this.onclose?.();
      }
    }

    globalThis.WebSocket = MockWebSocket as unknown as typeof WebSocket;
    globalThis.fetch = asFetch(mock().mockResolvedValue(new Response(null, { status: 200 })));

    act(() => {
      useAppStore.setState({
        serverStatus: "running",
        currentChatId: "chat-1",
        messages: [
          {
            id: "a1",
            chatId: "chat-1",
            role: "assistant",
            content: "partial",
            rawContent: "partial",
            position: 0,
            createdAt: 1,
          },
        ],
        isGenerating: true,
        currentGenerationId: "gen-1",
      });
      useAppStore.getState().connectWs();
    });

    await act(async () => {
      await useAppStore.getState().unloadModel();
    });

    act(() => {
      MockWebSocket.instance?.onmessage?.({
        data: JSON.stringify({
          type: "token",
          chatId: "chat-1",
          messageId: "a1",
          generationId: "gen-1",
          delta: " more",
        }),
      });
    });

    const state = useAppStore.getState();
    expect(state.serverStatus).toBe("idle");
    expect(state.isGenerating).toBe(false);
    expect(state.messages[0]?.content).toBe("partial");
    globalThis.WebSocket = originalWebSocket;
    globalThis.fetch = originalFetch;
  });

  it("keeps the replacement socket when an older socket closes", () => {
    const originalWebSocket = globalThis.WebSocket;

    class MockWebSocket {
      static CONNECTING = 0;
      static OPEN = 1;
      static CLOSING = 2;
      static CLOSED = 3;
      static instance: MockWebSocket | null = null;
      readyState = MockWebSocket.OPEN;
      onopen: (() => void) | null = null;
      onmessage: ((event: { data: string }) => void) | null = null;
      onclose: (() => void) | null = null;
      constructor() {
        MockWebSocket.instance = this;
      }
      send() {}
      close() {
        this.readyState = MockWebSocket.CLOSED;
        this.onclose?.();
      }
    }

    globalThis.WebSocket = MockWebSocket as unknown as typeof WebSocket;

    act(() => {
      useAppStore.getState().connectWs();
    });
    const first = MockWebSocket.instance;
    act(() => {
      first?.onopen?.();
    });
    expect(useAppStore.getState().isConnected).toBe(true);

    if (first) first.readyState = MockWebSocket.CLOSING;
    act(() => {
      useAppStore.getState().connectWs();
    });
    const second = MockWebSocket.instance;
    expect(second).not.toBe(first);
    act(() => {
      second?.onopen?.();
      first?.onclose?.();
    });

    expect(useAppStore.getState().isConnected).toBe(true);
    expect(useAppStore.getState().shouldReconnect).toBe(true);
    globalThis.WebSocket = originalWebSocket;
  });

  it("keeps generation active after a tool-call stop until a real stop or error", () => {
    const originalWebSocket = globalThis.WebSocket;

    class MockWebSocket {
      static CONNECTING = 0;
      static OPEN = 1;
      static CLOSED = 3;
      static instance: MockWebSocket | null = null;
      readyState = MockWebSocket.OPEN;
      onopen: (() => void) | null = null;
      onmessage: ((event: { data: string }) => void) | null = null;
      onclose: (() => void) | null = null;
      constructor() {
        MockWebSocket.instance = this;
      }
      send() {}
      close() {
        this.readyState = MockWebSocket.CLOSED;
        this.onclose?.();
      }
    }

    globalThis.WebSocket = MockWebSocket as unknown as typeof WebSocket;
    const timings = {
      predicted_ms: 10,
      predicted_n: 1,
      predicted_per_second: 1,
      predicted_per_token_ms: 10,
      prompt_ms: 10,
      prompt_n: 1,
      prompt_per_second: 1,
      prompt_per_token_ms: 10,
      cache_n: 0,
    };

    act(() => {
      useAppStore.setState({
        currentChatId: "chat-1",
        messages: [
          {
            id: "a1",
            chatId: "chat-1",
            role: "assistant",
            content: "",
            rawContent: "",
            position: 0,
            createdAt: 1,
          },
        ],
        isGenerating: true,
        currentGenerationId: "gen-tool",
      });
      useAppStore.getState().connectWs();
    });

    act(() => {
      MockWebSocket.instance?.onmessage?.({
        data: JSON.stringify({
          type: "stop",
          chatId: "chat-1",
          messageId: "a1",
          generationId: "gen-tool",
          stopReason: "tool_calls",
          timings,
        }),
      });
    });

    expect(useAppStore.getState().isGenerating).toBe(true);
    expect(useAppStore.getState().currentGenerationId).toBe("gen-tool");

    act(() => {
      MockWebSocket.instance?.onmessage?.({
        data: JSON.stringify({
          type: "error",
          chatId: "chat-1",
          messageId: "a1",
          generationId: "gen-follow",
          message: "follow-up failed",
        }),
      });
    });

    expect(useAppStore.getState().isGenerating).toBe(false);
    globalThis.WebSocket = originalWebSocket;
  });

  it("removes an empty assistant when a cancelled stop has no content", () => {
    const originalWebSocket = globalThis.WebSocket;
    class MockWebSocket {
      static OPEN = 1;
      static instance: MockWebSocket | null = null;
      readyState = MockWebSocket.OPEN;
      onopen: (() => void) | null = null;
      onmessage: ((event: { data: string }) => void) | null = null;
      onclose: (() => void) | null = null;
      constructor() {
        MockWebSocket.instance = this;
      }
      send() {}
      close() {}
    }
    globalThis.WebSocket = MockWebSocket as unknown as typeof WebSocket;
    const timings = {
      tokens_cached: 0,
      tokens_evaluated: 0,
      predicted_ms: 0,
      predicted_n: 0,
      predicted_per_second: 0,
      predicted_per_token_ms: 0,
      prompt_ms: 0,
      prompt_n: 0,
      prompt_per_second: 0,
      prompt_per_token_ms: 0,
    };
    const placeholder = {
      id: "assistant-empty",
      chatId: "chat-1",
      role: "assistant" as const,
      content: "",
      rawContent: "",
      position: 1,
      createdAt: 1,
    };
    act(() => {
      useAppStore.setState({
        currentChatId: "chat-1",
        messages: [placeholder],
        isGenerating: true,
        isSyncingHistory: false,
      });
      useAppStore.getState().connectWs();
    });
    act(() => {
      MockWebSocket.instance?.onmessage?.({
        data: JSON.stringify({
          type: "stop",
          chatId: "chat-1",
          messageId: "assistant-empty",
          generationId: "gen-1",
          stopReason: "cancelled",
          timings,
        }),
      });
    });
    expect(useAppStore.getState().messages).toHaveLength(0);

    act(() => {
      useAppStore.setState({
        messages: [{ ...placeholder, id: "assistant-kept", content: "kept", rawContent: "kept" }],
        isGenerating: true,
      });
    });
    act(() => {
      MockWebSocket.instance?.onmessage?.({
        data: JSON.stringify({
          type: "stop",
          chatId: "chat-1",
          messageId: "assistant-kept",
          generationId: "gen-2",
          stopReason: "cancelled",
          fullContent: "kept going",
          timings,
        }),
      });
    });
    expect(useAppStore.getState().messages.map((message) => message.content)).toEqual([
      "kept going",
    ]);
    globalThis.WebSocket = originalWebSocket;
  });

  it("keeps at most 5000 log lines and preserves order after a chunk trim", () => {
    const logs = Array.from({ length: 5000 }, (_, index) => `line-${index}`);
    act(() => {
      useAppStore.setState({ logs });
    });
    act(() => {
      useAppStore.getState().addLog("info", "newest");
    });
    const stored = useAppStore.getState().logs;
    expect(stored.length).toBeLessThanOrEqual(5000);
    expect(stored[0]).toBe("line-500");
    expect(stored.at(-1)).toBe("[info] newest");
    expect(stored[1]).toBe("line-501");
  });
});
