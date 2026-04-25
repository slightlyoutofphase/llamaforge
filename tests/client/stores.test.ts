import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import { act, cleanup } from "@testing-library/react";
import { useAppStore } from "../../src/client/store";
import { useUiStore } from "../../src/client/uiStore";

describe("stores logic", () => {
  beforeEach(() => {
    act(() => {
      useAppStore.setState({ serverStatus: "idle", isConnected: false });
    });
  });

  afterEach(() => {
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
    expect(state.notifications[0].message).toBe("Test Toast");
    expect(state.notifications[0].type).toBe("success");

    const id = state.notifications[0].id;
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

  it("sendMessage rolls back optimistic message on failure", async () => {
    const originalFetch = globalThis.fetch;
    const fetchMock = mock().mockResolvedValue(new Response(null, { status: 500 }));
    globalThis.fetch = fetchMock;

    act(() => {
      useAppStore.setState({ currentChatId: "chat-1", messages: [], isGenerating: false });
    });

    await act(async () => {
      await useAppStore.getState().sendMessage("Hello world");
    });

    const state = useAppStore.getState();
    expect(state.messages).toHaveLength(0);
    expect(state.isGenerating).toBe(false);
    expect(state.errorMessage).toContain("Server returned");

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
    globalThis.fetch = fetchMock;

    act(() => {
      useAppStore.setState({ currentChatId: "chat-1", messages: [], isGenerating: false });
    });

    const file = new File(["hello"], "test.txt", { type: "text/plain" });
    await act(async () => {
      await useAppStore.getState().sendMessage("Hello world", [file], [0]);
    });

    expect(capturedUrl).toBe("/api/chats/chat-1/messages");
    expect(capturedInit?.method).toBe("POST");
    expect(capturedInit?.headers).toBeUndefined();
    expect(capturedInit?.body).toBeInstanceOf(FormData);
    const body = capturedInit?.body as FormData;
    expect(body.get("content")).toBe("Hello world");
    expect(body.getAll("file")[0]).toBe(file);

    globalThis.fetch = originalFetch;
  });

  it("unloadModel resets server status on success", async () => {
    const originalFetch = globalThis.fetch;
    const fetchMock = mock().mockResolvedValue(new Response(null, { status: 200 }));
    globalThis.fetch = fetchMock;

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
    globalThis.fetch = fetchMock;

    const originalFetchServerStatus = useAppStore.getState().fetchServerStatus;
    const fetchServerStatusSpy = mock().mockResolvedValue(undefined);
    act(() => {
      useAppStore.setState({ fetchServerStatus: fetchServerStatusSpy });
    });

    await act(async () => {
      await useAppStore.getState().loadModel({
        modelPath: "/models/test.gguf",
        contextSize: 4096,
        contextShift: false,
        gpuLayers: 33,
        threads: 1,
        batchSize: 1,
        microBatchSize: 1,
        ropeScaling: "none",
        ropeFreqBase: 10000,
        ropeFreqScale: 1,
        kvCacheTypeK: "f16",
        kvCacheTypeV: "f16",
        mlock: false,
        noMmap: false,
        flashAttention: false,
      });
    });

    expect(fetchServerStatusSpy).toHaveBeenCalled();
    act(() => {
      useAppStore.setState({ fetchServerStatus: originalFetchServerStatus });
    });
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
    globalThis.fetch = fetchMock;

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
    globalThis.fetch = fetchMock;

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
      useAppStore.setState({ isConnected: true, isGenerating: true, shouldReconnect: true });
      disconnectWs();
    });

    const state = useAppStore.getState();
    expect(state.isConnected).toBe(false);
    expect(state.isGenerating).toBe(false);
    expect(state.currentGenerationId).toBeNull();
    expect(state.shouldReconnect).toBe(false);
  });
});
