/**
 * @packageDocumentation
 * Global state management for the LlamaForge client using Zustand.
 * Orchestrates WebSocket communication, chat session management, and server interaction.
 */

import type {
  ChatMessage,
  HardwareInfo,
  LlamaServerStatus,
  ModelEntry,
  ModelLoadConfig,
  WsFrame,
} from "@shared/types.js";
import { create } from "zustand";
import { logError, logInfo } from "./logger";

/**
 * A notification object for user-facing alerts.
 */
interface Notification {
  /** Unique identifier for the notification. */
  id: string;
  /** Main message text. */
  message: string;
  /** Visual type for styling. */
  type: "error" | "info" | "success";
  /** Optional CTA label. */
  actionLabel?: string | undefined;
  /** Optional callback for the action. */
  action?: (() => void) | undefined;
}

/**
 * The main application state interface.
 */
interface AppState {
  // Server State
  /** Current hardware capabilities detected by the backend. */
  hardware: HardwareInfo | null;
  /** Lifecycle state of the llama-server process. */
  serverStatus: LlamaServerStatus;
  /** List of all models found in the models directory. */
  models: ModelEntry[];
  /** Reference to the currently loaded model, if any. */
  loadedModel: ModelEntry | null;
  /** WebSocket connection status. */
  isConnected: boolean;
  /** Circular buffer of server logs. */
  logs: string[];

  // Active Chat State
  /** Messages in the currently active chat view. */
  messages: ChatMessage[];
  /** UUID of the active chat session. */
  currentChatId: string | null;
  /** Metadata for active chat session (avoids double fetching) */
  currentChatMetadata: {
    systemPresetId?: string | null;
    inferencePresetId?: string | null;
    name?: string | null;
  } | null;
  /** Whether a generation is currently in progress. */
  isGenerating: boolean;
  /** Real-time statistics for the ongoing or last generation. */
  generationStats: {
    tokensCached: number;
    totalPredicted: number;
    tokensEvaluated?: number;
    promptTokens?: number;
    contextSize?: number;
    stopReason?: string | undefined;
  } | null;
  /** ID of the active generation session for the current chat. */
  currentGenerationId: string | null;
  /** Cache hit/miss statistics for the active chat. */
  promptCacheStats: { totalEvaluated: number; totalCached: number } | null;
  /** Total number of messages in the active chat (may differ from messages.length when paginated). */
  totalMessages: number;
  /** IDs of chats that have received updates while hidden. */
  unreadChatIds: string[];
  /** Whether the client should attempt reconnects after WebSocket closes. */
  shouldReconnect: boolean;
  /** Global error state for blocking overlays. */
  errorMessage: string | null;
  /** Optional label for error retry/action. */
  errorActionLabel: string | null;
  /** Optional callback for error retry/action. */
  errorAction: (() => void) | null;
  /** List of active toast notifications. */
  notifications: Notification[];

  // Methods
  /** Sets a global error state. */
  setError: (
    message: string | null,
    actionLabel?: string | null,
    action?: (() => void) | null,
  ) => void;
  /** Clears the global error state. */
  clearError: () => void;
  /** Adds a new toast notification. */
  addNotification: (
    message: string,
    type?: "error" | "info" | "success",
    actionLabel?: string,
    action?: () => void,
  ) => void;
  /** Removes a notification by ID. */
  removeNotification: (id: string) => void;
  /** Adds a local log message to the UI console. */
  addLog: (level: "info" | "warn" | "error" | "debug" | "server", body: string) => void;
  /** Establishes or re-establishes the WebSocket connection. */
  connectWs: (manual?: boolean) => void;
  /** Disconnects the WebSocket and suppresses automatic reconnect attempts. */
  disconnectWs: () => void;
  /** Clears unread activity for a chat. */
  clearUnreadChat: (chatId: string) => void;
  /** Sends a message to the active chat via the streamProxy. */
  sendMessage: (content: string, files?: File[]) => void;
  /** Interrupts an ongoing generation. */
  stopGeneration: () => void;
  /** Loads a chat session and its message history from the backend. */
  loadChat: (chatId: string) => Promise<void>;
  /** Clears active chat state. */
  unloadChat: () => void;
  /** Fetches hardware info from the API. */
  fetchHardware: () => Promise<void>;
  /** Triggers a scan and fetch of available models. */
  fetchModels: () => Promise<void>;
  /** Refreshes server and model load status. */
  fetchServerStatus: () => Promise<void>;
  /** Fetches prompt cache statistics for a specific chat. */
  fetchPromptCacheStats: (chatId: string) => Promise<void>;
  /** Spawns the llama-server process with the given configuration. */
  loadModel: (config: ModelLoadConfig) => Promise<void>;
  /** Loads older messages for the current chat (M10 pagination). */
  loadMoreMessages: () => Promise<void>;
  /** Terminates the active llama-server process. */
  unloadModel: () => Promise<void>;
  /** Sends a tool call resolution (approval/rejection) back to the server. */
  approveToolCall: (
    messageId: string,
    toolCallId: string,
    approved: boolean,
    editedArguments?: string,
  ) => void;
}

let ws: WebSocket | null = null;
let currentReconnectDelay = 2000;
const MAX_RECONNECT_DELAY = 30000;
let reconnectTimer: number | null = null;
const pendingChatFrames = new Map<string, WsFrame[]>();
// M6 fix: guard against duplicate sends from rapid clicks
let sendInProgress = false;
let loadingDefaultChatLock = false;

function frameHasChatId(frame: WsFrame): frame is WsFrame & { chatId: string } {
  const chatIdValue = (frame as { chatId?: string }).chatId;
  return typeof chatIdValue === "string" && chatIdValue.length > 0;
}

function bufferChatFrame(frame: WsFrame) {
  if (!frameHasChatId(frame)) return;
  const queued = pendingChatFrames.get(frame.chatId) || [];
  queued.push(frame);
  pendingChatFrames.set(frame.chatId, queued);
}

function applyPendingChatFrames(
  chatId: string,
  messages: ChatMessage[],
): { messages: ChatMessage[]; stillGenerating: boolean } {
  const pending = pendingChatFrames.get(chatId);
  if (!pending?.length) return { messages, stillGenerating: false };

  const nextMessages = [...messages];
  // Q2 fix: track whether the buffered frames include a stop frame.
  // If no stop frame was received, the generation is still in-flight.
  let sawTokens = false;
  let sawStop = false;

  for (const frame of pending) {
    if (frame.type === "message") {
      if (!nextMessages.some((m) => m.id === frame.message.id)) {
        nextMessages.push(frame.message);
      }
    }
    if (frame.type === "token") {
      sawTokens = true;
      const idx = nextMessages.findIndex((m) => m.id === frame.messageId);
      if (idx >= 0) {
        const message = { ...nextMessages[idx] } as ChatMessage;
        message.content += frame.delta;
        message.rawContent += frame.delta;
        if (frame.thinkingDelta !== undefined) {
          message.thinkingContent = (message.thinkingContent || "") + frame.thinkingDelta;
        }
        nextMessages[idx] = message;
      }
    }
    if (frame.type === "stop") {
      sawStop = true;
      const idx = nextMessages.findIndex((m) => m.id === frame.messageId);
      if (idx >= 0) {
        const message = { ...nextMessages[idx] } as ChatMessage;
        if (frame.fullContent !== undefined) message.content = frame.fullContent;
        if (frame.fullRawContent !== undefined) message.rawContent = frame.fullRawContent;
        if (frame.fullThinking !== undefined) message.thinkingContent = frame.fullThinking;
        nextMessages[idx] = message;
      }
    }
    if (frame.type === "tool_call") {
      const idx = nextMessages.findIndex((m) => m.id === frame.messageId);
      if (idx >= 0) {
        const message = { ...nextMessages[idx] } as ChatMessage;
        message.toolCallsJson = JSON.stringify(frame.toolCalls);
        nextMessages[idx] = message;
      }
    }
  }

  pendingChatFrames.delete(chatId);
  return { messages: nextMessages, stillGenerating: sawTokens && !sawStop };
}

/**
 * Main application hook for accessing the global Zustand store.
 * Manages server connectivity, model lifecycle, chat history, and UI state.
 */
export const useAppStore = create<AppState>((set, get) => ({
  hardware: null,
  serverStatus: "idle",
  models: [],
  loadedModel: null,
  isConnected: false,
  logs: [],
  messages: [],
  currentChatId: null,
  currentChatMetadata: null,
  isGenerating: false,
  currentGenerationId: null,
  generationStats: null,
  promptCacheStats: null,
  totalMessages: 0,
  unreadChatIds: [],
  shouldReconnect: true,
  errorMessage: null,
  errorActionLabel: null,
  errorAction: null,
  notifications: [],

  setError: (
    message: string | null,
    actionLabel: string | null = null,
    action: (() => void) | null = null,
  ) => set({ errorMessage: message, errorActionLabel: actionLabel, errorAction: action }),
  clearError: () => set({ errorMessage: null, errorActionLabel: null, errorAction: null }),
  addNotification: (message, type = "error", actionLabel, action) => {
    const id = crypto.randomUUID();
    set((state) => {
      const next: Notification[] = [
        ...state.notifications,
        { id, message, type, actionLabel, action },
      ];
      return { notifications: next.slice(-4) };
    });
    setTimeout(() => get().removeNotification(id), 4500);
  },
  removeNotification: (id) =>
    set((state) => ({ notifications: state.notifications.filter((note) => note.id !== id) })),
  addLog: (level, body) =>
    set((state) => ({ logs: [...state.logs.slice(-100), `[${level}] ${body}`] })),
  clearUnreadChat: (chatId) =>
    set((state) => ({ unreadChatIds: state.unreadChatIds.filter((id) => id !== chatId) })),

  connectWs: (manual = true) => {
    if (!manual && !get().shouldReconnect) return;
    if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) return;

    if (reconnectTimer !== null) {
      window.clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }

    set({ shouldReconnect: true });

    // In dev we proxy /ws, in prod we might need absolute URL based on location
    const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
    const wsUrl = `${protocol}//${window.location.host}/ws`;

    ws = new WebSocket(wsUrl);

    ws.onopen = () => {
      currentReconnectDelay = 2000;
      set({ isConnected: true, errorMessage: null, errorActionLabel: null, errorAction: null });
      logInfo("WS connected");
    };

    ws.onerror = () => {
      set({
        isConnected: false,
        isGenerating: false,
        currentGenerationId: null,
        errorMessage: "WebSocket connection error.",
        errorActionLabel: "Retry",
        errorAction: () => get().connectWs(),
      });
    };

    ws.onclose = () => {
      const shouldReconnect = get().shouldReconnect;
      ws = null;
      set({
        isConnected: false,
        isGenerating: false,
        currentGenerationId: null,
      });
      if (shouldReconnect) {
        set({
          errorMessage: `WebSocket disconnected. Reconnecting in ${currentReconnectDelay / 1000}s...`,
          errorActionLabel: "Retry",
          errorAction: () => get().connectWs(),
        });
        logInfo(`WS disconnected, reconnecting in ${currentReconnectDelay}ms...`);
        reconnectTimer = window.setTimeout(() => {
          reconnectTimer = null;
          get().connectWs(false);
        }, currentReconnectDelay);
        currentReconnectDelay = Math.min(currentReconnectDelay * 1.5, MAX_RECONNECT_DELAY);
      } else {
        set({ errorMessage: null, errorActionLabel: null, errorAction: null });
      }
    };

    ws.onmessage = (event) => {
      let frame: WsFrame;
      try {
        frame = JSON.parse(event.data) as WsFrame;
      } catch (err) {
        logError("Failed to parse WS message", err);
        return;
      }

      try {
        if (frame.type === "server_status") {
          const prevStatus = get().serverStatus;
          const prevLoadedModel = get().loadedModel;
          set({ serverStatus: frame.status });
          if (
            frame.status !== prevStatus ||
            (frame.status === "running" && prevLoadedModel === null)
          ) {
            void get().fetchServerStatus();
          }
        } else if (frame.type === "log") {
          set((state) => ({ logs: [...state.logs.slice(-100), `[${frame.level}] ${frame.body}`] }));
        } else if (frame.type === "token") {
          set((state) => {
            if (frame.chatId && frame.chatId !== state.currentChatId) {
              bufferChatFrame(frame);
              return {
                ...state,
                unreadChatIds:
                  state.currentChatId === frame.chatId
                    ? state.unreadChatIds
                    : [...new Set([...state.unreadChatIds, frame.chatId])],
              };
            }
            const messages = [...state.messages];
            const lastMsg = messages[messages.length - 1];
            const stats = {
              tokensCached: frame.tokensCached ?? state.generationStats?.tokensCached ?? 0,
              totalPredicted: (state.generationStats?.totalPredicted ?? 0) + 1,
              tokensEvaluated: state.generationStats?.tokensEvaluated ?? 0,
              promptTokens: frame.promptTokens ?? state.generationStats?.promptTokens ?? 0,
              contextSize: frame.contextSize ?? state.generationStats?.contextSize ?? 0,
              stopReason: state.generationStats?.stopReason,
            };

            if (lastMsg && lastMsg.role === "assistant") {
              const nextMsg = { ...lastMsg };
              nextMsg.content += frame.delta;
              nextMsg.rawContent += frame.delta;
              if (frame.thinkingDelta !== undefined) {
                nextMsg.thinkingContent = (nextMsg.thinkingContent || "") + frame.thinkingDelta;
              }
              messages[messages.length - 1] = nextMsg;
            } else {
              messages.push({
                id: frame.messageId,
                chatId: frame.chatId,
                role: "assistant",
                content: frame.delta,
                rawContent: frame.delta,
                thinkingContent: frame.thinkingDelta ?? undefined,
                position: messages.length,
                createdAt: Date.now(),
              });
            }
            return {
              messages,
              isGenerating: true,
              generationStats: stats,
              currentGenerationId: frame.generationId ?? state.currentGenerationId,
            };
          });
        } else if (frame.type === "stop") {
          set((state) => {
            if (frame.chatId && frame.chatId !== state.currentChatId) {
              bufferChatFrame(frame);
              return {
                ...state,
                unreadChatIds:
                  state.currentChatId === frame.chatId
                    ? state.unreadChatIds
                    : [...new Set([...state.unreadChatIds, frame.chatId])],
              };
            }
            const nextMessages = [...state.messages];
            const lastMsg = nextMessages[nextMessages.length - 1];
            if (lastMsg && lastMsg.id === frame.messageId) {
              if (frame.fullContent !== undefined) lastMsg.content = frame.fullContent;
              if (frame.fullRawContent !== undefined) lastMsg.rawContent = frame.fullRawContent;
              if (frame.fullThinking !== undefined) lastMsg.thinkingContent = frame.fullThinking;
            }
            return {
              isGenerating: false,
              currentGenerationId: null,
              messages: nextMessages,
              generationStats: {
                tokensCached: frame.timings.tokens_cached,
                totalPredicted: frame.timings.predicted_n,
                tokensEvaluated: frame.timings.tokens_evaluated,
                promptTokens: frame.promptTokens ?? state.generationStats?.promptTokens ?? 0,
                contextSize: frame.contextSize ?? state.generationStats?.contextSize ?? 0,
                stopReason: frame.stopReason,
              },
            };
          });
          const currentChatId = get().currentChatId;
          if (currentChatId) {
            get().fetchPromptCacheStats(currentChatId);
          }
        } else if (frame.type === "tool_call") {
          set((state) => {
            if (frame.chatId && frame.chatId !== state.currentChatId) {
              bufferChatFrame(frame);
              return {
                ...state,
                unreadChatIds:
                  state.currentChatId === frame.chatId
                    ? state.unreadChatIds
                    : [...new Set([...state.unreadChatIds, frame.chatId])],
              };
            }
            const messages = [...state.messages];
            const lastMsg = messages[messages.length - 1];
            if (lastMsg && lastMsg.role === "assistant" && lastMsg.id === frame.messageId) {
              lastMsg.toolCallsJson = JSON.stringify(frame.toolCalls);
            }
            return { messages, isGenerating: false };
          });
        } else if (frame.type === "message") {
          set((state) => {
            if (state.currentChatId === frame.chatId) {
              // S1 fix: Replace any optimistic temp-* message with the server-confirmed one
              const reconciled = state.messages.filter(
                (m) => !(m.id.startsWith("temp-") && m.role === frame.message.role),
              );
              if (!reconciled.some((m) => m.id === frame.message.id)) {
                reconciled.push(frame.message);
              }
              return { messages: reconciled };
            }
            bufferChatFrame(frame);
            return {
              ...state,
              unreadChatIds: frame.chatId
                ? state.currentChatId === frame.chatId
                  ? state.unreadChatIds
                  : [...new Set([...state.unreadChatIds, frame.chatId])]
                : state.unreadChatIds,
            };
          });
        } else if (frame.type === "autoname_result") {
          // S2 fix: Update local chat metadata if this is the current chat
          set((state) => {
            if (state.currentChatId === frame.chatId && state.currentChatMetadata) {
              return {
                currentChatMetadata: {
                  ...state.currentChatMetadata,
                  name: frame.name,
                },
              };
            }
            return state;
          });
          // S2 fix: Dispatch a custom event so React Query providers can invalidate the chats query
          window.dispatchEvent(new CustomEvent("llamaforge:chats-invalidate"));
        } else if (frame.type === "presets_updated") {
          window.dispatchEvent(new CustomEvent("llamaforge:presets-invalidate"));
        } else if (frame.type === "error") {
          logError("WS Error frame:", frame.message);
          set({
            isGenerating: false,
            currentGenerationId: null,
            errorMessage: frame.message || "An unknown error occurred during generation.",
          });
        }
      } catch (err) {
        logError("Error processing WS frame:", err);
      }
    };
  },

  sendMessage: async (content: string, files?: File[]) => {
    const state = get();
    const chatId = state.currentChatId;
    if (!chatId) {
      set({ errorMessage: "Unable to send message: no chat selected." });
      return;
    }
    if (content.length > 25000) {
      set({ errorMessage: "Message content exceeds maximum length of 25,000 characters." });
      return;
    }
    // M6 fix: prevent duplicate sends from rapid double-clicks
    if (sendInProgress) {
      return;
    }
    sendInProgress = true;
    if (files?.length && files.length > 5) {
      sendInProgress = false;
      set({ errorMessage: "A maximum of 5 attachments is supported per message." });
      return;
    }
    if (files?.some((f) => f.size > 10 * 1024 * 1024)) {
      sendInProgress = false;
      set({ errorMessage: "Attachments must be 10MB or smaller." });
      return;
    }
    const optimisticMessageId = `temp-${crypto.randomUUID()}`;
    set((s) => ({
      messages: [
        ...s.messages,
        {
          id: optimisticMessageId,
          chatId: chatId,
          role: "user" as const,
          content:
            content +
            (files?.length ? `\n\n[Attachments: ${files.map((f) => f.name).join(", ")}]` : ""),
          rawContent: content,
          position: s.messages.length,
          createdAt: Date.now(),
        },
      ],
      isGenerating: true,
      generationStats: null,
    }));

    try {
      let res: Response;
      if (files?.length) {
        const formData = new FormData();
        formData.append("content", content);
        for (const f of files) {
          formData.append("file", f);
        }

        res = await fetch(`/api/chats/${chatId}/messages`, {
          method: "POST",
          body: formData,
        });
      } else {
        res = await fetch(`/api/chats/${chatId}/messages`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ content }),
        });
      }

      if (!res.ok) {
        const errorBody = await res.text().catch(() => "");
        throw new Error(`Server returned ${res.status}${errorBody ? `: ${errorBody}` : ""}`);
      }
      set({ errorMessage: null });
    } catch (err: unknown) {
      set((s) => ({
        messages: s.messages.filter((msg) => msg.id !== optimisticMessageId),
        isGenerating: false,
        errorMessage: err instanceof Error ? err.message : "Message send failed.",
      }));
    } finally {
      // M6 fix: always clear the send guard
      sendInProgress = false;
    }
  },

  stopGeneration: () => {
    const state = get();
    if (!state.isGenerating || !state.currentChatId) return;
    set({ isGenerating: false });

    const lastMsg = state.messages[state.messages.length - 1];
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(
        JSON.stringify({
          type: "cancel",
          chatId: state.currentChatId,
          messageId:
            lastMsg && lastMsg.role === "assistant"
              ? lastMsg.id
              : (state.currentGenerationId ?? undefined),
          generationId: state.currentGenerationId ?? undefined,
        }),
      );
    }
  },

  disconnectWs: () => {
    set({
      shouldReconnect: false,
      isConnected: false,
      isGenerating: false,
      currentGenerationId: null,
    });
    if (reconnectTimer !== null) {
      window.clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }
    if (ws && ws.readyState !== WebSocket.CLOSED) {
      ws.close(1000, "Client initiated disconnect");
    }
  },

  loadChat: async (chatId: string) => {
    try {
      const res = await fetch(`/api/chats/${chatId}`);
      if (res.ok) {
        const chat = await res.json();
        // Q2 fix: destructure both messages and stillGenerating flag so that
        // switching back to a chat with an active generation restores the stop button.
        const { messages, stillGenerating } = applyPendingChatFrames(chatId, chat.messages || []);
        set((state) => ({
          currentChatId: chatId,
          messages,
          totalMessages: chat.totalMessages ?? messages.length,
          isGenerating: stillGenerating,
          currentChatMetadata: {
            name: chat.name,
            systemPresetId: chat.systemPresetId,
            inferencePresetId: chat.inferencePresetId,
          },
          unreadChatIds: state.unreadChatIds.filter((id) => id !== chatId),
          errorMessage: null,
        }));
      } else if (chatId === "default-chat") {
        if (loadingDefaultChatLock) return;
        loadingDefaultChatLock = true;
        try {
          const createRes = await fetch("/api/chats", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ name: "New Chat" }),
          });
          if (createRes.ok) {
            const chat = await createRes.json();
            set({
              currentChatId: chat.id,
              messages: [],
              currentChatMetadata: {
                name: chat.name,
                systemPresetId: chat.systemPresetId,
                inferencePresetId: chat.inferencePresetId,
              },
              errorMessage: null,
            });
          } else {
            const errorBody = await createRes.text().catch(() => "");
            set({
              errorMessage: `Unable to create default chat: ${createRes.status}${errorBody ? `: ${errorBody}` : ""}`,
            });
          }
        } finally {
          loadingDefaultChatLock = false;
        }
      } else {
        get().setError(`Unable to load chat: ${res.statusText || res.status}`, "Retry", () =>
          get().loadChat(chatId),
        );
      }
    } catch (e: unknown) {
      logError("Fetch chat failed", e);
      get().setError(e instanceof Error ? e.message : "Failed to load chat.", "Retry", () =>
        get().loadChat(chatId),
      );
    }
  },

  unloadChat: () =>
    set({
      currentChatId: null,
      currentChatMetadata: null,
      messages: [],
      generationStats: null,
      totalMessages: 0,
    }),

  loadMoreMessages: async () => {
    const state = get();
    if (!state.currentChatId) return;
    // M10 fix: load the next page of older messages, prepending them to the array.
    const currentCount = state.messages.length;
    if (currentCount >= state.totalMessages) return;
    const offset = currentCount;
    try {
      const res = await fetch(
        `/api/chats/${state.currentChatId}?messageLimit=500&messageOffset=${offset}`,
      );
      if (!res.ok) return;
      const chat = await res.json();
      const olderMessages = (chat.messages || []) as ChatMessage[];
      if (olderMessages.length === 0) return;
      set((s) => {
        // Prepend older messages, deduplicating by ID
        const existingIds = new Set(s.messages.map((m) => m.id));
        const unique = olderMessages.filter((m) => !existingIds.has(m.id));
        return {
          messages: [...unique, ...s.messages],
          totalMessages: chat.totalMessages ?? s.totalMessages,
        };
      });
    } catch (e) {
      logError("Failed to load more messages", e);
    }
  },

  fetchHardware: async () => {
    try {
      const res = await fetch("/api/hardware");
      if (res.ok) {
        const hardware = await res.json();
        set({ hardware, errorMessage: null });
      } else {
        const errorBody = await res.text().catch(() => "");
        get().addNotification(
          `Failed to fetch hardware: ${res.status}${errorBody ? `: ${errorBody}` : ""}`,
          "error",
          "Retry",
          () => get().fetchHardware(),
        );
      }
    } catch (e: unknown) {
      logError("Fetch hardware failed", e);
      get().addNotification(
        e instanceof Error ? e.message : "Failed to fetch hardware.",
        "error",
        "Retry",
        () => get().fetchHardware(),
      );
    }
  },

  fetchModels: async () => {
    try {
      const res = await fetch("/api/models");
      if (res.ok) {
        const models = await res.json();
        set({ models, errorMessage: null });
      } else {
        const errorBody = await res.text().catch(() => "");
        get().addNotification(
          `Failed to fetch models: ${res.status}${errorBody ? `: ${errorBody}` : ""}`,
          "error",
          "Retry",
          () => get().fetchModels(),
        );
      }
    } catch (e: unknown) {
      logError("Fetch models failed", e);
      get().addNotification(
        e instanceof Error ? e.message : "Failed to fetch models.",
        "error",
        "Retry",
        () => get().fetchModels(),
      );
    }
  },

  fetchServerStatus: async () => {
    try {
      const res = await fetch("/api/server/status");
      if (res.ok) {
        const data = await res.json();
        set((state) => {
          const modelPath = data.config?.modelPath;
          let loadedModel = null;
          if (modelPath) {
            loadedModel = state.models.find((m) => m.primaryPath === modelPath) || {
              publisher: "unknown",
              modelName: modelPath.split(/[/\\]/).pop() || modelPath,
              primaryPath: modelPath,
              metadata: undefined,
            };
          }
          return { serverStatus: data.status, loadedModel, errorMessage: null };
        });
      } else {
        const errorBody = await res.text().catch(() => "");
        get().addNotification(
          `Failed to fetch server status: ${res.status}${errorBody ? `: ${errorBody}` : ""}`,
          "error",
          "Retry",
          () => get().fetchServerStatus(),
        );
      }
    } catch (e: unknown) {
      logError("Fetch server status failed", e);
      get().addNotification(
        e instanceof Error ? e.message : "Failed to fetch server status.",
        "error",
        "Retry",
        () => get().fetchServerStatus(),
      );
    }
  },

  fetchPromptCacheStats: async (chatId: string) => {
    try {
      const res = await fetch(`/api/chats/${chatId}/prompt-cache`);
      if (res.ok) {
        const promptCacheStats = await res.json();
        set({ promptCacheStats, errorMessage: null });
      } else {
        const errorBody = await res.text().catch(() => "");
        get().addNotification(
          `Failed to fetch prompt cache stats: ${res.status}${errorBody ? `: ${errorBody}` : ""}`,
          "error",
        );
      }
    } catch (e: unknown) {
      logError("Fetch prompt cache stats failed", e);
      get().addNotification(
        e instanceof Error ? e.message : "Failed to fetch prompt cache stats.",
        "error",
      );
    }
  },

  loadModel: async (config: ModelLoadConfig) => {
    set({ serverStatus: "loading" });
    try {
      const res = await fetch("/api/server/load", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(config),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        const errorMessage = body?.error
          ? String(body.error)
          : `Failed to load model: ${res.status}`;
        const action =
          res.status === 503 && body?.code === "NOT_CONFIGURED"
            ? () =>
                import("./uiStore").then((m) =>
                  m.useUiStore.getState().setRightPanelView("settings"),
                )
            : null;
        set({ serverStatus: "idle" });
        get().setError(errorMessage, action ? "Settings" : null, action);
      } else {
        set({ errorMessage: null, errorActionLabel: null, errorAction: null });
        await get().fetchServerStatus();
      }
    } catch (e: unknown) {
      set({
        serverStatus: "idle",
        errorMessage: e instanceof Error ? e.message : "Model load failed.",
      });
    }
  },

  unloadModel: async () => {
    try {
      const res = await fetch("/api/server/unload", { method: "POST" });
      if (res.ok) {
        set({ serverStatus: "idle", errorMessage: null });
      } else {
        const errorBody = await res.text().catch(() => "");
        get().addNotification(
          `Failed to unload model: ${res.status}${errorBody ? `: ${errorBody}` : ""}`,
          "error",
          "Retry",
          () => get().unloadModel(),
        );
      }
    } catch (e: unknown) {
      logError("Unload failed", e);
      get().addNotification(
        e instanceof Error ? e.message : "Model unload failed.",
        "error",
        "Retry",
        () => get().unloadModel(),
      );
    }
  },

  approveToolCall: (
    messageId: string,
    toolCallId: string,
    approved: boolean,
    editedArguments?: string,
  ) => {
    const state = get();
    if (ws && ws.readyState === WebSocket.OPEN && state.currentChatId) {
      ws.send(
        JSON.stringify({
          type: "tool_approval",
          chatId: state.currentChatId,
          messageId,
          toolCallId,
          approved,
          editedArguments,
        }),
      );
    }
  },
}));
