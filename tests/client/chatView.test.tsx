/**
 * @packageDocumentation
 * Tests for the chat view and input bar component rendering.
 */

import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import type { ChatMessage } from "@shared/types";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { StrictMode, type ReactNode } from "react";
import { InputBar } from "../../src/client/components/chat/InputBar";
import { useAppStore } from "../../src/client/store";
import { asFetch } from "../fixtures";

mock.module("react-dropzone", () => ({
  useDropzone: () => ({
    getRootProps: () => ({}),
    getInputProps: () => ({}),
    isDragActive: false,
    open: () => {},
  }),
}));

mock.module("@tanstack/react-router", () => ({
  useParams: () => ({ chatId: "chat-loop-1" }),
  useNavigate: () => mock(),
  useLocation: () => ({ pathname: "/chat/chat-loop-1" }),
  Link: ({ children }: { children?: ReactNode }) => <a href="#test">{children}</a>,
  Outlet: () => <div data-testid="outlet">Mock Outlet</div>,
}));

const inferencePreset = {
  id: "qwen-default",
  name: "Qwen Default",
  sourceModelPath: "/models/qwen.gguf",
  isDefault: true,
  temperature: 0.7,
  topK: 40,
  topP: 0.9,
  minP: 0.05,
  repeatPenalty: 1.1,
  repeatLastN: 64,
  typicalP: 1,
  presencePenalty: 0,
  frequencyPenalty: 0,
  mirostat: 0,
  mirostatTau: 5,
  mirostatEta: 0.1,
  dynaTempRange: 0,
  dynaTempExponent: 1,
  seed: -1,
  maxTokens: -1,
  stopStrings: [],
  toolCallsEnabled: false,
  tools: [],
  structuredOutput: undefined,
  createdAt: 1,
  updatedAt: 1,
};

describe("InputBar component", () => {
  afterEach(() => {
    cleanup();
  });

  it("renders textarea correctly", async () => {
    render(<InputBar onSend={() => {}} onStop={() => {}} isActive={true} isGenerating={false} />);
    const textarea = await screen.findByPlaceholderText("Type your message...");
    expect(textarea).not.toBeNull();
  });
});

describe("ChatView inference preset bind", () => {
  let originalFetch: typeof global.fetch;
  let putCount: number;
  let ChatView: typeof import("../../src/client/components/chat/ChatView").ChatView;

  beforeEach(async () => {
    originalFetch = global.fetch;
    putCount = 0;
    global.fetch = asFetch(
      mock((input, init) => {
        const url = typeof input === "string" ? input : input.url;
        const method = (init?.method ?? "GET").toUpperCase();
        if (method === "PUT" && String(url).includes("/api/chats/")) {
          putCount += 1;
          return new Promise((resolve) => {
            setTimeout(() => {
              resolve(
                new Response(JSON.stringify({ success: true }), {
                  status: 200,
                  headers: { "Content-Type": "application/json" },
                }),
              );
            }, 25);
          });
        }
        if (String(url).includes("/api/presets/inference")) {
          return Promise.resolve(
            new Response(JSON.stringify([inferencePreset]), {
              status: 200,
              headers: { "Content-Type": "application/json" },
            }),
          );
        }
        if (String(url).includes("/api/presets/system") || String(url).includes("/api/settings")) {
          return Promise.resolve(
            new Response(JSON.stringify(String(url).includes("/api/settings") ? {} : []), {
              status: 200,
              headers: { "Content-Type": "application/json" },
            }),
          );
        }
        return Promise.resolve(
          new Response(JSON.stringify({}), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          }),
        );
      }),
    );

    useAppStore.setState({
      currentChatId: "chat-loop-1",
      currentChatMetadata: {
        name: "New Chat",
        systemPresetId: null,
        inferencePresetId: null,
      },
      messages: [],
      totalMessages: 0,
      isGenerating: false,
      isWaitingForToolApproval: false,
      isConnected: true,
      serverStatus: "running",
      loadedModel: {
        publisher: "test",
        modelName: "Qwen Test",
        primaryPath: "/models/qwen.gguf",
      },
      errorMessage: null,
      loadChat: mock().mockResolvedValue(undefined),
      sendMessage: mock().mockResolvedValue(undefined),
      stopGeneration: mock(),
      unloadChat: mock(),
    });

    const imported = await import("../../src/client/components/chat/ChatView");
    ChatView = imported.ChatView;
  });

  afterEach(() => {
    cleanup();
    global.fetch = originalFetch;
  });

  it("persists the resolved inference preset once for a new chat instead of looping PUTs", async () => {
    const queryClient = new QueryClient({
      defaultOptions: {
        queries: { retry: false },
        mutations: { retry: false },
      },
    });

    await act(async () => {
      render(
        <StrictMode>
          <QueryClientProvider client={queryClient}>
            <ChatView />
          </QueryClientProvider>
        </StrictMode>,
      );
    });

    await waitFor(() => {
      expect(putCount).toBeGreaterThanOrEqual(1);
    });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 150));
    });

    expect(putCount).toBe(1);
    expect(useAppStore.getState().currentChatMetadata?.inferencePresetId).toBe("qwen-default");
  });
});

/**
 * Builds a minimal chat message for ChatView tests.
 *
 * @param overrides - Fields to apply on top of the default user-message fixture.
 * @returns A complete {@link ChatMessage}.
 */
function testMessage(
  overrides: Partial<ChatMessage> & Pick<ChatMessage, "id" | "role">,
): ChatMessage {
  return {
    chatId: "chat-loop-1",
    content: overrides.content ?? "hello.",
    rawContent: overrides.rawContent ?? overrides.content ?? "hello.",
    position: overrides.position ?? 1,
    createdAt: overrides.createdAt ?? 1,
    ...overrides,
  };
}

/**
 * Renders ChatView and drains the first React Query + effect cycle.
 *
 * Preset and settings queries resolve after the initial paint. Waiting here
 * keeps those ChatView updates inside Testing Library's `act` boundary.
 *
 * @param ChatView - Chat workspace component under test.
 * @returns No return value.
 */
async function renderChatView(
  ChatView: typeof import("../../src/client/components/chat/ChatView").ChatView,
): Promise<void> {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false },
      mutations: { retry: false },
    },
  });
  await act(async () => {
    render(
      <QueryClientProvider client={queryClient}>
        <ChatView />
      </QueryClientProvider>,
    );
    await Promise.resolve();
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

/**
 * Drains microtasks and one macrotask inside `act`.
 *
 * ChatView click handlers such as edit-save kick off promises (`onEdit`,
 * mutate, then `setIsEditing(false)`) that otherwise resolve after `act`
 * returns and warn that ChatView/MessageBubble updated without wrapping.
 *
 * @returns No return value.
 */
async function flushReactUpdates(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

describe("pending prompt regeneration helpers", () => {
  let getPendingPromptMessage: typeof import("../../src/client/components/chat/ChatView").getPendingPromptMessage;
  let regenerationRequiresBranch: typeof import("../../src/client/components/chat/ChatView").regenerationRequiresBranch;
  let messagesKeptForInPlaceRegenerate: typeof import("../../src/client/components/chat/ChatView").messagesKeptForInPlaceRegenerate;
  let messagesRemainingAfterDelete: typeof import("../../src/client/components/chat/ChatView").messagesRemainingAfterDelete;
  let totalMessagesAfterDrop: typeof import("../../src/client/components/chat/ChatView").totalMessagesAfterDrop;

  beforeEach(async () => {
    const imported = await import("../../src/client/components/chat/ChatView");
    getPendingPromptMessage = imported.getPendingPromptMessage;
    regenerationRequiresBranch = imported.regenerationRequiresBranch;
    messagesKeptForInPlaceRegenerate = imported.messagesKeptForInPlaceRegenerate;
    messagesRemainingAfterDelete = imported.messagesRemainingAfterDelete;
    totalMessagesAfterDrop = imported.totalMessagesAfterDrop;
  });
  it("treats a trailing user message as a pending prompt", () => {
    const user = testMessage({ id: "u1", role: "user" });
    expect(getPendingPromptMessage([user])?.id).toBe("u1");
  });

  it("ignores a trailing assistant reply", () => {
    expect(
      getPendingPromptMessage([
        testMessage({ id: "u1", role: "user" }),
        testMessage({ id: "a1", role: "assistant", content: "hi", position: 2, createdAt: 2 }),
      ]),
    ).toBeUndefined();
  });

  it("walks back past trailing tool rows to the last non-tool turn", () => {
    const pending = getPendingPromptMessage([
      testMessage({ id: "u1", role: "user" }),
      testMessage({
        id: "t1",
        role: "tool",
        content: "result",
        position: 2,
        createdAt: 2,
        toolCallId: "call-1",
      }),
    ]);
    expect(pending?.id).toBe("u1");
  });

  it("regenerates in place when no later user turn exists", () => {
    const messages = [
      testMessage({ id: "u1", role: "user" }),
      testMessage({ id: "a1", role: "assistant", content: "hi", position: 2, createdAt: 2 }),
    ];
    expect(regenerationRequiresBranch(messages, "u1")).toBe(false);
    expect(regenerationRequiresBranch(messages, "a1")).toBe(false);
    expect(regenerationRequiresBranch([testMessage({ id: "u1", role: "user" })], "u1")).toBe(false);
  });

  it("keeps only the user turn when regenerating in place", () => {
    const messages = [
      testMessage({ id: "u1", role: "user" }),
      testMessage({ id: "a1", role: "assistant", content: "old", position: 2, createdAt: 2 }),
      testMessage({ id: "a2", role: "assistant", content: "also old", position: 3, createdAt: 3 }),
    ];
    expect(messagesKeptForInPlaceRegenerate(messages, "u1").map((message) => message.id)).toEqual([
      "u1",
    ]);
    expect(messagesKeptForInPlaceRegenerate(messages, "a1").map((message) => message.id)).toEqual([
      "u1",
    ]);
    expect(messagesKeptForInPlaceRegenerate(messages, "a2").map((message) => message.id)).toEqual([
      "u1",
    ]);
  });

  it("drops the deleted message and every subsequent row", () => {
    const messages = [
      testMessage({ id: "u1", role: "user" }),
      testMessage({ id: "a1", role: "assistant", content: "hi", position: 2, createdAt: 2 }),
    ];
    expect(messagesRemainingAfterDelete(messages, "a1").map((message) => message.id)).toEqual([
      "u1",
    ]);
    expect(messagesRemainingAfterDelete(messages, "u1")).toEqual([]);
    expect(messagesRemainingAfterDelete(messages, "missing").map((message) => message.id)).toEqual([
      "u1",
      "a1",
    ]);
  });

  it("preserves unloaded older rows when dropping from the visible window", () => {
    expect(totalMessagesAfterDrop(600, 500, 499)).toBe(599);
    expect(totalMessagesAfterDrop(2, 2, 1)).toBe(1);
    expect(totalMessagesAfterDrop(0, 0, 0)).toBe(0);
  });

  it("branches when a later user turn would be discarded", () => {
    const messages = [
      testMessage({ id: "u1", role: "user" }),
      testMessage({ id: "a1", role: "assistant", content: "hi", position: 2, createdAt: 2 }),
      testMessage({ id: "u2", role: "user", content: "again", position: 3, createdAt: 3 }),
    ];
    expect(regenerationRequiresBranch(messages, "u1")).toBe(true);
    expect(regenerationRequiresBranch(messages, "a1")).toBe(true);
    expect(regenerationRequiresBranch(messages, "u2")).toBe(false);
  });
});

describe("ChatView generate response after deleted assistant reply", () => {
  let originalFetch: typeof global.fetch;
  let regenerateUrls: string[];
  let ChatView: typeof import("../../src/client/components/chat/ChatView").ChatView;

  beforeEach(async () => {
    originalFetch = global.fetch;
    regenerateUrls = [];
    global.fetch = asFetch(
      mock((input, init) => {
        const url = typeof input === "string" ? input : input.url;
        const method = (init?.method ?? "GET").toUpperCase();
        if (method === "POST" && String(url).includes("/regenerate")) {
          regenerateUrls.push(String(url));
          return Promise.resolve(
            new Response(JSON.stringify({ messageId: "a-new" }), {
              status: 200,
              headers: { "Content-Type": "application/json" },
            }),
          );
        }
        if (String(url).includes("/api/presets/inference")) {
          return Promise.resolve(
            new Response(JSON.stringify([inferencePreset]), {
              status: 200,
              headers: { "Content-Type": "application/json" },
            }),
          );
        }
        if (String(url).includes("/api/presets/system") || String(url).includes("/api/settings")) {
          return Promise.resolve(
            new Response(JSON.stringify(String(url).includes("/api/settings") ? {} : []), {
              status: 200,
              headers: { "Content-Type": "application/json" },
            }),
          );
        }
        return Promise.resolve(
          new Response(JSON.stringify({}), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          }),
        );
      }),
    );

    useAppStore.setState({
      currentChatId: "chat-loop-1",
      currentChatMetadata: {
        name: "New Chat",
        systemPresetId: null,
        inferencePresetId: "qwen-default",
      },
      messages: [testMessage({ id: "u1", role: "user", content: "hello." })],
      totalMessages: 1,
      isGenerating: false,
      isWaitingForToolApproval: false,
      isConnected: true,
      serverStatus: "running",
      loadedModel: {
        publisher: "test",
        modelName: "Qwen Test",
        primaryPath: "/models/qwen.gguf",
      },
      errorMessage: null,
      loadChat: mock().mockResolvedValue(undefined),
      sendMessage: mock().mockResolvedValue(undefined),
      stopGeneration: mock(),
      unloadChat: mock(),
    });

    const imported = await import("../../src/client/components/chat/ChatView");
    ChatView = imported.ChatView;
  });

  afterEach(() => {
    cleanup();
    global.fetch = originalFetch;
  });

  it("shows a generate-response control when the last message is a user turn", async () => {
    await renderChatView(ChatView);

    expect(screen.getByTestId("generate-response")).toBeTruthy();
    expect(screen.getByTitle("Generate response")).toBeTruthy();
  });

  it("hides the generate-response control when an assistant reply is already present", async () => {
    useAppStore.setState({
      messages: [
        testMessage({ id: "u1", role: "user", content: "hello." }),
        testMessage({
          id: "a1",
          role: "assistant",
          content: "Hi there.",
          position: 2,
          createdAt: 2,
        }),
      ],
      totalMessages: 2,
    });

    await renderChatView(ChatView);

    expect(screen.queryByTestId("generate-response")).toBeNull();
    expect(screen.getByTitle("Regenerate")).toBeTruthy();
  });

  it("posts an in-place regenerate when the generate-response control is used", async () => {
    await renderChatView(ChatView);

    await act(async () => {
      fireEvent.click(screen.getByTestId("generate-response"));
    });

    await waitFor(() => {
      expect(regenerateUrls.some((url) => url.includes("/api/chats/chat-loop-1/regenerate"))).toBe(
        true,
      );
    });
    expect(regenerateUrls.some((url) => url.includes("branch-and-regenerate"))).toBe(false);
  });
});

describe("ChatView in-place message actions", () => {
  let originalFetch: typeof global.fetch;
  let originalConfirm: typeof window.confirm;
  let regenerateUrls: string[];
  let deleteUrls: string[];
  let ChatView: typeof import("../../src/client/components/chat/ChatView").ChatView;

  beforeEach(async () => {
    originalFetch = global.fetch;
    originalConfirm = window.confirm;
    window.confirm = () => true;
    regenerateUrls = [];
    deleteUrls = [];
    global.fetch = asFetch(
      mock((input, init) => {
        const url = typeof input === "string" ? input : input.url;
        const method = (init?.method ?? "GET").toUpperCase();
        if (method === "POST" && String(url).includes("/regenerate")) {
          regenerateUrls.push(String(url));
          return Promise.resolve(
            new Response(JSON.stringify({ messageId: "a-new" }), {
              status: 200,
              headers: { "Content-Type": "application/json" },
            }),
          );
        }
        if (method === "DELETE" && String(url).includes("/messages/")) {
          deleteUrls.push(String(url));
          return Promise.resolve(
            new Response(JSON.stringify({ success: true }), {
              status: 200,
              headers: { "Content-Type": "application/json" },
            }),
          );
        }
        if (String(url).includes("/api/presets/inference")) {
          return Promise.resolve(
            new Response(JSON.stringify([inferencePreset]), {
              status: 200,
              headers: { "Content-Type": "application/json" },
            }),
          );
        }
        if (String(url).includes("/api/presets/system") || String(url).includes("/api/settings")) {
          return Promise.resolve(
            new Response(JSON.stringify(String(url).includes("/api/settings") ? {} : []), {
              status: 200,
              headers: { "Content-Type": "application/json" },
            }),
          );
        }
        if (method === "GET" && String(url).includes("/api/chats/chat-loop-1")) {
          return Promise.resolve(
            new Response(
              JSON.stringify({
                id: "chat-loop-1",
                name: "New Chat",
                messages: [testMessage({ id: "u1", role: "user", content: "hello." })],
                totalMessages: 1,
              }),
              { status: 200, headers: { "Content-Type": "application/json" } },
            ),
          );
        }
        return Promise.resolve(
          new Response(JSON.stringify({}), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          }),
        );
      }),
    );

    useAppStore.setState({
      currentChatId: "chat-loop-1",
      currentChatMetadata: {
        name: "New Chat",
        systemPresetId: null,
        inferencePresetId: "qwen-default",
      },
      messages: [
        testMessage({ id: "u1", role: "user", content: "hello." }),
        testMessage({
          id: "a1",
          role: "assistant",
          content: "Hi there.",
          position: 2,
          createdAt: 2,
        }),
      ],
      totalMessages: 2,
      isGenerating: false,
      isWaitingForToolApproval: false,
      isConnected: true,
      serverStatus: "running",
      loadedModel: {
        publisher: "test",
        modelName: "Qwen Test",
        primaryPath: "/models/qwen.gguf",
      },
      errorMessage: null,
      loadChat: mock().mockResolvedValue(undefined),
      sendMessage: mock().mockResolvedValue(undefined),
      stopGeneration: mock(),
      unloadChat: mock(),
    });

    const imported = await import("../../src/client/components/chat/ChatView");
    ChatView = imported.ChatView;
  });

  afterEach(() => {
    cleanup();
    global.fetch = originalFetch;
    window.confirm = originalConfirm;
  });

  it("drops the existing assistant locally before posting an in-place regenerate", async () => {
    await renderChatView(ChatView);

    await act(async () => {
      fireEvent.click(screen.getByTitle("Regenerate"));
    });

    await waitFor(() => {
      expect(regenerateUrls.some((url) => url.includes("/api/chats/chat-loop-1/regenerate"))).toBe(
        true,
      );
    });
    expect(regenerateUrls.some((url) => url.includes("branch-and-regenerate"))).toBe(false);
    expect(useAppStore.getState().messages.map((message) => message.id)).toEqual(["u1"]);
    expect(useAppStore.getState().isGenerating).toBe(true);
  });

  it("drops an assistant locally when its delete action is used", async () => {
    await renderChatView(ChatView);

    await act(async () => {
      const deleteButtons = screen.getAllByTitle("Delete this and subsequent");
      const assistantDelete = deleteButtons[deleteButtons.length - 1];
      if (!assistantDelete) throw new Error("expected an assistant delete button");
      fireEvent.click(assistantDelete);
    });

    await waitFor(() => {
      expect(deleteUrls.some((url) => url.endsWith("/messages/a1"))).toBe(true);
    });
    expect(useAppStore.getState().messages.map((message) => message.id)).toEqual(["u1"]);
  });

  it("does not drop messages locally when delete returns 404", async () => {
    global.fetch = asFetch(
      mock((input, init) => {
        const url = typeof input === "string" ? input : input.url;
        const method = (init?.method ?? "GET").toUpperCase();
        if (method === "DELETE" && String(url).includes("/messages/")) {
          deleteUrls.push(String(url));
          return Promise.resolve(
            new Response(JSON.stringify({ error: "Message not found" }), {
              status: 404,
              headers: { "Content-Type": "application/json" },
            }),
          );
        }
        if (String(url).includes("/api/presets/inference")) {
          return Promise.resolve(
            new Response(JSON.stringify([inferencePreset]), {
              status: 200,
              headers: { "Content-Type": "application/json" },
            }),
          );
        }
        if (String(url).includes("/api/presets/system") || String(url).includes("/api/settings")) {
          return Promise.resolve(
            new Response(JSON.stringify(String(url).includes("/api/settings") ? {} : []), {
              status: 200,
              headers: { "Content-Type": "application/json" },
            }),
          );
        }
        return Promise.resolve(
          new Response(JSON.stringify({}), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          }),
        );
      }),
    );

    await renderChatView(ChatView);

    await act(async () => {
      const deleteButtons = screen.getAllByTitle("Delete this and subsequent");
      const assistantDelete = deleteButtons[deleteButtons.length - 1];
      if (!assistantDelete) throw new Error("expected an assistant delete button");
      fireEvent.click(assistantDelete);
    });

    await waitFor(() => {
      expect(deleteUrls.some((url) => url.endsWith("/messages/a1"))).toBe(true);
    });
    expect(useAppStore.getState().messages.map((message) => message.id)).toEqual(["u1", "a1"]);
  });

  it("patches assistant text in the store after a successful edit save", async () => {
    await renderChatView(ChatView);

    const editButtons = screen.getAllByTitle("Edit");
    const assistantEdit = editButtons[editButtons.length - 1];
    if (!assistantEdit) throw new Error("expected an assistant edit button");
    await act(async () => {
      fireEvent.click(assistantEdit);
    });
    await act(async () => {
      fireEvent.change(screen.getByTestId("message-edit-textarea"), {
        target: { value: "Corrected assistant reply." },
      });
    });

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /save/i }));
    });
    await flushReactUpdates();

    await waitFor(() => {
      expect(useAppStore.getState().messages.find((message) => message.id === "a1")?.content).toBe(
        "Corrected assistant reply.",
      );
    });
  });

  it("saves an in-place user edit then regenerates without branching", async () => {
    await renderChatView(ChatView);

    const editButtons = screen.getAllByTitle("Edit");
    const userEdit = editButtons[0];
    if (!userEdit) throw new Error("expected a user edit button");
    await act(async () => {
      fireEvent.click(userEdit);
    });
    await act(async () => {
      fireEvent.change(screen.getByTestId("message-edit-textarea"), {
        target: { value: "Transcribe the audio attachment." },
      });
    });

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /save/i }));
    });
    await flushReactUpdates();

    await waitFor(() => {
      expect(regenerateUrls.some((url) => url.endsWith("/api/chats/chat-loop-1/regenerate"))).toBe(
        true,
      );
    });
    expect(regenerateUrls.some((url) => url.includes("branch-and-edit"))).toBe(false);
    expect(useAppStore.getState().messages.map((message) => message.id)).toEqual(["u1"]);
    expect(useAppStore.getState().messages[0]?.content).toBe("Transcribe the audio attachment.");
    expect(useAppStore.getState().isGenerating).toBe(true);
  });

  it("locks generating immediately when continuing the last assistant", async () => {
    await renderChatView(ChatView);

    await act(async () => {
      fireEvent.click(screen.getByTitle("Continue generation"));
    });

    expect(useAppStore.getState().isGenerating).toBe(true);
  });
});
