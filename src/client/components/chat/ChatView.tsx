/**
 * @packageDocumentation
 * The primary workspace component for active chat sessions.
 * Manages message display, input, preset switching, and model interaction state.
 */

import { useNavigate, useParams } from "@tanstack/react-router";
import { Check, ChevronDown, Cpu, FileText, Settings2 } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  useBranchChat,
  useContinueChat,
  useInferencePresets,
  useRegenerateChat,
  useSystemPresets,
  useUpdateChat,
  useUpdateMessage,
} from "../../queries";
import { useAppStore } from "../../store";
import { useUiStore } from "../../uiStore";
import { InputBar } from "./InputBar";
import { MessageBubble } from "./MessageBubble";

/**
 * Main chat view container.
 * Handles scrolling, branching logic, regeneration, and preset switching chips.
 *
 * @returns React functional component.
 */
export function ChatView() {
  const { chatId } = useParams({ from: "/chat/$chatId" });
  const {
    messages,
    isGenerating,
    generationStats,
    serverStatus,
    currentChatId,
    currentChatMetadata,
    loadChat,
    sendMessage,
    stopGeneration,
    loadedModel,
    setError,
    errorMessage,
  } = useAppStore();
  const { setRightPanelView } = useUiStore();
  const bottomRef = useRef<HTMLDivElement>(null);
  const scrollContainerRef = useRef<HTMLDivElement>(null);
  const [isAutoScroll, setIsAutoScroll] = useState(true);
  const [showInfSwitch, setShowInfSwitch] = useState(false);
  const [showSysSwitch, setShowSysSwitch] = useState(false);

  const { data: infPresets } = useInferencePresets();
  const { data: sysPresets } = useSystemPresets();

  const branchMutation = useBranchChat();
  const updateMutation = useUpdateChat();
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

  const activeInfPreset =
    infPresets?.find((p) => p.id === currentChatMetadata?.inferencePresetId) ||
    (loadedModel
      ? infPresets?.find((p) => p.id === selectedInfPresets[loadedModel.primaryPath])
      : undefined) ||
    (loadedModel
      ? infPresets?.find((p) => p.sourceModelPath === loadedModel.primaryPath)
      : undefined) ||
    infPresets?.find((p) => p.isDefault);
  const activeSysPreset = sysPresets?.find((p) => p.id === currentChatMetadata?.systemPresetId);

  useEffect(() => {
    if (!chatId && !currentChatId) {
      loadChat("default-chat");
      return;
    }
    if (chatId && chatId !== currentChatId) {
      loadChat(chatId);
    }
  }, [chatId, currentChatId, loadChat]);

  useEffect(() => {
    if (currentChatId && currentChatId !== "default-chat" && chatId !== currentChatId) {
      navigate({ to: "/chat/$chatId", params: { chatId: currentChatId }, replace: true });
    }
  }, [currentChatId, chatId, navigate]);

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
      const { currentChatId, messages, setError, loadChat } = useAppStore.getState();
      if (!currentChatId) {
        setError("No active chat available for editing.");
        return;
      }
      const msgIndex = messages.findIndex((m) => m.id === messageId);
      if (msgIndex === -1) {
        setError("Message not found for editing.");
        return;
      }
      const msg = messages[msgIndex];
      if (!msg) {
        setError("Unable to resolve message for editing.");
        return;
      }

      try {
        if (msg.role === "user") {
          const isLast = msgIndex === messages.length - 1;
          if (isLast) {
            // Optimize: Overwrite and regenerate in-place without branching
            await updateMessageMutation.mutateAsync({
              chatId: currentChatId,
              messageId,
              content: newContent,
            });
            const res = await fetch(`/api/chats/${currentChatId}/regenerate`, {
              method: "POST",
            });
            if (!res.ok) throw new Error("Regeneration failed");
            await loadChat(currentChatId);
          } else {
            const res = await fetch(`/api/chats/${currentChatId}/branch-and-edit`, {
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
        }
      } catch (e: unknown) {
        console.error("Edit failed", e);
        setError(e instanceof Error ? e.message : "Failed to edit message.", "Retry", () =>
          handleEdit(messageId, newContent),
        );
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
        console.error("Branch failed", e);
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
        if (msgIndex < messages.length - 1) {
          const res = await fetch(`/api/chats/${currentChatId}/branch-and-regenerate`, {
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
          await regenerateMutation.mutateAsync(currentChatId);
        }
      } catch (e: unknown) {
        console.error("Regeneration failed", e);
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
          const res = await fetch(`/api/chats/${currentChatId}/branch-and-continue`, {
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
          await continueMutation.mutateAsync(currentChatId);
        }
      } catch (e: unknown) {
        console.error("Continue failed", e);
        setError(e instanceof Error ? e.message : "Failed to continue chat.", "Retry", () =>
          handleContinue(id),
        );
      }
    },
    [continueMutation, navigate],
  );

  const handleDelete = useCallback(async (id: string) => {
    const { currentChatId, setError, loadChat } = useAppStore.getState();
    if (!currentChatId) {
      setError("No active chat available for deletion.");
      return;
    }
    if (!confirm("Delete this and all subsequent messages?")) return;

    try {
      const res = await fetch(`/api/chats/${currentChatId}/messages/${id}`, {
        method: "DELETE",
      });
      if (!res.ok) {
        const errorBody = await res.text().catch(() => "");
        throw new Error(`Delete failed: ${res.status}${errorBody ? `: ${errorBody}` : ""}`);
      }
      await loadChat(currentChatId);
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : "Failed to delete message.");
    }
  }, []);

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
          loadChat(currentChatId);
        },
      },
    );
    setShowInfSwitch(false);
    setShowSysSwitch(false);
  };

  if ((!currentChatId || !currentChatMetadata) && errorMessage) {
    return (
      <div className="flex-1 flex flex-col items-center justify-center text-[var(--color-text-muted)] gap-4 p-8">
        <div className="text-lg font-semibold">Unable to load workspace</div>
        <div className="max-w-xl text-center text-sm">
          {errorMessage || "An error occurred while loading the chat."}
        </div>
        <button
          type="button"
          onClick={() => {
            setError(null);
            loadChat(chatId || "default-chat");
          }}
          className="px-4 py-2 rounded-xl bg-[var(--color-accent)] text-white text-sm hover:bg-[var(--color-accent-dim)] transition-colors">
          Retry
        </button>
      </div>
    );
  }

  if (!currentChatId || !currentChatMetadata) {
    return (
      <div className="flex-1 flex items-center justify-center text-[var(--color-text-muted)]">
        Loading workspace...
      </div>
    );
  }

  const active = serverStatus === "running";

  return (
    <div className="flex-1 flex flex-col bg-[var(--color-bg)] overflow-hidden">
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
              {(loadedModel.mmProjPath || loadedModel.metadata?.hasVisionEncoder) && (
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

        <div className="relative">
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
                <button
                  key={p.id}
                  type="button"
                  onClick={() => updatePreset("inference", p.id)}
                  className="w-full text-left px-3 py-1.5 text-xs hover:bg-[var(--color-accent)] hover:text-white transition-colors flex items-center justify-between group">
                  <span className="truncate">
                    {p.name} {p.isDefault ? "(Default)" : ""}
                  </span>
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
                </button>
              ))}
            </div>
          )}
        </div>

        <div className="relative">
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
                <button
                  key={p.id}
                  type="button"
                  onClick={() => updatePreset("system", p.id)}
                  className="w-full text-left px-3 py-1.5 text-xs hover:bg-[var(--color-accent)] hover:text-white transition-colors flex items-center justify-between group">
                  <span className="truncate">{p.name}</span>
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
                </button>
              ))}
            </div>
          )}
        </div>
      </div>

      {/* Messages Area */}
      <div
        ref={scrollContainerRef}
        onScroll={handleScroll}
        className="flex-1 overflow-y-auto p-6 scroll-smooth">
        {messages.length === 0 ? (
          <div className="h-full flex flex-col items-center justify-center text-[var(--color-text-muted)] space-y-4">
            <div className="text-4xl font-light mb-2">LlamaForge</div>
            {active ? (
              <p className="text-sm">Model allocated. Ready for interface.</p>
            ) : (
              <p className="text-sm">System idle. Allocate a model from the registry to begin.</p>
            )}
          </div>
        ) : (
          <div className="max-w-4xl mx-auto flex flex-col justify-end min-h-full">
            {messages
              .filter((msg) => msg.role !== "tool")
              .map((msg, i, arr) => (
                <MessageBubble
                  key={msg.id || i}
                  message={msg}
                  isStreaming={isGenerating && i === arr.length - 1 && msg.role === "assistant"}
                  onEdit={handleEdit}
                  onBranch={handleBranch}
                  onRegenerate={handleRegenerate}
                  onContinue={handleContinue}
                  onDelete={handleDelete}
                />
              ))}
            {isGenerating && messages[messages.length - 1]?.role === "user" && (
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
            {generationStats.promptTokens !== undefined &&
              generationStats.contextSize !== undefined && (
                <span className="flex items-center gap-1">
                  Context:{" "}
                  {(
                    (generationStats.promptTokens || 0) + (generationStats.totalPredicted || 0)
                  ).toLocaleString()}{" "}
                  / {generationStats.contextSize.toLocaleString()}
                </span>
              )}
            <span>Predicted: {generationStats.totalPredicted} tokens</span>
          </div>
        )}
        <div className="w-full max-w-4xl relative">
          <InputBar
            onSend={sendMessage}
            isGenerating={isGenerating}
            isActive={active}
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
