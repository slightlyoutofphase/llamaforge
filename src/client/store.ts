/**
 * @packageDocumentation
 * Global state management for the LlamaForge client using Zustand.
 * Orchestrates WebSocket communication, chat session management, and server interaction.
 */

import { create } from "zustand";
import { buildMessageMetrics, readPromptCacheCounts } from "../shared/generationMetrics";
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
  WsTokenFrame,
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
  /** True from the start of a send until the POST finishes, before generation streaming. */
  isSending: boolean;
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
  ) => Promise<void>;
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
/** Identifies the newest "load older messages" request so a stale page cannot merge. */
let olderPageRequestId = 0;
/** True while one older-page request is waiting on the server. */
let olderPageInFlight = false;
/**
 * Fetches context usage for one chat and writes it when that chat is still current.
 *
 * @param targetChatId - Chat to measure, or `null` when nothing is open.
 * @returns A promise that resolves once the store has been updated or the request failed.
 */
async function refreshContextUsageNow(targetChatId: string | null): Promise<void> {
  if (!targetChatId) {
    useAppStore.setState({ contextUsage: null });
    return;
  }
  try {
    const res = await fetch(`/api/chats/${targetChatId}/context-usage`);
    if (!res.ok) {
      if (useAppStore.getState().currentChatId === targetChatId) {
        useAppStore.setState({
          contextUsage: {
            usedTokens: 0,
            contextSize: useAppStore.getState().loadedConfig?.contextSize ?? null,
          },
        });
      }
      return;
    }
    const usage = (await res.json()) as ChatContextUsage;
    if (useAppStore.getState().currentChatId !== targetChatId) return;
    useAppStore.setState({ contextUsage: usage });
  } catch (e: unknown) {
    logDebug("Context usage refresh failed", e);
  }
}

/** Chat id for the context-usage refresh coalesced into the current turn. */
let pendingContextUsageChatId: string | null | undefined;
/** In-flight coalesced context-usage refresh, shared by callers in the same turn. */
let pendingContextUsage: Promise<void> | null = null;
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
  const next = logs.concat(line);
  if (next.length <= MAX_LOG_LINES) return next;
  const dropCount = Math.max(1, Math.floor(MAX_LOG_LINES * 0.1));
  return next.slice(dropCount);
}

const queuedLogLines: string[] = [];
let liveLogFrameHandle: number | null = null;

/**
 * Writes queued log lines in one store update.
 *
 * @returns No return value.
 */
function flushQueuedLogLines(): void {
  if (liveLogFrameHandle !== null && typeof cancelAnimationFrame === "function") {
    cancelAnimationFrame(liveLogFrameHandle);
  }
  liveLogFrameHandle = null;
  const batch = queuedLogLines.splice(0);
  if (batch.length === 0) return;
  useAppStore.setState((state) => {
    let logs = state.logs;
    for (const line of batch) logs = appendLogLine(logs, line);
    return { logs };
  });
}

/**
 * Queues a log line so a burst of log frames becomes one render.
 *
 * Tests apply the line immediately because Happy DOM does not flush animation
 * frames inside `act`.
 *
 * @param line - Formatted log line.
 * @returns No return value.
 */
function enqueueLogLine(line: string): void {
  queuedLogLines.push(line);
  if (liveLogFrameHandle !== null) return;
  const immediate =
    typeof requestAnimationFrame !== "function" ||
    Boolean((globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT);
  if (immediate) {
    flushQueuedLogLines();
    return;
  }
  liveLogFrameHandle = requestAnimationFrame(() => {
    liveLogFrameHandle = null;
    flushQueuedLogLines();
  });
}

const queuedLiveTokenFrames: WsTokenFrame[] = [];
let liveTokenFrameHandle: number | null = null;

/**
 * Applies one live token frame onto the chat state.
 *
 * @param state - Store state before this token.
 * @param frame - Token frame to apply.
 * @returns The next store state.
 */
function reduceLiveTokenFrame(state: AppState, frame: WsTokenFrame): AppState {
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
  let targetIndex = messages.findIndex((message) => message.id === frame.messageId);
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
  const thinkingDurationMs = frame.thinkingDurationMs ?? state.generationStats?.thinkingDurationMs;
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
    ...state,
    messages,
    isGenerating: true,
    isWaitingForToolApproval: false,
    generationStats: stats,
    currentGenerationId: frame.generationId ?? state.currentGenerationId,
  };
}

/**
 * Writes queued token frames in one store update.
 *
 * @returns No return value.
 */
function flushQueuedLiveTokenFrames(): void {
  if (liveTokenFrameHandle !== null && typeof cancelAnimationFrame === "function") {
    cancelAnimationFrame(liveTokenFrameHandle);
  }
  liveTokenFrameHandle = null;
  const batch = queuedLiveTokenFrames.splice(0);
  if (batch.length === 0) return;
  useAppStore.setState((state) => batch.reduce(reduceLiveTokenFrame, state));
}

/**
 * Queues a token frame so a burst of SSE events becomes one render.
 *
 * Tests apply the frame immediately because Happy DOM does not flush animation
 * frames inside `act`.
 *
 * @param frame - Token frame from the model socket.
 * @returns No return value.
 */
function enqueueLiveTokenFrame(frame: WsTokenFrame): void {
  queuedLiveTokenFrames.push(frame);
  if (liveTokenFrameHandle !== null) return;
  const immediate =
    typeof requestAnimationFrame !== "function" ||
    Boolean((globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT);
  if (immediate) {
    flushQueuedLiveTokenFrames();
    return;
  }
  liveTokenFrameHandle = requestAnimationFrame(() => {
    liveTokenFrameHandle = null;
    flushQueuedLiveTokenFrames();
  });
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
/**
 * Joins buffered stream text onto a message that may already contain a prefix of it.
 *
 * The database flush and the replay buffer can cover the same tokens. Appending
 * the buffer blindly duplicates that overlap.
 *
 * @param existing - Text already stored on the loaded message.
 * @param addition - Buffered delta for that field.
 * @returns The message text with only the unseen tail appended.
 */
function mergeBufferedText(existing: string, addition: string): string {
  if (!addition) return existing;
  if (!existing) return addition;
  if (existing.endsWith(addition)) return existing;
  if (addition.startsWith(existing)) return addition;
  const max = Math.min(existing.length, addition.length);
  for (let size = max; size > 0; size--) {
    if (existing.endsWith(addition.slice(0, size))) {
      return existing + addition.slice(size);
    }
  }
  return existing + addition;
}

function applyPendingChatFrames(
  chatId: string,
  messages: ChatMessage[],
): {
  messages: ChatMessage[];
  stillGenerating: boolean;
  waitingForToolApproval: boolean;
  addedMessages: number;
} {
  const pending = pendingChatFrames.get(chatId);
  if (!pending?.length) {
    return { messages, stillGenerating: false, waitingForToolApproval: false, addedMessages: 0 };
  }

  const nextMessages = [...messages];
  let addedMessages = 0;
  // Q2 fix: track whether the buffered frames include a stop frame.
  // If no stop frame was received, the generation is still in-flight.
  let sawTokens = false;
  let sawStop = false;
  let awaitingToolFollowUp = false;
  let waitingForToolApproval = false;

  for (const frame of pending) {
    if (frame.type === "message") {
      if (!nextMessages.some((m) => m.id === frame.message.id)) {
        nextMessages.push(frame.message);
        addedMessages += 1;
      }
    }
    if (frame.type === "token") {
      sawTokens = true;
      const idx = nextMessages.findIndex((m) => m.id === frame.messageId);
      if (idx >= 0) {
        const message = { ...nextMessages[idx] } as ChatMessage;
        message.content = mergeBufferedText(message.content, frame.delta);
        message.rawContent = mergeBufferedText(message.rawContent || "", frame.delta);
        if (frame.thinkingDelta !== undefined) {
          message.thinkingContent = mergeBufferedText(
            message.thinkingContent || "",
            frame.thinkingDelta,
          );
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
      if (frame.stopReason === "tool_calls") {
        awaitingToolFollowUp = true;
      } else {
        sawStop = true;
        awaitingToolFollowUp = false;
      }
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
    if (frame.type === "error") {
      sawStop = true;
      awaitingToolFollowUp = false;
    }
    if (frame.type === "stop" || frame.type === "error") {
      waitingForToolApproval = false;
    }
  }

  pendingChatFrames.delete(chatId);
  return {
    messages: nextMessages,
    stillGenerating: !sawStop && (sawTokens || awaitingToolFollowUp),
    waitingForToolApproval,
    addedMessages,
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
 * Polls server status after a load request loses its HTTP response.
 *
 * Bun used to close a quiet load after 10 seconds. The server can still be
 * loading, so a dropped response is not itself a failure. Five consecutive
 * transport failures mean the app server is gone and polling should stop.
 *
 * @returns `true` when status becomes `running` before the deadline.
 */
async function waitForModelLoadAfterDroppedRequest(): Promise<boolean> {
  const deadline = Date.now() + 3 * 60 * 1000;
  let transportFailures = 0;
  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 1000));
    try {
      const res = await fetch("/api/server/status");
      if (!res.ok) {
        transportFailures += 1;
      } else {
        transportFailures = 0;
        const body = (await res.json()) as { status?: string };
        if (body.status === "running") return true;
        if (body.status === "idle") return false;
      }
    } catch {
      transportFailures += 1;
    }
    if (transportFailures >= 5) return false;
  }
  return false;
}

const CLIENT_HEARTBEAT_MS = 10_000;
const INBOUND_WATCHDOG_MS = 45_000;
const WATCHDOG_POLL_MS = 5_000;

let socketSerial = 0;
let dropTokenEpoch = 0;
let acceptedTokenEpoch = 0;
let lastInboundAt = 0;
let heartbeatTimer: number | null = null;
let watchdogTimer: number | null = null;

/**
 * True after unload, disconnect, or a dead stream until the user starts a new one.
 *
 * Late token frames must not turn the composer back into a generating state.
 *
 * @returns `true` when live token and tool frames should be ignored.
 */
function inboundGenerationSuppressed(): boolean {
  return acceptedTokenEpoch !== dropTokenEpoch;
}

/**
 * Drops subsequent token and tool frames until {@link releaseInboundGeneration}.
 *
 * @returns No return value.
 */
function suppressInboundGeneration(): void {
  dropTokenEpoch += 1;
}

/**
 * Allows token frames again. Used when the user sends a message or finishes a load.
 *
 * @returns No return value.
 */
function releaseInboundGeneration(): void {
  acceptedTokenEpoch = dropTokenEpoch;
}

/**
 * Lets token frames through again because the user started another generation.
 *
 * Regenerate and continue update the store directly, so they call this before
 * flipping `isGenerating` or a disconnect fence would swallow the new stream.
 *
 * @returns No return value.
 */
export function acceptInboundGeneration(): void {
  releaseInboundGeneration();
}

/**
 * Stops the keepalive and dead-server timers for the current browser socket.
 *
 * @returns No return value.
 */
function clearSocketTimers(): void {
  if (heartbeatTimer !== null) {
    window.clearInterval(heartbeatTimer);
    heartbeatTimer = null;
  }
  if (watchdogTimer !== null) {
    window.clearInterval(watchdogTimer);
    watchdogTimer = null;
  }
}

/**
 * Starts a window interval and detaches it from the test runner when the host allows it.
 *
 * @param callback - Function invoked on each tick.
 * @param intervalMs - Delay between ticks in milliseconds.
 * @returns The timer id passed to `clearInterval`.
 */
function scheduleInterval(callback: () => void, intervalMs: number): number {
  const id = window.setInterval(callback, intervalMs);
  const timer = id as unknown as { unref?: () => void };
  if (typeof timer === "object" && timer !== null && typeof timer.unref === "function") {
    timer.unref();
  }
  return id;
}

/**
 * Token and tool frames are the ones that make the page look like inference is still running.
 *
 * @param frame - Parsed server frame.
 * @returns `true` when the frame should be discarded because generation was halted locally.
 */
function shouldDropLiveFrame(frame: WsFrame): boolean {
  if (!inboundGenerationSuppressed()) return false;
  return (
    frame.type === "token" || frame.type === "tool_call" || frame.type === "tool_approval_state"
  );
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
  isSending: false,
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
  addLog: (level, body) => {
    enqueueLogLine(`[${level}] ${body}`);
  },
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

    const socket = new WebSocket(wsUrl);
    const serial = ++socketSerial;
    ws = socket;

    socket.onopen = () => {
      if (serial !== socketSerial) return;
      currentReconnectDelay = 2000;
      lastInboundAt = Date.now();
      clearSocketTimers();
      heartbeatTimer = scheduleInterval(() => {
        if (serial !== socketSerial || socket.readyState !== WebSocket.OPEN) return;
        try {
          socket.send(JSON.stringify({ type: "heartbeat" }));
        } catch {
          // The socket is already closing.
        }
      }, CLIENT_HEARTBEAT_MS);
      watchdogTimer = scheduleInterval(() => {
        if (serial !== socketSerial) return;
        const state = get();
        if (!state.isGenerating && !state.isWaitingForToolApproval) return;
        if (Date.now() - lastInboundAt < INBOUND_WATCHDOG_MS) return;
        suppressInboundGeneration();
        try {
          if (socket.readyState === WebSocket.OPEN) {
            socket.send(JSON.stringify({ type: "session_close" }));
          }
        } catch {
          // The socket is already closing.
        }
        set({
          isGenerating: false,
          isWaitingForToolApproval: false,
          currentGenerationId: null,
          isConnected: false,
          errorMessage: "Lost contact with LlamaForge while a response was still streaming.",
          errorActionLabel: "Reconnect",
          errorAction: () => get().connectWs(),
        });
        if (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING) {
          socket.close(4000, "Inbound watchdog");
        }
      }, WATCHDOG_POLL_MS);
      set({ isConnected: true, errorMessage: null, errorActionLabel: null, errorAction: null });
      logInfo("WS connected");
    };

    socket.onerror = () => {
      if (serial !== socketSerial) return;
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

    socket.onclose = () => {
      if (serial !== socketSerial) return;
      const shouldReconnect = get().shouldReconnect;
      if (ws === socket) ws = null;
      clearSocketTimers();
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

    socket.onmessage = (event) => {
      if (serial !== socketSerial) return;
      let frame: WsFrame;
      try {
        frame = JSON.parse(event.data) as WsFrame;
      } catch (err) {
        logError("Failed to parse WS message", err);
        return;
      }
      lastInboundAt = Date.now();
      if (frame.type === "heartbeat") return;
      if (frame.type !== "token") flushQueuedLiveTokenFrames();
      if (shouldDropLiveFrame(frame)) return;

      try {
        if (frame.type === "server_status") {
          if (frame.status === "idle") {
            const live = get();
            if (live.isGenerating || live.isWaitingForToolApproval || live.currentGenerationId) {
              suppressInboundGeneration();
            }
          }
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
          set((state) => {
            const loadProgress = Math.max(state.loadProgress, frame.progress);
            const advanced = frame.progress >= state.loadProgress;
            return {
              loadProgress,
              loadProgressPhase: advanced ? frame.phase : state.loadProgressPhase,
              loadProgressDetail: advanced ? (frame.detail ?? null) : state.loadProgressDetail,
            };
          });
        } else if (frame.type === "log") {
          enqueueLogLine(`[${frame.level}] ${frame.body}`);
        } else if (frame.type === "token") {
          enqueueLiveTokenFrame(frame);
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
              const existing = nextMessages[targetIndex];
              const incomingContent = frame.fullContent ?? "";
              const incomingThinking = frame.fullThinking ?? "";
              const removeEmptyCancel =
                frame.stopReason === "cancelled" &&
                incomingContent.length === 0 &&
                incomingThinking.length === 0 &&
                existing?.role === "assistant" &&
                existing.content.length === 0 &&
                !existing.thinkingContent;
              if (removeEmptyCancel) {
                nextMessages.splice(targetIndex, 1);
              } else if (existing) {
                const nextMsg = { ...existing };
                if (frame.fullContent !== undefined) nextMsg.content = frame.fullContent;
                if (frame.fullRawContent !== undefined) nextMsg.rawContent = frame.fullRawContent;
                if (frame.fullThinking !== undefined) nextMsg.thinkingContent = frame.fullThinking;
                nextMsg.metrics = messageMetrics;
                nextMessages[targetIndex] = nextMsg;
              }
            } else if (
              state.isGenerating &&
              !(
                frame.stopReason === "cancelled" &&
                (frame.fullContent ?? "").length === 0 &&
                (frame.fullThinking ?? "").length === 0
              )
            ) {
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
            const cacheCounts = readPromptCacheCounts(frame.timings);
            const followUpAfterTools = frame.stopReason === "tool_calls";
            return {
              isGenerating: followUpAfterTools,
              isWaitingForToolApproval: false,
              currentGenerationId: followUpAfterTools
                ? (frame.generationId ?? state.currentGenerationId)
                : null,
              messages: nextMessages,
              generationStats: {
                tokensCached: cacheCounts.cachedPromptTokens,
                totalPredicted: frame.timings.predicted_n,
                tokensEvaluated: cacheCounts.evaluatedPromptTokens,
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
              const replacedOptimistic = state.messages.some(
                (message) => message.id.startsWith("temp-") && message.role === frame.message.role,
              );
              const alreadyPresent = state.messages.some(
                (message) => message.id === frame.message.id,
              );
              if (!alreadyPresent) {
                reconciled.push(frame.message);
              }
              return {
                messages: reconciled,
                totalMessages:
                  state.totalMessages + (!alreadyPresent && !replacedOptimistic ? 1 : 0),
              };
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
          if (inboundGenerationSuppressed()) {
            set({
              isGenerating: false,
              isWaitingForToolApproval: false,
              currentGenerationId: null,
            });
            return;
          }
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
    releaseInboundGeneration();
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
      isSending: true,
      isWaitingForToolApproval: false,
      generationStats: null,
      totalMessages: s.totalMessages + 1,
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
        let parsedError: string | undefined;
        let parsedCode: string | undefined;
        if (errorBody.length > 0) {
          try {
            const parsed = JSON.parse(errorBody) as { error?: unknown; code?: unknown };
            if (typeof parsed.error === "string" && parsed.error.length > 0) {
              parsedError = parsed.error;
            }
            if (typeof parsed.code === "string") {
              parsedCode = parsed.code;
            }
          } catch {
            parsedError = undefined;
          }
        }
        logWarn("Message send returned non-OK response", {
          url: requestUrl,
          hasAttachments,
          status: res.status,
          bodyLength: errorBody.length,
        });
        if (parsedCode === "TRANSCRIPT_MISMATCH") {
          await get().loadChat(chatId);
          throw new Error("Chat history was out of date and has been reloaded. Please send again.");
        }
        throw new Error(parsedError ?? "Message send failed.");
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
      sendInProgress = false;
      set({ isSending: false });
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
    suppressInboundGeneration();
    clearSocketTimers();
    set({
      shouldReconnect: false,
      isConnected: false,
      isGenerating: false,
      isWaitingForToolApproval: false,
      currentGenerationId: null,
      errorMessage: null, // Clear error on disconnect
      errorActionLabel: null,
      errorAction: null,
    });
    if (reconnectTimer !== null) {
      window.clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }
    const socket = ws;
    if (socket && socket.readyState === WebSocket.OPEN) {
      try {
        socket.send(JSON.stringify({ type: "session_close" }));
      } catch {
        // The socket is already closing.
      }
    }
    if (socket && socket.readyState !== WebSocket.CLOSED) {
      socket.close(1000, "Client initiated disconnect");
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
        const { messages, stillGenerating, waitingForToolApproval, addedMessages } =
          applyPendingChatFrames(chatId, chat.messages || []);
        const serverTotal =
          typeof chat.totalMessages === "number"
            ? chat.totalMessages
            : (chat.messages?.length ?? 0);
        set((state) => ({
          currentChatId: chatId,
          messages,
          totalMessages: serverTotal + addedMessages,
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
    if (olderPageInFlight) return;
    const state = get();
    const chatId = state.currentChatId;
    if (!chatId) return;
    const currentCount = state.messages.length;
    if (currentCount >= state.totalMessages) return;
    const oldestPosition = state.messages.reduce(
      (min, message) => (message.position < min ? message.position : min),
      Number.POSITIVE_INFINITY,
    );
    if (!Number.isFinite(oldestPosition)) return;
    const requestId = ++olderPageRequestId;
    olderPageInFlight = true;
    try {
      const res = await fetch(
        `/api/chats/${chatId}?messageLimit=500&beforePosition=${oldestPosition}`,
      );
      if (!res.ok) return;
      const chat = (await res.json()) as { messages?: ChatMessage[]; totalMessages?: number };
      const olderMessages = chat.messages ?? [];
      if (olderMessages.length === 0) return;
      if (requestId !== olderPageRequestId || get().currentChatId !== chatId) return;
      set((s) => {
        if (s.currentChatId !== chatId) return s;
        const existingIds = new Set(s.messages.map((m) => m.id));
        const unique = olderMessages.filter((m) => !existingIds.has(m.id));
        return {
          messages: [...unique, ...s.messages],
          totalMessages: chat.totalMessages ?? s.totalMessages,
        };
      });
    } catch (e) {
      logError("Failed to load more messages", e);
    } finally {
      olderPageInFlight = false;
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
        if (data.status === "idle") {
          const live = get();
          if (live.isGenerating || live.isWaitingForToolApproval || live.currentGenerationId) {
            suppressInboundGeneration();
          }
        }
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
            ...(data.status === "idle"
              ? {
                  isGenerating: false,
                  isWaitingForToolApproval: false,
                  currentGenerationId: null,
                }
              : {}),
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

  refreshContextUsage: (chatId?: string | null) => {
    pendingContextUsageChatId = chatId;
    if (pendingContextUsage) return pendingContextUsage;
    pendingContextUsage = Promise.resolve().then(async () => {
      const targetChatId =
        pendingContextUsageChatId === undefined ? get().currentChatId : pendingContextUsageChatId;
      pendingContextUsage = null;
      await refreshContextUsageNow(targetChatId);
    });
    return pendingContextUsage;
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
    const generationWasSuppressed = inboundGenerationSuppressed();
    suppressInboundGeneration();
    const restoreGenerationFence = () => {
      if (!generationWasSuppressed) releaseInboundGeneration();
    };
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
        const body = (await res.json().catch(() => ({}))) as { error?: unknown; code?: unknown };
        if (body.code === "LOAD_CANCELLED") {
          set({
            serverStatus: "idle",
            loadProgress: 0,
            loadProgressPhase: null,
            loadProgressDetail: null,
            errorMessage: null,
            errorActionLabel: null,
            errorAction: null,
          });
          restoreGenerationFence();
          return false;
        }
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
        restoreGenerationFence();
        return false;
      } else {
        set({ errorMessage: null, errorActionLabel: null, errorAction: null });
        releaseInboundGeneration();
        await get().fetchServerStatus();
        return true;
      }
    } catch (e: unknown) {
      const recovered = await waitForModelLoadAfterDroppedRequest();
      if (recovered) {
        set({ errorMessage: null, errorActionLabel: null, errorAction: null });
        releaseInboundGeneration();
        await get().fetchServerStatus();
        return true;
      }
      set({
        serverStatus: "idle",
        loadProgress: 0,
        loadProgressPhase: null,
        loadProgressDetail: null,
        errorMessage: e instanceof Error ? e.message : "Model load failed.",
      });
      restoreGenerationFence();
      return false;
    }
  },

  unloadModel: async () => {
    suppressInboundGeneration();
    set({
      errorMessage: null,
      isGenerating: false,
      isWaitingForToolApproval: false,
      currentGenerationId: null,
    });
    try {
      const res = await fetch("/api/server/unload", { method: "POST" });
      if (res.ok) {
        set({
          serverStatus: "idle",
          loadedConfig: null,
          loadedModel: null,
          loadProgress: 0,
          loadProgressPhase: null,
          loadProgressDetail: null,
          errorMessage: null,
          isGenerating: false,
          isWaitingForToolApproval: false,
          currentGenerationId: null,
        });
        void get().refreshProcessUsage();
        void get().refreshContextUsage();
      } else {
        releaseInboundGeneration();
        const errorBody = await res.text().catch(() => "");
        get().addNotification(
          `Failed to unload model: ${res.status}${errorBody ? `: ${errorBody}` : ""}`,
          "error",
          "Retry",
          () => get().unloadModel(),
        );
      }
    } catch (e: unknown) {
      releaseInboundGeneration();
      logError("Unload failed", e);
      get().addNotification(
        e instanceof Error ? e.message : "Model unload failed.",
        "error",
        "Retry",
        () => get().unloadModel(),
      );
    }
  },

  approveToolCall: async (_messageId, toolCallId, approved, editedArguments) => {
    const chatId = get().currentChatId;
    if (!chatId) {
      get().addNotification("No chat is open for this tool approval.", "error");
      return;
    }
    try {
      const res = await fetch(
        `/api/chats/${encodeURIComponent(chatId)}/tool-approvals/${encodeURIComponent(toolCallId)}`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            approved,
            ...(editedArguments !== undefined ? { editedArguments } : {}),
          }),
        },
      );
      if (res.ok) return;
      const errorBody = await res.text().catch(() => "");
      let message = "Tool approval failed.";
      if (errorBody.length > 0) {
        try {
          const parsed = JSON.parse(errorBody) as { error?: unknown };
          if (typeof parsed.error === "string" && parsed.error.length > 0) {
            message = parsed.error;
          }
        } catch {
          message = errorBody;
        }
      }
      get().addNotification(message, "error");
    } catch (err: unknown) {
      logError("Tool approval failed", err);
      get().addNotification(err instanceof Error ? err.message : "Tool approval failed.", "error");
    }
  },
}));
