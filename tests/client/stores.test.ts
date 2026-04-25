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
