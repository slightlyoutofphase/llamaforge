/**
 * @packageDocumentation
 * The primary workspace component for active chat sessions.
 * Manages message display, input, preset switching, and model interaction state.
 */

import { resolveInferencePreset } from "@shared/inferencePresetResolve.js";
import { parseToolCallsJson } from "@shared/toolCalls.js";
import type { ChatMessage } from "@shared/types.js";
import { useNavigate, useParams } from "@tanstack/react-router";
import {
  Check,
  ChevronDown,
  ChevronUp,
  Cpu,
  FileText,
  MessageSquare,
  RefreshCw,
  Settings2,
  Terminal,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { request } from "../../http";
import { logError } from "../../logger";
import {
  useBranchChat,
  useContinueChat,
  useInferencePresets,
  useRegenerateChat,
  useSettings,
  useSystemPresets,
  useUpdateChat,
  useUpdateMessage,
} from "../../queries";
import { useAppStore } from "../../store";
import { useUiStore } from "../../uiStore";
import { InputBar } from "./InputBar";
import { MessageBubble } from "./MessageBubble";

/**
 * Walks backward past tool-result rows to find a user turn that still has no
 * assistant reply — for example after the model response was deleted.
 *
 * @param messages - Full in-memory transcript for the current chat.
 * @returns The pending user message, or `undefined` when a reply already exists.
 */
export function getPendingPromptMessage(messages: readonly ChatMessage[]): ChatMessage | undefined {
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i];
    if (!message || message.role === "tool") continue;
    return message.role === "user" ? message : undefined;
  }
  return undefined;
}

/**
 * Whether regenerating from `messageId` must fork a new chat so later user
 * turns on the current transcript are left intact.
 *
 * In-place regenerate is used when this turn is still the latest user prompt,
 * including the case where its assistant reply was deleted.
 *
 * @param messages - Current chat transcript in display order.
 * @param messageId - Message the user asked to regenerate from.
 * @returns `true` when a later user turn exists after `messageId`.
 */
export function regenerationRequiresBranch(
  messages: readonly Pick<ChatMessage, "id" | "role">[],
  messageId: string,
): boolean {
  const msgIndex = messages.findIndex((message) => message.id === messageId);
  if (msgIndex === -1) return false;
  return messages.slice(msgIndex + 1).some((message) => message.role === "user");
}

/**
 * Transcript kept for an in-place regenerate: the target user turn and everything
 * before it. Later assistant/tool rows are dropped so the replacement reply does
 * not append underneath the old one.
 *
 * Regenerating from an assistant or tool row walks back to that turn's user prompt.
 *
 * @param messages - Current chat transcript in display order.
 * @param messageId - Message the user asked to regenerate from.
 * @returns Messages through the associated user turn, inclusive.
 */
export function messagesKeptForInPlaceRegenerate(
  messages: readonly ChatMessage[],
  messageId: string,
): ChatMessage[] {
  const msgIndex = messages.findIndex((message) => message.id === messageId);
  if (msgIndex === -1) return [...messages];

  let keepThrough = msgIndex;
  const selected = messages[msgIndex];
  if (selected && selected.role !== "user") {
    keepThrough = msgIndex;
    while (keepThrough >= 0) {
      const current = messages[keepThrough];
      if (!current || current.role === "user") break;
      keepThrough--;
    }
  }
  if (keepThrough < 0) return messages.slice(0, msgIndex);
  return messages.slice(0, keepThrough + 1);
}

/**
 * Transcript remaining after deleting a message and every row after it.
 *
 * @param messages - Current chat transcript in display order.
 * @param messageId - Message the user asked to delete.
 * @returns Messages strictly before `messageId`, or a copy of `messages` when it is missing.
 */
export function messagesRemainingAfterDelete(
  messages: readonly ChatMessage[],
  messageId: string,
): ChatMessage[] {
  const msgIndex = messages.findIndex((message) => message.id === messageId);
  if (msgIndex === -1) return [...messages];
  return messages.slice(0, msgIndex);
}

/**
 * Adjusts the paginated message total after dropping trailing rows from the
 * currently loaded window, without pretending older unloaded rows are gone.
 *
 * @param totalMessages - Server-reported transcript length.
 * @param visibleCount - Number of messages currently loaded in the client.
 * @param remainingVisibleCount - Number of loaded messages kept after the drop.
 * @returns Updated total that preserves any older messages not in the window.
 */
export function totalMessagesAfterDrop(
  totalMessages: number,
  visibleCount: number,
  remainingVisibleCount: number,
): number {
  const dropped = Math.max(0, visibleCount - remainingVisibleCount);
  return Math.max(remainingVisibleCount, totalMessages - dropped);
}

/**
 * S12 fix: Lightweight inline display for tool execution results.
 * Renders as a collapsible card attached to the parent assistant message,
 * so tool outputs are visible without appearing as standalone message bubbles.
 *
 * @param props - Wrapper props containing the tool result message to display.
 * @returns Inline tool result card.
 */
function ToolResultInline({ message }: { message: ChatMessage }) {
  const [showResult, setShowResult] = useState(false);
  const contentPreview =
    message.content.length > 120 ? `${message.content.slice(0, 120)}...` : message.content;

  return (
    <div className="ml-1 mt-1 mb-4 border border-[var(--color-border)] rounded-xl bg-[var(--color-surface-elevated)]/50 overflow-hidden text-xs">
      <button
        type="button"
        onClick={() => setShowResult(!showResult)}
        className="w-full flex items-center justify-between px-3 py-2 hover:bg-[var(--color-bg)] transition-colors">
        <div className="flex items-center gap-2 text-[var(--color-text-muted)]">
          <Terminal size={12} className="text-[var(--color-accent)]" />
          <span className="font-mono font-semibold">
            Tool Result{message.toolCallId ? ` · ${message.toolCallId.slice(0, 8)}` : ""}
          </span>
          {!showResult && (
            <span className="text-[var(--color-text-muted)] truncate max-w-[300px]">
              — {contentPreview}
            </span>
          )}
        </div>
        {showResult ? <ChevronUp size={12} /> : <ChevronDown size={12} />}
      </button>
      {showResult && (
        <div className="px-3 pb-3 pt-1 border-t border-[var(--color-border)]">
          <pre className="font-mono text-[var(--color-text-secondary)] bg-[var(--color-bg)] p-3 rounded-lg whitespace-pre-wrap break-all max-h-64 overflow-y-auto border border-[var(--color-border)]">
            {message.content}
          </pre>
        </div>
      )}
    </div>
  );
}

/**
 * Main chat view container.
 * Handles scrolling, branching logic, regeneration, and preset switching chips.
 *
 * @returns React functional component.
 */
export function ChatView() {
  const { chatId } = useParams({ from: "/chat/$chatId" });
  const messages = useAppStore((s) => s.messages);
  const isGenerating = useAppStore((s) => s.isGenerating);
  const isWaitingForToolApproval = useAppStore((s) => s.isWaitingForToolApproval);
  const generationStats = useAppStore((s) => s.generationStats);
  const serverStatus = useAppStore((s) => s.serverStatus);
  const currentChatId = useAppStore((s) => s.currentChatId);
  const currentChatMetadata = useAppStore((s) => s.currentChatMetadata);
  const loadChat = useAppStore((s) => s.loadChat);
  const sendMessage = useAppStore((s) => s.sendMessage);
  const stopGeneration = useAppStore((s) => s.stopGeneration);
  const loadedModel = useAppStore((s) => s.loadedModel);
  const setError = useAppStore((s) => s.setError);
  const errorMessage = useAppStore((s) => s.errorMessage);
  const isConnected = useAppStore((s) => s.isConnected);
  const totalMessages = useAppStore((s) => s.totalMessages);
  const loadMoreMessages = useAppStore((s) => s.loadMoreMessages);
  const unloadChat = useAppStore((s) => s.unloadChat);
  const { setRightPanelView } = useUiStore();
  const bottomRef = useRef<HTMLDivElement>(null);
  const scrollContainerRef = useRef<HTMLDivElement>(null);
  const [isAutoScroll, setIsAutoScroll] = useState(true);
  const [showInfSwitch, setShowInfSwitch] = useState(false);
  const [showSysSwitch, setShowSysSwitch] = useState(false);
  // S10 fix: refs for outside-click dismiss
  const infDropdownRef = useRef<HTMLDivElement>(null);
  const sysDropdownRef = useRef<HTMLDivElement>(null);
  const toolResultsByCallId = useMemo(() => {
    const map = new Map<string, (typeof messages)[number]>();
    for (const message of messages) {
      if (message.role === "tool" && message.toolCallId) {
        map.set(message.toolCallId, message);
      }
    }
    return map;
  }, [messages]);
  const pendingPrompt = useMemo(() => getPendingPromptMessage(messages), [messages]);

  // S10 fix: close dropdowns when clicking outside
  useEffect(() => {
    /**
     * Closes preset dropdown menus when the user clicks outside their containers.
     *
     * @param e - Mouse event raised on the document.
     * @returns No return value.
     */
    const handleClickOutside = (e: MouseEvent) => {
      if (
        showInfSwitch &&
        infDropdownRef.current &&
        !infDropdownRef.current.contains(e.target as Node)
      ) {
        setShowInfSwitch(false);
      }
      if (
        showSysSwitch &&
        sysDropdownRef.current &&
        !sysDropdownRef.current.contains(e.target as Node)
      ) {
        setShowSysSwitch(false);
      }
    };
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, [showInfSwitch, showSysSwitch]);

  const { data: infPresets } = useInferencePresets();
  const { data: settings } = useSettings();
  const { data: sysPresets } = useSystemPresets();

  const branchMutation = useBranchChat();
  const updateMutation = useUpdateChat();
  const persistChatUpdates = updateMutation.mutate;
  const updateMessageMutation = useUpdateMessage();
  const regenerateMutation = useRegenerateChat();
  const continueMutation = useContinueChat();
  const navigate = useNavigate();

  const [selectedInfPresets, setSelectedInfPresets] = useState<Record<string, string>>(() => {
    try {
      return JSON.parse(localStorage.getItem("lf_selectedInfPresets") || "{}");
    } catch {
      return {};
    }
  });

  useEffect(() => {
    localStorage.setItem("lf_selectedInfPresets", JSON.stringify(selectedInfPresets));
  }, [selectedInfPresets]);

  const activeInfPreset = resolveInferencePreset(infPresets ?? [], {
    chatPresetId: currentChatMetadata?.inferencePresetId,
    preferredPresetId: loadedModel ? selectedInfPresets[loadedModel.primaryPath] : undefined,
    modelPath: loadedModel?.primaryPath,
  });
  const activeSysPreset = sysPresets?.find((p) => p.id === currentChatMetadata?.systemPresetId);
  const bubbleStyle = settings?.chatBubbleStyle ?? "bubble";

  useEffect(() => {
    // S12 fix: only load if we have a real target chat ID from the route.
    // If we're on a virtual path or the home page, don't try to load anything from the server.
    if (!chatId || chatId === "default" || chatId === "default-chat") {
      if (currentChatId) {
        unloadChat();
      }
      return;
    }

    if (chatId !== currentChatId) {
      loadChat(chatId);
    }
  }, [chatId, currentChatId, loadChat, unloadChat]);

  useEffect(() => {
    if (
      (chatId === "default-chat" || chatId === "default") &&
      currentChatId &&
      currentChatId !== "default-chat" &&
      currentChatId !== "default" &&
      currentChatId !== chatId
    ) {
      navigate({ to: "/chat/$chatId", params: { chatId: currentChatId }, replace: true });
    }
  }, [currentChatId, chatId, navigate]);

  const isSyncingHistory = useAppStore((s) => s.isSyncingHistory);
  const requestInFlight = isGenerating || isWaitingForToolApproval || isSyncingHistory;
  const activeInfPresetId = activeInfPreset?.id;
  const persistedInferencePresetId = currentChatMetadata?.inferencePresetId;
  const hasChatMetadata = Boolean(currentChatMetadata);

  useEffect(() => {
    if (!currentChatId || !activeInfPresetId || !hasChatMetadata) return;
    if (persistedInferencePresetId === activeInfPresetId) return;

    const state = useAppStore.getState();
    if (state.currentChatId !== currentChatId) return;

    // Bind locally first. The mutation object from useMutation changes on every
    // in-flight PUT, and new chats start with a null preset id — without this,
    // the effect re-enters and floods PUT /api/chats/:id.
    state.patchCurrentChatMetadata({ inferencePresetId: activeInfPresetId });
    persistChatUpdates({ id: currentChatId, updates: { inferencePresetId: activeInfPresetId } });
  }, [
    activeInfPresetId,
    currentChatId,
    hasChatMetadata,
    persistChatUpdates,
    persistedInferencePresetId,
  ]);

  /**
   * Tracks whether the chat scroller is still close enough to the bottom for auto-scroll.
   *
   * @returns No return value.
   */
  const handleScroll = () => {
    if (!scrollContainerRef.current) return;
    const { scrollTop, scrollHeight, clientHeight } = scrollContainerRef.current;
    // Auto-scroll if we are within 50px of the bottom
    const isAtBottom = scrollHeight - Math.ceil(scrollTop) - clientHeight < 50;
    setIsAutoScroll(isAtBottom);
  };

  const lastScrollTimeRef = useRef<number>(0);

  // biome-ignore lint/correctness/useExhaustiveDependencies: Only scroll if isGenerating and isAutoScroll
  useEffect(() => {
    let frameId: number;
    const now = Date.now();
    // Throttle scroll to max once every 100ms to prevent thrashing
    if (isAutoScroll && isGenerating && now - lastScrollTimeRef.current > 100) {
      lastScrollTimeRef.current = now;
      frameId = requestAnimationFrame(() => {
        bottomRef.current?.scrollIntoView({ behavior: "auto" });
      });
    }
    return () => {
      if (frameId) cancelAnimationFrame(frameId);
    };
  }, [messages, isGenerating, isAutoScroll]);

  const handleEdit = useCallback(
    async (messageId: string, newContent: string) => {
      const { currentChatId, messages, setError } = useAppStore.getState();
      if (!currentChatId) {
        const error = new Error("No active chat available for editing.");
        setError(error.message);
        throw error;
      }
      const msgIndex = messages.findIndex((m) => m.id === messageId);
      if (msgIndex === -1) {
        const error = new Error("Message not found for editing.");
        setError(error.message);
        throw error;
      }
      const msg = messages[msgIndex];
      if (!msg) {
        const error = new Error("Unable to resolve message for editing.");
        setError(error.message);
        throw error;
      }

      try {
        if (msg.role === "user") {
          if (!regenerationRequiresBranch(messages, messageId)) {
            await updateMessageMutation.mutateAsync({
              chatId: currentChatId,
              messageId,
              content: newContent,
            });
            const updated = messages.map((message) =>
              message.id === messageId
                ? { ...message, content: newContent, rawContent: newContent }
                : message,
            );
            const kept = messagesKeptForInPlaceRegenerate(updated, messageId);
            useAppStore.setState({
              messages: kept,
              totalMessages: totalMessagesAfterDrop(
                useAppStore.getState().totalMessages,
                updated.length,
                kept.length,
              ),
              isGenerating: true,
              generationStats: null,
            });
            const res = await request(`/api/chats/${currentChatId}/regenerate`, {
              method: "POST",
            });
            if (!res.ok) throw new Error("Regeneration failed");
          } else {
            const res = await request(`/api/chats/${currentChatId}/branch-and-edit`, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ messageId, newContent }),
            });
            if (!res.ok) {
              const errorBody = await res.text().catch(() => "");
              throw new Error(
                `Branch and Edit failed: ${res.status}${errorBody ? `: ${errorBody}` : ""}`,
              );
            }
            const data = await res.json();
            const newChatId = data?.id;
            if (!newChatId) throw new Error("Response missing chat id.");

            navigate({ to: "/chat/$chatId", params: { chatId: newChatId } });
          }
        } else {
          await updateMessageMutation.mutateAsync({
            chatId: currentChatId,
            messageId,
            content: newContent,
            ...(msg.thinkingContent !== undefined ? { thinkingContent: msg.thinkingContent } : {}),
          });
          useAppStore.getState().patchMessage(messageId, {
            content: newContent,
            rawContent: newContent,
          });
        }
      } catch (e: unknown) {
        logError("Edit failed", e);
        const { currentChatId: chatId, loadChat } = useAppStore.getState();
        if (chatId) {
          await loadChat(chatId);
        }
        setError(e instanceof Error ? e.message : "Failed to edit message.", "Retry", () =>
          handleEdit(messageId, newContent),
        );
        throw e;
      }
    },
    [navigate, updateMessageMutation],
  );

  const handleBranch = useCallback(
    async (id: string) => {
      const { currentChatId, setError } = useAppStore.getState();
      if (!currentChatId) {
        setError("No active chat available for branching.");
        return;
      }
      if (!id) {
        setError("Cannot branch from an invalid message.");
        return;
      }
      try {
        const newChat = await branchMutation.mutateAsync({ id: currentChatId, messageId: id });
        if (!newChat?.id) throw new Error("Branch response missing new chat id.");
        navigate({ to: "/chat/$chatId", params: { chatId: newChat.id } });
      } catch (e: unknown) {
        logError("Branch failed", e);
        setError(e instanceof Error ? e.message : "Failed to create branch.", "Retry", () =>
          handleBranch(id),
        );
      }
    },
    [branchMutation, navigate],
  );

  const handleRegenerate = useCallback(
    async (id: string) => {
      const { currentChatId, messages, setError } = useAppStore.getState();
      if (!currentChatId) {
        setError("No active chat available for regeneration.");
        return;
      }
      const msgIndex = messages.findIndex((m) => m.id === id);
      if (msgIndex === -1) {
        setError("Message not found for regeneration.");
        return;
      }

      try {
        if (regenerationRequiresBranch(messages, id)) {
          const res = await request(`/api/chats/${currentChatId}/branch-and-regenerate`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ messageId: id }),
          });
          if (!res.ok) {
            const errorBody = await res.text().catch(() => "");
            throw new Error(
              `Branch and Regenerate failed: ${res.status}${errorBody ? `: ${errorBody}` : ""}`,
            );
          }
          const data = await res.json();
          const newChatId = data?.id;
          if (!newChatId) throw new Error("Response missing chat id.");

          navigate({ to: "/chat/$chatId", params: { chatId: newChatId } });
        } else {
          const kept = messagesKeptForInPlaceRegenerate(messages, id);
          useAppStore.setState({
            messages: kept,
            totalMessages: totalMessagesAfterDrop(
              useAppStore.getState().totalMessages,
              messages.length,
              kept.length,
            ),
            isGenerating: true,
            generationStats: null,
          });
          await regenerateMutation.mutateAsync(currentChatId);
        }
      } catch (e: unknown) {
        logError("Regeneration failed", e);
        const { currentChatId: chatId, loadChat } = useAppStore.getState();
        if (chatId) {
          await loadChat(chatId);
        }
        setError(e instanceof Error ? e.message : "Failed to regenerate chat.", "Retry", () =>
          handleRegenerate(id),
        );
      }
    },
    [navigate, regenerateMutation],
  );

  const handleContinue = useCallback(
    async (id: string) => {
      const { currentChatId, messages, setError } = useAppStore.getState();
      if (!currentChatId) {
        setError("No active chat available for continuation.");
        return;
      }
      const msgIndex = messages.findIndex((m) => m.id === id);
      if (msgIndex === -1) {
        setError("Message not found for continuation.");
        return;
      }

      try {
        if (msgIndex < messages.length - 1) {
          const res = await request(`/api/chats/${currentChatId}/branch-and-continue`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ messageId: id }),
          });
          if (!res.ok) {
            const errorBody = await res.text().catch(() => "");
            throw new Error(
              `Branch and Continue failed: ${res.status}${errorBody ? `: ${errorBody}` : ""}`,
            );
          }
          const data = await res.json();
          const newChatId = data?.id;
          if (!newChatId) throw new Error("Response missing chat id.");

          navigate({ to: "/chat/$chatId", params: { chatId: newChatId } });
        } else {
          useAppStore.setState({ isGenerating: true, generationStats: null });
          await continueMutation.mutateAsync(currentChatId);
        }
      } catch (e: unknown) {
        logError("Continue failed", e);
        const { currentChatId: chatId, loadChat } = useAppStore.getState();
        if (chatId) {
          await loadChat(chatId);
        }
        setError(e instanceof Error ? e.message : "Failed to continue chat.", "Retry", () =>
          handleContinue(id),
        );
      }
    },
    [continueMutation, navigate],
  );

  const handleDelete = useCallback(async (id: string) => {
    const {
      currentChatId,
      messages,
      setError,
      loadChat,
      stopGeneration,
      discardPendingChatFrames,
    } = useAppStore.getState();
    if (!currentChatId) {
      setError("No active chat available for deletion.");
      return;
    }
    if (!id) {
      setError("Cannot delete an invalid message.");
      return;
    }
    if (!confirm("Delete this and all subsequent messages?")) return;

    stopGeneration();
    discardPendingChatFrames(currentChatId);
    useAppStore.setState({ isSyncingHistory: true });

    try {
      const res = await request(`/api/chats/${currentChatId}/messages/${id}`, {
        method: "DELETE",
      });
      if (res.status === 404) {
        await loadChat(currentChatId);
        return;
      }
      if (!res.ok) {
        const errorBody = await res.text().catch(() => "");
        throw new Error(`Delete failed: ${res.status}${errorBody ? `: ${errorBody}` : ""}`);
      }
      const remaining = messagesRemainingAfterDelete(messages, id);
      useAppStore.setState({
        messages: remaining,
        totalMessages: totalMessagesAfterDrop(
          useAppStore.getState().totalMessages,
          messages.length,
          remaining.length,
        ),
      });
      await loadChat(currentChatId);
    } catch (e: unknown) {
      await loadChat(currentChatId);
      setError(e instanceof Error ? e.message : "Failed to delete message.");
    } finally {
      useAppStore.setState({ isSyncingHistory: false });
    }
  }, []);

  /**
   * Applies a new inference or system preset to the current chat.
   *
   * @param type - Preset category to update.
   * @param presetId - Identifier of the selected preset.
   * @returns No return value.
   */
  const updatePreset = (type: "inference" | "system", presetId: string) => {
    if (!currentChatId) {
      setError("No active chat available for preset update.");
      return;
    }

    if (type === "inference" && loadedModel) {
      setSelectedInfPresets((prev) => ({ ...prev, [loadedModel.primaryPath]: presetId }));
    }

    const updates =
      type === "inference" ? { inferencePresetId: presetId } : { systemPresetId: presetId };
    updateMutation.mutate(
      { id: currentChatId, updates },
      {
        onSuccess: () => {
          useAppStore.getState().patchCurrentChatMetadata(updates);
        },
      },
    );
    setShowInfSwitch(false);
    setShowSysSwitch(false);
  };

  if ((!currentChatId || !currentChatMetadata) && errorMessage) {
    const isNotFound =
      errorMessage.toLowerCase().includes("not found") || errorMessage.includes("404");
    return (
      <div className="flex-1 flex flex-col items-center justify-center text-[var(--color-text-muted)] gap-6 p-8 animate-in fade-in duration-500">
        <div className="w-16 h-16 rounded-full bg-[var(--color-surface-elevated)] flex items-center justify-center mb-2">
          <MessageSquare size={32} className="text-[var(--color-accent)] opacity-50" />
        </div>
        <div className="text-xl font-bold text-[var(--color-text-primary)]">
          {isNotFound ? "Transmission Lost" : "Workspace Error"}
        </div>
        <div className="max-w-md text-center text-sm leading-relaxed opacity-80">
          {isNotFound
            ? "The chat session you're looking for either never existed or was purged from the archive."
            : errorMessage}
        </div>
        <div className="flex gap-3">
          <button
            type="button"
            onClick={() => {
              setError(null);
              loadChat("default-chat");
            }}
            className="px-6 py-2.5 rounded-xl bg-[var(--color-accent)] text-white text-sm font-semibold hover:opacity-90 transition-all active:scale-95 shadow-lg shadow-[var(--color-accent)]/20">
            Initialize New Chat
          </button>
          <button
            type="button"
            onClick={() => {
              setError(null);
              navigate({ to: "/" });
            }}
            className="px-6 py-2.5 rounded-xl border border-[var(--color-border)] text-[var(--color-text-primary)] text-sm font-semibold hover:bg-[var(--color-surface-elevated)] transition-all">
            Return to Registry
          </button>
        </div>
      </div>
    );
  }

  if (!currentChatId && chatId !== "default" && chatId !== "default-chat") {
    return (
      <div className="flex-1 flex flex-col items-center justify-center text-[var(--color-text-muted)] gap-4">
        <div className="w-8 h-8 border-4 border-[var(--color-accent)] border-t-transparent rounded-full animate-spin" />
        <p className="text-xs uppercase tracking-widest font-mono">Synchronizing Workspace...</p>
      </div>
    );
  }

  const active = serverStatus === "running" && isConnected;

  return (
    <div className="flex-1 min-h-0 flex flex-col bg-[var(--color-bg)] overflow-hidden">
      {/* Header Chips */}
      <div className="h-12 border-b border-[var(--color-border)] bg-[var(--color-surface)] flex items-center px-4 space-x-2 shrink-0 z-30 shadow-sm">
        <button
          type="button"
          className="flex items-center space-x-1.5 px-3 py-1 text-xs font-semibold rounded-full border border-[var(--color-border)] bg-[var(--color-bg)] hover:bg-[var(--color-surface-elevated)] transition-colors data-[active=true]:border-[var(--color-accent)] data-[active=true]:text-[var(--color-accent)]"
          data-active={active}
          onClick={() => setRightPanelView("modelLibrary")}>
          <Cpu size={14} />
          <span className="truncate max-w-[200px]">
            {loadedModel?.modelName || "No Model Loaded"}
          </span>
          {loadedModel && (
            <div className="flex gap-1">
              {loadedModel.metadata?.hasVisionEncoder && (
                <div
                  className="w-1.5 h-1.5 rounded-full bg-blue-500 animate-pulse"
                  title="Vision Capable"
                />
              )}
              {loadedModel.metadata?.hasAudioEncoder && (
                <div
                  className="w-1.5 h-1.5 rounded-full bg-purple-500 animate-pulse"
                  title="Audio Capable"
                />
              )}
            </div>
          )}
          <ChevronDown size={14} className="opacity-50" />
        </button>

        <div className="relative" ref={infDropdownRef}>
          <button
            type="button"
            className="flex items-center space-x-1.5 px-3 py-1 text-xs font-semibold rounded-full border border-[var(--color-border)] bg-[var(--color-bg)] hover:bg-[var(--color-surface-elevated)] transition-colors text-[var(--color-text-secondary)]"
            onClick={() => setShowInfSwitch(!showInfSwitch)}>
            <Settings2 size={14} />
            <span>Inf: {activeInfPreset?.name || "Standard"}</span>
            <ChevronDown size={14} className="opacity-50" />
          </button>
          {showInfSwitch && (
            <div className="absolute top-full left-0 mt-1 w-48 bg-[var(--color-surface-elevated)] border border-[var(--color-border)] rounded-lg shadow-xl py-1 z-50">
              <div className="px-3 py-1 text-[10px] font-bold text-[var(--color-text-muted)] uppercase tracking-wider border-b border-[var(--color-border)] mb-1">
                Pick Inference Preset
              </div>
              {infPresets?.map((p) => (
                <div
                  key={p.id}
                  className="w-full px-3 py-1.5 text-xs hover:bg-[var(--color-accent)] hover:text-white transition-colors flex items-center justify-between group">
                  <button
                    type="button"
                    onClick={() => updatePreset("inference", p.id)}
                    className="min-w-0 flex-1 text-left truncate">
                    {p.name} {p.isDefault ? "(Default)" : ""}
                  </button>
                  <button
                    type="button"
                    onClick={(e) => {
                      e.stopPropagation();
                      setRightPanelView("inferencePreset", p.id);
                      setShowInfSwitch(false);
                    }}
                    className="opacity-0 group-hover:opacity-100 p-0.5 hover:bg-white/20 rounded">
                    <Settings2 size={12} />
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>

        <div className="relative" ref={sysDropdownRef}>
          <button
            type="button"
            className="flex items-center space-x-1.5 px-3 py-1 text-xs font-semibold rounded-full border border-[var(--color-border)] bg-[var(--color-bg)] hover:bg-[var(--color-surface-elevated)] transition-colors text-[var(--color-text-secondary)]"
            onClick={() => setShowSysSwitch(!showSysSwitch)}>
            <FileText size={14} />
            <span>Sys: {activeSysPreset?.name || "None"}</span>
            <ChevronDown size={14} className="opacity-50" />
          </button>
          {showSysSwitch && (
            <div className="absolute top-full left-0 mt-1 w-48 bg-[var(--color-surface-elevated)] border border-[var(--color-border)] rounded-lg shadow-xl py-1 z-50">
              <div className="px-3 py-1 text-[10px] font-bold text-[var(--color-text-muted)] uppercase tracking-wider border-b border-[var(--color-border)] mb-1">
                Pick System Prompt
              </div>
              <button
                type="button"
                onClick={() => updatePreset("system", "")}
                className="w-full text-left px-3 py-1.5 text-xs hover:bg-[var(--color-accent)] hover:text-white transition-colors">
                None
              </button>
              {sysPresets?.map((p) => (
                <div
                  key={p.id}
                  className="w-full px-3 py-1.5 text-xs hover:bg-[var(--color-accent)] hover:text-white transition-colors flex items-center justify-between group">
                  <button
                    type="button"
                    onClick={() => updatePreset("system", p.id)}
                    className="min-w-0 flex-1 text-left truncate">
                    {p.name}
                  </button>
                  <button
                    type="button"
                    onClick={(e) => {
                      e.stopPropagation();
                      setRightPanelView("systemPreset", p.id);
                      setShowSysSwitch(false);
                    }}
                    className="opacity-0 group-hover:opacity-100 p-0.5 hover:bg-white/20 rounded">
                    <Settings2 size={12} />
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>

      {/* Messages Area */}
      <div
        ref={scrollContainerRef}
        onScroll={handleScroll}
        className="flex-1 min-h-0 overflow-y-auto p-6 scroll-smooth">
        {messages.length === 0 ? (
          <div className="h-full flex flex-col items-center justify-center text-[var(--color-text-muted)] space-y-6 animate-in fade-in zoom-in duration-700">
            <div className="text-5xl font-bold tracking-tighter text-[var(--color-text-primary)]">
              LlamaForge
            </div>
            {active ? (
              <div className="flex flex-col items-center gap-4">
                <div className="px-4 py-2 rounded-full bg-[var(--color-success)]/10 text-[var(--color-success)] text-xs font-bold uppercase tracking-widest border border-[var(--color-success)]/20">
                  Core Online
                </div>
                <p className="text-sm opacity-70">Model allocated. Ready for transmission.</p>
                <div className="mt-4 flex flex-col items-center gap-2">
                  <div className="w-px h-12 bg-gradient-to-b from-[var(--color-accent)] to-transparent" />
                  <span className="text-[10px] uppercase tracking-[0.2em] font-bold text-[var(--color-accent)]">
                    Type below to begin
                  </span>
                </div>
              </div>
            ) : (
              <div className="flex flex-col items-center gap-6">
                <div className="px-4 py-2 rounded-full bg-[var(--color-warning)]/10 text-[var(--color-warning)] text-xs font-bold uppercase tracking-widest border border-[var(--color-warning)]/20">
                  System Idle
                </div>
                <p className="text-sm opacity-70 max-w-xs text-center">
                  The interface is currently dormant. Allocate a model from the registry to activate
                  the workspace.
                </p>
                <button
                  type="button"
                  onClick={() => navigate({ to: "/" })}
                  className="px-6 py-2.5 rounded-xl bg-[var(--color-accent)] text-white text-sm font-semibold hover:opacity-90 transition-all active:scale-95 shadow-xl shadow-[var(--color-accent)]/20">
                  Go to Model Registry
                </button>
              </div>
            )}
          </div>
        ) : (
          <div className="max-w-4xl mx-auto flex flex-col justify-end min-h-full">
            {/* M10 fix: show a "Load More" button when there are older messages not yet loaded */}
            {totalMessages > messages.length && (
              <div className="flex justify-center py-4">
                <button
                  type="button"
                  onClick={loadMoreMessages}
                  className="px-4 py-2 text-xs font-semibold rounded-xl border border-[var(--color-border)] bg-[var(--color-surface-elevated)] text-[var(--color-text-secondary)] hover:bg-[var(--color-accent)] hover:text-white hover:border-[var(--color-accent)] transition-colors">
                  Load {Math.min(500, totalMessages - messages.length)} older messages
                  <span className="ml-2 text-[var(--color-text-muted)]">
                    ({messages.length} / {totalMessages})
                  </span>
                </button>
              </div>
            )}
            {/* S12 fix: render tool messages as inline result cards instead of filtering them out */}
            {messages
              .filter((msg) => msg.role !== "tool")
              .map((msg, i, arr) => {
                const parsedToolCalls =
                  msg.role === "assistant" ? parseToolCallsJson(msg.toolCallsJson) : null;
                const toolResults =
                  parsedToolCalls
                    ?.map((tc) => toolResultsByCallId.get(tc.id))
                    .filter((m): m is NonNullable<typeof m> => Boolean(m)) ?? [];
                return (
                  <div key={msg.id || i}>
                    <MessageBubble
                      bubbleStyle={bubbleStyle}
                      message={msg}
                      isStreaming={isGenerating && i === arr.length - 1 && msg.role === "assistant"}
                      onEdit={handleEdit}
                      onBranch={handleBranch}
                      onRegenerate={handleRegenerate}
                      onContinue={handleContinue}
                      onDelete={handleDelete}
                    />
                    {toolResults.map((toolMsg) => (
                      <ToolResultInline key={toolMsg.id} message={toolMsg} />
                    ))}
                  </div>
                );
              })}
            {requestInFlight && pendingPrompt && (
              <div className="flex px-5 py-4 animate-pulse">
                <div className="flex gap-1 text-[var(--color-accent)] opacity-70">
                  <span
                    className="w-2 h-2 bg-current rounded-full animate-bounce"
                    style={{ animationDelay: "0ms" }}></span>
                  <span
                    className="w-2 h-2 bg-current rounded-full animate-bounce"
                    style={{ animationDelay: "150ms" }}></span>
                  <span
                    className="w-2 h-2 bg-current rounded-full animate-bounce"
                    style={{ animationDelay: "300ms" }}></span>
                </div>
              </div>
            )}
            {!requestInFlight && pendingPrompt && (
              <div className="flex justify-start px-1 py-2">
                <button
                  type="button"
                  data-testid="generate-response"
                  disabled={!active}
                  onClick={() => handleRegenerate(pendingPrompt.id)}
                  title="Generate a model response to this message"
                  className="flex items-center gap-2 px-3 py-1.5 text-xs font-semibold rounded-xl border border-[var(--color-border)] bg-[var(--color-surface-elevated)] text-[var(--color-text-secondary)] hover:bg-[var(--color-accent)] hover:text-white hover:border-[var(--color-accent)] transition-colors disabled:opacity-50 disabled:pointer-events-none">
                  <RefreshCw size={14} />
                  Generate response
                </button>
              </div>
            )}
            <div ref={bottomRef} className="h-4" />
          </div>
        )}
      </div>

      {/* Input Area */}
      <div className="shrink-0 p-4 bg-[var(--color-surface)] border-t border-[var(--color-border)] flex flex-col items-center relative z-20">
        {generationStats && (
          <div className="w-full max-w-4xl flex justify-end mb-2 text-[10px] text-[var(--color-text-muted)] font-mono gap-4 animate-in fade-in slide-in-from-bottom-1 duration-300">
            {generationStats.stopReason === "contextLengthReached" && (
              <span className="text-red-400 font-bold flex items-center gap-1 uppercase tracking-widest">
                Context Window Exceeded
              </span>
            )}
            {generationStats.tokensCached > 0 && (
              <span className="flex items-center gap-1 text-[var(--color-success)]">
                <Check size={10} /> Tokens Cached: {generationStats.tokensCached}
              </span>
            )}
            <span>Predicted: {generationStats.totalPredicted} tokens</span>
          </div>
        )}
        <div className="w-full max-w-4xl relative">
          <InputBar
            key={chatId}
            conversationId={chatId}
            onSend={(content, files) => sendMessage(content, files, activeInfPreset?.id)}
            isGenerating={isGenerating || isWaitingForToolApproval}
            isActive={active}
            historyLocked={isSyncingHistory}
            onStop={stopGeneration}
          />
        </div>
        <div className="text-center mt-2 text-[10px] uppercase tracking-widest text-[var(--color-text-muted)] font-mono">
          LlamaForge Context Interface
        </div>
      </div>
    </div>
  );
}
