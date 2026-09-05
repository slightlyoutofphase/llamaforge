/**
 * @packageDocumentation
 * Global state management for the LlamaForge client using Zustand.
 * Orchestrates WebSocket communication, chat session management, and server interaction.
 */

import { create } from "zustand";
import { buildMessageMetrics } from "../shared/generationMetrics";
import type {
  AppProcessUsage,
  ChatContextUsage,
  ChatMessage,
  HardwareInfo,
  LlamaServerStatus,
  LoadModelRequest,
  ModelEntry,
  ModelLoadConfig,
  WsFrame,
} from "../shared/types";
import { request } from "./http";
import { logDebug, logError, logInfo, logWarn } from "./logger";
import { useUiStore } from "./uiStore";

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
  /** Current load progress percentage while the server is starting. */
  loadProgress: number;
  /** Current load phase while the server is starting. */
  loadProgressPhase:
    "spawning" | "loading_weights" | "offloading" | "initializing" | "ready" | null;
  /** Human-readable detail for the current load step. */
  loadProgressDetail: string | null;
  /** List of all models found in the models directory. */
  models: ModelEntry[];
  /** Reference to the currently loaded model, if any. */
  loadedModel: ModelEntry | null;
  /** Load configuration of the currently running llama-server, if any. */
  loadedConfig: ModelLoadConfig | null;
  /** Token occupancy of the currently selected conversation. */
  contextUsage: ChatContextUsage | null;
  /** RAM and VRAM consumed by LlamaForge processes. */
  processUsage: AppProcessUsage | null;
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
  /** Whether generation is paused pending tool-call approval. */
  isWaitingForToolApproval: boolean;
  /** Real-time statistics for the ongoing or last generation. */
  generationStats: {
    tokensCached: number;
    totalPredicted: number;
    tokensEvaluated?: number;
    promptTokens?: number;
    contextSize?: number;
    tokensPerSecond?: number;
    promptTokensPerSecond?: number;
    stopReason?: string | undefined;
    /** Frozen thinking duration once the think block has closed mid-stream. */
    thinkingDurationMs?: number | undefined;
  } | null;
  /** ID of the active generation session for the current chat. */
  currentGenerationId: string | null;
  /** Cache hit/miss statistics for the active chat. */
  promptCacheStats: { totalEvaluated: number; totalCached: number } | null;
  /** Total number of messages in the active chat (may differ from messages.length when paginated). */
  totalMessages: number;
  /** IDs of chats that have received updates while hidden. */
  unreadChatIds: string[];
  /**
   * True while a history mutation is waiting on the server.
   * Sending during this window would use a different transcript than the UI.
   */
  isSyncingHistory: boolean;
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
  sendMessage: (content: string, files?: File[], inferencePresetId?: string) => Promise<void>;
  /** Interrupts an ongoing generation. */
  stopGeneration: () => void;
  /** Loads a chat session and its message history from the backend. */
  loadChat: (chatId: string) => Promise<void>;
  /** Clears active chat state. */
  unloadChat: () => void;
  /** Drops buffered WebSocket frames for a chat that is no longer needed. */
  discardPendingChatFrames: (chatId: string) => void;
  /** Fetches hardware info from the API. */
  fetchHardware: () => Promise<void>;
  /** Triggers a scan and fetch of available models. */
  fetchModels: () => Promise<void>;
  /** Forces a rescan of the models directory and updates the model list. */
  rescanModels: () => Promise<void>;
  /** Refreshes server and model load status. */
  fetchServerStatus: () => Promise<void>;
  /** Fetches prompt cache statistics for a specific chat. */
  fetchPromptCacheStats: (chatId: string) => Promise<void>;
  /** Refreshes token occupancy for the currently selected conversation. */
  refreshContextUsage: (chatId?: string | null) => Promise<void>;
  /** Refreshes RAM and VRAM usage for LlamaForge processes. */
  refreshProcessUsage: () => Promise<void>;
  /** Spawns the llama-server process with the given configuration. */
  loadModel: (config: LoadModelRequest) => Promise<boolean>;
  /** Loads older messages for the current chat using the oldest loaded position as a cursor. */
  loadMoreMessages: () => Promise<void>;
  /** Updates fields on a message already present in the open transcript. */
  patchMessage: (
    messageId: string,
    updates: Partial<Pick<ChatMessage, "content" | "rawContent" | "thinkingContent">>,
  ) => void;
  /** Patches metadata for the currently open chat without refetching the transcript. */
  patchCurrentChatMetadata: (
    updates: Partial<{
      systemPresetId?: string | null;
      inferencePresetId?: string | null;
      name?: string | null;
    }>,
  ) => void;
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
const MAX_LOG_LINES = 5000;
let reconnectTimer: number | null = null;
const pendingChatFrames = new Map<string, WsFrame[]>();
const MAX_PENDING_CHAT_FRAMES = 64;

function compactTokenFrame(
  existing: Extract<WsFrame, { type: "token" }>,
  incoming: Extract<WsFrame, { type: "token" }>,
): Extract<WsFrame, { type: "token" }> {
  return {
    ...incoming,
    delta: existing.delta + incoming.delta,
    thinkingDelta:
      incoming.thinkingDelta !== undefined || existing.thinkingDelta !== undefined
        ? (existing.thinkingDelta || "") + (incoming.thinkingDelta || "")
        : undefined,
  };
}
// M6 fix: guard against duplicate sends from rapid clicks
let sendInProgress = false;
let activeChatLoadRequestId = 0;
let latestRequestedChatId: string | null = null;
let activeChatLoadController: AbortController | null = null;

/**
 * Appends a log line while enforcing the in-memory log buffer size limit.
 *
 * @param logs - Existing UI log lines.
 * @param line - New formatted log line to append.
 * @returns A trimmed log buffer containing the new line.
 */
function appendLogLine(logs: string[], line: string): string[] {
  return [...logs.slice(-(MAX_LOG_LINES - 1)), line];
}

/**
 * Last non-optimistic message id in the loaded transcript window.
 *
 * Used so a send is rejected when the UI has diverged from the server history,
 * for example after an optimistic delete that never landed in the database.
 *
 * @param messages - Currently displayed transcript, oldest to newest.
 * @returns Persisted head id, or `null` when the client believes the chat is empty.
 */
export function persistedTranscriptHeadId(
  messages: readonly Pick<ChatMessage, "id">[],
): string | null {
  for (let i = messages.length - 1; i >= 0; i--) {
    const id = messages[i]?.id;
    if (id && !id.startsWith("temp-")) return id;
  }
  return null;
}

/**
 * Checks whether an incoming WebSocket frame includes a concrete chat identifier.
 *
 * @param frame - Incoming WebSocket frame from the backend.
 * @returns `true` when the frame contains a non-empty `chatId` field.
 */
function frameHasChatId(frame: WsFrame): frame is WsFrame & { chatId: string } {
  const chatIdValue = (frame as { chatId?: string }).chatId;
  return typeof chatIdValue === "string" && chatIdValue.length > 0;
}

/**
 * Queues a chat-scoped WebSocket frame until that chat becomes active in the UI.
 *
 * @param frame - WebSocket frame to buffer for later replay.
 * @returns No return value.
 */
function bufferChatFrame(frame: WsFrame) {
  if (!frameHasChatId(frame)) return;
  const queued = pendingChatFrames.get(frame.chatId) || [];
  if (frame.type === "token") {
    const last = queued[queued.length - 1];
    if (last?.type === "token" && last.messageId === frame.messageId) {
      queued[queued.length - 1] = compactTokenFrame(last, frame);
      pendingChatFrames.set(frame.chatId, queued);
      return;
    }
  }
  queued.push(frame);
  if (queued.length > MAX_PENDING_CHAT_FRAMES) {
    queued.splice(0, queued.length - MAX_PENDING_CHAT_FRAMES);
  }
  pendingChatFrames.set(frame.chatId, queued);
}

/**
 * Replays buffered WebSocket frames into the active chat state after a chat loads.
 *
 * @param chatId - Chat whose buffered frames should be applied.
 * @param messages - Current message list for that chat.
 * @returns Updated messages together with generation and tool-approval state derived from the buffered frames.
 */
function applyPendingChatFrames(
  chatId: string,
  messages: ChatMessage[],
): { messages: ChatMessage[]; stillGenerating: boolean; waitingForToolApproval: boolean } {
  const pending = pendingChatFrames.get(chatId);
  if (!pending?.length) return { messages, stillGenerating: false, waitingForToolApproval: false };

  const nextMessages = [...messages];
  // Q2 fix: track whether the buffered frames include a stop frame.
  // If no stop frame was received, the generation is still in-flight.
  let sawTokens = false;
  let sawStop = false;
  let waitingForToolApproval = false;

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
        if (frame.thinkingDurationMs !== undefined) {
          message.metrics = {
            predictedTokens: message.metrics?.predictedTokens ?? 0,
            tokensPerSecond: message.metrics?.tokensPerSecond ?? 0,
            promptTokens: message.metrics?.promptTokens ?? 0,
            promptTokensPerSecond: message.metrics?.promptTokensPerSecond ?? 0,
            cachedPromptTokens: message.metrics?.cachedPromptTokens ?? 0,
            evaluatedPromptTokens: message.metrics?.evaluatedPromptTokens ?? 0,
            ...message.metrics,
            thinkingDurationMs: frame.thinkingDurationMs,
          };
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
      waitingForToolApproval = true;
      const idx = nextMessages.findIndex((m) => m.id === frame.messageId);
      if (idx >= 0) {
        const message = { ...nextMessages[idx] } as ChatMessage;
        message.toolCallsJson = JSON.stringify(frame.toolCalls);
        nextMessages[idx] = message;
      }
    }
    if (frame.type === "tool_approval_state") {
      waitingForToolApproval = frame.pending;
    }
    if (frame.type === "stop" || frame.type === "error") {
      waitingForToolApproval = false;
    }
  }

  pendingChatFrames.delete(chatId);
  return {
    messages: nextMessages,
    stillGenerating: sawTokens && !sawStop,
    waitingForToolApproval,
  };
}

/**
 * Determines whether an async chat load result still belongs to the latest requested chat.
 *
 * @param requestId - Monotonic request identifier captured when the load began.
 * @param chatId - Chat identifier associated with the load operation.
 * @returns `true` when the load result still matches the most recent requested chat.
 */
function isCurrentChatLoadRequest(requestId: number, chatId: string): boolean {
  return requestId === activeChatLoadRequestId && latestRequestedChatId === chatId;
}

/**
 * Main application hook for accessing the global Zustand store.
 * Manages server connectivity, model lifecycle, chat history, and UI state.
 */
export const useAppStore = create<AppState>((set, get) => ({
  hardware: null,
  serverStatus: "idle",
  loadProgress: 0,
  loadProgressPhase: null,
  loadProgressDetail: null,
  models: [],
  loadedModel: null,
  loadedConfig: null,
  contextUsage: null,
  processUsage: null,
  isConnected: false,
  logs: [],
  messages: [],
  currentChatId: null,
  currentChatMetadata: null,
  isGenerating: false,
  isWaitingForToolApproval: false,
  currentGenerationId: null,
  generationStats: null,
  promptCacheStats: null,
  totalMessages: 0,
  unreadChatIds: [],
  isSyncingHistory: false,
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
    set((state) => ({ logs: appendLogLine(state.logs, `[${level}] ${body}`) })),
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
        isWaitingForToolApproval: false,
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
        isWaitingForToolApproval: false,
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
          set(() => {
            const updates: Partial<AppState> = { serverStatus: frame.status };
            if (frame.status === "idle") {
              updates.isGenerating = false;
              updates.isWaitingForToolApproval = false;
              updates.currentGenerationId = null;
              updates.errorMessage = null;
              updates.loadProgress = 0;
              updates.loadProgressPhase = null;
              updates.loadProgressDetail = null;
              updates.loadedConfig = null;
              updates.loadedModel = null;
            }
            return updates;
          });
          const prevStatus = get().serverStatus;
          const prevLoadedModel = get().loadedModel;
          if (
            frame.status !== prevStatus ||
            (frame.status === "running" && prevLoadedModel === null)
          ) {
            void get().fetchServerStatus();
          }
        } else if (frame.type === "load_progress") {
          set({
            loadProgress: frame.progress,
            loadProgressPhase: frame.phase,
            loadProgressDetail: frame.detail ?? null,
          });
        } else if (frame.type === "log") {
          set((state) => ({ logs: appendLogLine(state.logs, `[${frame.level}] ${frame.body}`) }));
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
            if (state.isSyncingHistory) return state;
            const messages = [...state.messages];
            let targetIndex = messages.findIndex((m) => m.id === frame.messageId);
            if (targetIndex < 0) {
              if (!state.isGenerating || frame.chatId !== state.currentChatId) return state;
              messages.push({
                id: frame.messageId,
                chatId: frame.chatId,
                role: "assistant",
                content: "",
                rawContent: "",
                position: messages.length,
                createdAt: Date.now(),
              });
              targetIndex = messages.length - 1;
            }
            const thinkingDurationMs =
              frame.thinkingDurationMs ?? state.generationStats?.thinkingDurationMs;
            const stats = {
              tokensCached: frame.tokensCached ?? state.generationStats?.tokensCached ?? 0,
              totalPredicted: (state.generationStats?.totalPredicted ?? 0) + 1,
              tokensEvaluated: state.generationStats?.tokensEvaluated ?? 0,
              promptTokens: frame.promptTokens ?? state.generationStats?.promptTokens ?? 0,
              contextSize: frame.contextSize ?? state.generationStats?.contextSize ?? 0,
              stopReason: state.generationStats?.stopReason,
              ...(thinkingDurationMs !== undefined ? { thinkingDurationMs } : {}),
            };

            const nextMsg = { ...messages[targetIndex] } as ChatMessage;
            nextMsg.content += frame.delta;
            nextMsg.rawContent += frame.delta;
            if (frame.thinkingDelta !== undefined) {
              nextMsg.thinkingContent = (nextMsg.thinkingContent || "") + frame.thinkingDelta;
            }
            if (frame.thinkingDurationMs !== undefined) {
              nextMsg.metrics = {
                predictedTokens: nextMsg.metrics?.predictedTokens ?? 0,
                tokensPerSecond: nextMsg.metrics?.tokensPerSecond ?? 0,
                promptTokens: nextMsg.metrics?.promptTokens ?? 0,
                promptTokensPerSecond: nextMsg.metrics?.promptTokensPerSecond ?? 0,
                cachedPromptTokens: nextMsg.metrics?.cachedPromptTokens ?? 0,
                evaluatedPromptTokens: nextMsg.metrics?.evaluatedPromptTokens ?? 0,
                ...nextMsg.metrics,
                thinkingDurationMs: frame.thinkingDurationMs,
              };
            }
            messages[targetIndex] = nextMsg;
            return {
              messages,
              isGenerating: true,
              isWaitingForToolApproval: false,
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
            if (state.isSyncingHistory) {
              return {
                isGenerating: false,
                isWaitingForToolApproval: false,
                currentGenerationId: null,
              };
            }
            const nextMessages = [...state.messages];
            const targetIndex = nextMessages.findIndex((m) => m.id === frame.messageId);
            const messageMetrics = buildMessageMetrics(
              frame.timings,
              frame.promptTokens ?? state.generationStats?.promptTokens ?? 0,
              {
                thinkingDurationMs: frame.thinkingDurationMs,
                stopReason: frame.stopReason,
              },
            );
            if (targetIndex >= 0) {
              const nextMsg = { ...nextMessages[targetIndex] } as ChatMessage;
              if (frame.fullContent !== undefined) nextMsg.content = frame.fullContent;
              if (frame.fullRawContent !== undefined) nextMsg.rawContent = frame.fullRawContent;
              if (frame.fullThinking !== undefined) nextMsg.thinkingContent = frame.fullThinking;
              nextMsg.metrics = messageMetrics;
              nextMessages[targetIndex] = nextMsg;
            } else if (state.isGenerating) {
              nextMessages.push({
                id: frame.messageId,
                chatId: frame.chatId,
                role: "assistant",
                content: frame.fullContent ?? "",
                rawContent: frame.fullRawContent ?? frame.fullContent ?? "",
                thinkingContent: frame.fullThinking,
                metrics: messageMetrics,
                position: nextMessages.length,
                createdAt: Date.now(),
              });
            }
            return {
              isGenerating: false,
              isWaitingForToolApproval: false,
              currentGenerationId: null,
              messages: nextMessages,
              generationStats: {
                tokensCached: frame.timings.tokens_cached,
                totalPredicted: frame.timings.predicted_n,
                tokensEvaluated: frame.timings.tokens_evaluated,
                promptTokens: frame.promptTokens ?? state.generationStats?.promptTokens ?? 0,
                contextSize: frame.contextSize ?? state.generationStats?.contextSize ?? 0,
                tokensPerSecond: messageMetrics.tokensPerSecond,
                promptTokensPerSecond: messageMetrics.promptTokensPerSecond,
                stopReason: frame.stopReason,
              },
            };
          });
          const currentChatId = get().currentChatId;
          if (currentChatId) {
            get().fetchPromptCacheStats(currentChatId);
            void get().refreshContextUsage(currentChatId);
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
            if (state.isSyncingHistory) return state;
            const messages = [...state.messages];
            const targetIndex = messages.findIndex((m) => m.id === frame.messageId);
            if (targetIndex >= 0) {
              const nextMsg = { ...messages[targetIndex] } as ChatMessage;
              nextMsg.toolCallsJson = JSON.stringify(frame.toolCalls);
              messages[targetIndex] = nextMsg;
            } else if (state.isGenerating) {
              messages.push({
                id: frame.messageId,
                chatId: frame.chatId,
                role: "assistant",
                content: "",
                rawContent: "",
                toolCallsJson: JSON.stringify(frame.toolCalls),
                position: messages.length,
                createdAt: Date.now(),
              });
            }
            return {
              messages,
              isGenerating: false,
              isWaitingForToolApproval: true,
              currentGenerationId: frame.generationId ?? state.currentGenerationId,
            };
          });
        } else if (frame.type === "tool_approval_state") {
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

            return {
              isWaitingForToolApproval: frame.pending,
              isGenerating: frame.pending ? false : (frame.resumeGeneration ?? false),
              currentGenerationId: frame.generationId ?? state.currentGenerationId,
            };
          });
        } else if (frame.type === "message") {
          set((state) => {
            if (state.currentChatId === frame.chatId) {
              if (state.isSyncingHistory) return state;
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
          set((state) => {
            if (frame.chatId && frame.chatId !== state.currentChatId) {
              bufferChatFrame(frame);
              return state;
            }
            return {
              isGenerating: false,
              isWaitingForToolApproval: false,
              currentGenerationId: null,
              errorMessage: frame.message || "An unknown error occurred during generation.",
            };
          });
        }
      } catch (err) {
        logError("Error processing WS frame:", err);
      }
    };
  },

  sendMessage: async (content: string, files?: File[], inferencePresetId?: string) => {
    const state = get();
    const chatId = state.currentChatId;
    if (state.isSyncingHistory) {
      const error = new Error(
        "Please wait for the chat history to finish updating before sending.",
      );
      set({ errorMessage: error.message });
      throw error;
    }
    if (state.isGenerating || state.isWaitingForToolApproval) {
      const error = new Error(
        "Wait for the current response to finish before sending another message.",
      );
      set({ errorMessage: error.message });
      throw error;
    }
    if (latestRequestedChatId && latestRequestedChatId !== chatId) {
      const error = new Error(
        "Please wait for the selected chat to finish loading before sending a message.",
      );
      set({ errorMessage: error.message });
      throw error;
    }
    if (!chatId) {
      const error = new Error("Unable to send message: no chat selected.");
      set({ errorMessage: error.message });
      throw error;
    }
    if (content.length > 25000) {
      const error = new Error("Message content exceeds maximum length of 25,000 characters.");
      set({ errorMessage: error.message });
      throw error;
    }
    if (sendInProgress) {
      logWarn("sendMessage blocked: send already in progress");
      throw new Error("A message is already being sent.");
    }
    sendInProgress = true;
    const expectedHeadMessageId = persistedTranscriptHeadId(state.messages);
    logDebug("sendMessage initiated", {
      chatId,
      content: content.slice(0, 50),
      files: files?.length,
    });
    if (files?.length && files.length > 5) {
      sendInProgress = false;
      const error = new Error("A maximum of 5 attachments is supported per message.");
      set({ errorMessage: error.message });
      throw error;
    }
    if (files?.some((f) => f.size > 10 * 1024 * 1024)) {
      sendInProgress = false;
      const error = new Error("Attachments must be 10MB or smaller.");
      set({ errorMessage: error.message });
      throw error;
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
      isWaitingForToolApproval: false,
      generationStats: null,
    }));

    const requestTimeoutMs = 180000;

    try {
      const requestUrl = `/api/chats/${chatId}/messages`;
      const hasAttachments = Boolean(files?.length);

      let res: Response;
      if (files?.length) {
        const formData = new FormData();
        formData.append("content", content);
        formData.append("expectedHeadMessageId", expectedHeadMessageId ?? "");
        if (inferencePresetId) {
          formData.append("inferencePresetId", inferencePresetId);
        }
        for (const f of files) {
          formData.append("file", f);
        }

        logDebug("Sending multipart message", {
          url: requestUrl,
          fileCount: files.length,
          files: files.map((file) => ({
            name: file.name,
            type: file.type,
            size: file.size,
          })),
        });
        res = (await request(requestUrl, {
          method: "POST",
          body: formData,
          timeoutMs: requestTimeoutMs,
        })) as Response;
      } else {
        logDebug("Sending JSON message", { url: requestUrl });
        res = (await request(requestUrl, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            content,
            expectedHeadMessageId,
            ...(inferencePresetId ? { inferencePresetId } : {}),
          }),
          timeoutMs: requestTimeoutMs,
        })) as Response;
      }

      logDebug("Message send fetch resolved", {
        url: requestUrl,
        hasAttachments,
        status: res.status,
        ok: res.ok,
      });

      if (!res.ok) {
        const errorBody = await res.text().catch(() => "");
        logWarn("Message send returned non-OK response", {
          url: requestUrl,
          hasAttachments,
          status: res.status,
          bodyLength: errorBody.length,
        });
        if (res.status === 409) {
          await get().loadChat(chatId);
          throw new Error("Chat history was out of date and has been reloaded. Please send again.");
        }
        throw new Error(`Server returned ${res.status}${errorBody ? `: ${errorBody}` : ""}`);
      }
      set({ errorMessage: null });
    } catch (err: unknown) {
      if (err instanceof Error && err.name === "TimeoutError") {
        logWarn("Message send request timed out", {
          url: `/api/chats/${chatId}/messages`,
          hasAttachments: Boolean(files?.length),
          timeoutMs: requestTimeoutMs,
        });
      }
      logError("Message send fetch failed", {
        url: `/api/chats/${chatId}/messages`,
        hasAttachments: Boolean(files?.length),
        aborted:
          err instanceof Error ? err.name === "AbortError" || err.name === "TimeoutError" : false,
        errorName: err instanceof Error ? err.name : undefined,
        errorMessage: err instanceof Error ? err.message : String(err),
      });
      set((s) => ({
        messages: s.messages.filter((msg) => msg.id !== optimisticMessageId),
        isGenerating: false,
        isWaitingForToolApproval: false,
        errorMessage: err instanceof Error ? err.message : "Message send failed.",
      }));
      throw err;
    } finally {
      // M6 fix: always clear the send guard
      sendInProgress = false;
    }
  },

  stopGeneration: () => {
    const state = get();
    if ((!state.isGenerating && !state.isWaitingForToolApproval) || !state.currentChatId) return;
    set({ isGenerating: false, isWaitingForToolApproval: false });

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
      isWaitingForToolApproval: false,
      currentGenerationId: null,
      errorMessage: null, // Clear error on disconnect
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
    const requestId = ++activeChatLoadRequestId;
    const chatLoadTimeoutMs = 30000;
    latestRequestedChatId = chatId;
    activeChatLoadController?.abort();
    const controller = new AbortController();
    let didTimeout = false;
    const timeoutId = window.setTimeout(() => {
      didTimeout = true;
      controller.abort();
    }, chatLoadTimeoutMs);
    activeChatLoadController = controller;
    set((state) => {
      if (state.currentChatId === chatId) {
        return { errorMessage: null };
      }

      return {
        currentChatId: null,
        currentChatMetadata: null,
        messages: [],
        generationStats: null,
        contextUsage: null,
        promptCacheStats: null,
        totalMessages: 0,
        currentGenerationId: null,
        isGenerating: false,
        isWaitingForToolApproval: false,
        errorMessage: null,
      };
    });

    try {
      const res = await fetch(`/api/chats/${chatId}`, { signal: controller.signal });
      if (!isCurrentChatLoadRequest(requestId, chatId)) {
        return;
      }
      if (res.ok) {
        const chat = await res.json();
        if (!isCurrentChatLoadRequest(requestId, chatId)) {
          return;
        }
        // Q2 fix: destructure both messages and stillGenerating flag so that
        // switching back to a chat with an active generation restores the stop button.
        const { messages, stillGenerating, waitingForToolApproval } = applyPendingChatFrames(
          chatId,
          chat.messages || [],
        );
        set((state) => ({
          currentChatId: chatId,
          messages,
          totalMessages: chat.totalMessages ?? messages.length,
          isGenerating: stillGenerating,
          isWaitingForToolApproval: waitingForToolApproval,
          currentChatMetadata: {
            name: chat.name,
            systemPresetId: chat.systemPresetId,
            inferencePresetId: chat.inferencePresetId,
          },
          unreadChatIds: state.unreadChatIds.filter((id) => id !== chatId),
          errorMessage: null,
        }));
        void get().refreshContextUsage(chatId);
      } else {
        // S11 fix: If the default chat is missing, create it automatically.
        // This handles fresh installations or DB resets gracefully.
        if (chatId === "default" || chatId === "default-chat") {
          const createRes = await request("/api/chats", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ name: "Default Chat" }),
          });
          if (!isCurrentChatLoadRequest(requestId, chatId)) {
            return;
          }
          if (createRes.ok) {
            const newChat = await createRes.json();
            if (!isCurrentChatLoadRequest(requestId, chatId)) {
              return;
            }
            set((state) => ({
              currentChatId: newChat.id,
              messages: [],
              totalMessages: 0,
              isGenerating: false,
              isWaitingForToolApproval: false,
              currentChatMetadata: {
                name: newChat.name,
                systemPresetId: null,
                inferencePresetId: null,
              },
              unreadChatIds: state.unreadChatIds.filter((id) => id !== newChat.id),
              errorMessage: null,
            }));
            return;
          }
        }
        // Clear state if not found
        get().unloadChat();
        if (chatId !== "default" && chatId !== "default-chat") {
          get().setError(`Chat not found: ${chatId}`);
        }
      }
    } catch (e: unknown) {
      if (didTimeout) {
        logWarn("Chat load request timed out", {
          url: `/api/chats/${chatId}`,
          timeoutMs: chatLoadTimeoutMs,
        });
      }
      if (controller.signal.aborted || !isCurrentChatLoadRequest(requestId, chatId)) {
        return;
      }
      logError("Fetch chat failed", e);
      get().setError(e instanceof Error ? e.message : "Failed to load chat.", "Retry", () =>
        get().loadChat(chatId),
      );
    } finally {
      window.clearTimeout(timeoutId);
      if (activeChatLoadController === controller) {
        activeChatLoadController = null;
      }
    }
  },

  unloadChat: () =>
    (() => {
      const previousChatId = get().currentChatId;
      if (previousChatId) pendingChatFrames.delete(previousChatId);
      activeChatLoadRequestId += 1;
      latestRequestedChatId = null;
      activeChatLoadController?.abort();
      activeChatLoadController = null;
      set({
        currentChatId: null,
        currentChatMetadata: null,
        messages: [],
        generationStats: null,
        contextUsage: null,
        totalMessages: 0,
        isWaitingForToolApproval: false,
        errorMessage: null, // Clear errors when unloading/switching chats
        isSyncingHistory: false,
      });
    })(),

  discardPendingChatFrames: (chatId) => {
    pendingChatFrames.delete(chatId);
  },

  loadMoreMessages: async () => {
    const state = get();
    if (!state.currentChatId) return;
    const currentCount = state.messages.length;
    if (currentCount >= state.totalMessages) return;
    const oldestPosition = state.messages.reduce(
      (min, message) => (message.position < min ? message.position : min),
      Number.POSITIVE_INFINITY,
    );
    if (!Number.isFinite(oldestPosition)) return;
    try {
      const res = await fetch(
        `/api/chats/${state.currentChatId}?messageLimit=500&beforePosition=${oldestPosition}`,
      );
      if (!res.ok) return;
      const chat = await res.json();
      const olderMessages = (chat.messages || []) as ChatMessage[];
      if (olderMessages.length === 0) return;
      set((s) => {
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

  patchMessage: (messageId, updates) => {
    set((state) => ({
      messages: state.messages.map((message) =>
        message.id === messageId ? { ...message, ...updates } : message,
      ),
    }));
  },

  patchCurrentChatMetadata: (updates) => {
    set((state) => {
      if (!state.currentChatMetadata) return state;
      return {
        currentChatMetadata: {
          ...state.currentChatMetadata,
          ...updates,
        },
      };
    });
    if (updates.systemPresetId !== undefined) {
      void get().refreshContextUsage();
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

  rescanModels: async () => {
    try {
      const models = await import("./api").then((m) => m.rescanModels());
      set({ models, errorMessage: null });
    } catch (e: unknown) {
      logError("Rescan models failed", e);
      get().addNotification(
        e instanceof Error ? e.message : "Failed to rescan models.",
        "error",
        "Retry",
        () => get().rescanModels(),
      );
    }
  },

  fetchServerStatus: async () => {
    try {
      const res = await fetch("/api/server/status");
      if (res.ok) {
        const data = await res.json();
        const modelPath = data.config?.modelPath;
        set((state) => {
          let loadedModel = null;
          if (modelPath) {
            loadedModel = state.models.find((m) => m.primaryPath === modelPath) || null;
            // S12 fix: If the server reports a model that isn't in our scanned models list
            // (e.g. it was deleted or moved), create a synthetic entry so the UI doesn't break.
            if (!loadedModel) {
              const fileName = modelPath.split(/[/\\]/).pop() || "unknown.gguf";
              loadedModel = {
                publisher: "unknown",
                modelName: fileName,
                primaryPath: modelPath,
                metadata: {
                  architecture: "unknown",
                  name: fileName,
                  fileSizeBytes: 0,
                  hasVisionEncoder: false,
                  hasAudioEncoder: false,
                  hasToolCalling: false,
                  isDraftModel: false,
                  contextLength: undefined,
                  embeddingLength: undefined,
                  attentionHeadCount: undefined,
                  attentionHeadCountKv: undefined,
                  blockCount: undefined,
                  feedForwardLength: undefined,
                  quantType: undefined,
                  defaultTemperature: undefined,
                  defaultTopK: undefined,
                  defaultTopP: undefined,
                  defaultMinP: undefined,
                  defaultRepeatPenalty: undefined,
                  chatTemplate: undefined,
                },
              };
            }
          }
          return {
            serverStatus: data.status,
            loadedModel,
            loadedConfig: data.config ?? null,
            errorMessage: null,
          };
        });
        void get().refreshContextUsage();
        void get().refreshProcessUsage();
      } else if (get().serverStatus !== "idle") {
        const errorBody = await res.text().catch(() => "");
        get().addNotification(
          `Failed to fetch server status: ${res.status}${errorBody ? `: ${errorBody}` : ""}`,
          "error",
        );
      }
    } catch (e: unknown) {
      if (get().serverStatus !== "idle") {
        logError("Status fetch failed", e);
        get().addNotification(
          e instanceof Error ? e.message : "Server status unavailable.",
          "error",
        );
      }
    }
  },

  refreshContextUsage: async (chatId?: string | null) => {
    const targetChatId = chatId === undefined ? get().currentChatId : chatId;
    if (!targetChatId) {
      set({ contextUsage: null });
      return;
    }
    try {
      const res = await fetch(`/api/chats/${targetChatId}/context-usage`);
      if (!res.ok) {
        if (get().currentChatId === targetChatId) {
          set({
            contextUsage: {
              usedTokens: 0,
              contextSize: get().loadedConfig?.contextSize ?? null,
            },
          });
        }
        return;
      }
      const usage = (await res.json()) as ChatContextUsage;
      if (get().currentChatId !== targetChatId) return;
      set({ contextUsage: usage });
    } catch (e: unknown) {
      logDebug("Context usage refresh failed", e);
    }
  },

  refreshProcessUsage: async () => {
    try {
      const res = await fetch("/api/runtime/usage");
      if (!res.ok) return;
      const usage = (await res.json()) as AppProcessUsage;
      set({ processUsage: usage });
    } catch (e: unknown) {
      logDebug("Process usage refresh failed", e);
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

  loadModel: async (config: LoadModelRequest): Promise<boolean> => {
    if (useUiStore.getState().rightPanelView === "modelLibrary") {
      useUiStore.getState().setRightPanelView(null);
    }
    set({
      serverStatus: "loading",
      loadProgress: 0,
      loadProgressPhase: "spawning",
      loadProgressDetail: "Starting model load sequence…",
    });
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
        const shouldOpenSettings = body?.code === "NOT_CONFIGURED" || body?.code === "INVALID_PATH";
        const action = shouldOpenSettings
          ? () => useUiStore.getState().setRightPanelView("settings")
          : null;
        if (action) {
          action();
        }
        set({
          serverStatus: "idle",
          loadProgress: 0,
          loadProgressPhase: null,
          loadProgressDetail: null,
        });
        get().setError(errorMessage, action ? "Settings" : null, action);
        return false;
      } else {
        set({ errorMessage: null, errorActionLabel: null, errorAction: null });
        await get().fetchServerStatus();
        return true;
      }
    } catch (e: unknown) {
      set({
        serverStatus: "idle",
        loadProgress: 0,
        loadProgressPhase: null,
        loadProgressDetail: null,
        errorMessage: e instanceof Error ? e.message : "Model load failed.",
      });
      return false;
    }
  },

  unloadModel: async () => {
    set({ errorMessage: null }); // Clear any stale errors
    try {
      const res = await fetch("/api/server/unload", { method: "POST" });
      if (res.ok) {
        set({ serverStatus: "idle", loadedConfig: null, loadedModel: null, errorMessage: null });
        void get().refreshProcessUsage();
        void get().refreshContextUsage();
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
