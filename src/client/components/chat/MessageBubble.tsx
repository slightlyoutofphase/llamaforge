/**
 * @packageDocumentation
 * Component for individual message bubbles in the chat log.
 * Handles markdown rendering, tool call cards, thinking blocks, and message action toolbars.
 */

import type { ChatMessage } from "../../../shared/types";
import { parseToolCallsJson } from "../../../shared/toolCalls";
import { Check, FileText, X } from "lucide-react";
import React, { useEffect, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import rehypeHighlight from "rehype-highlight";
import rehypeKatex from "rehype-katex";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import { useAppStore } from "../../store";
import { MessageActions } from "./MessageActions";
import { ThinkingBlock } from "./ThinkingBlock";
import { ToolCard } from "./ToolCard";

const REMARK_PLUGINS = [remarkGfm, remarkMath];
const REHYPE_PLUGINS = [rehypeHighlight, rehypeKatex];

/**
 * Copies text using the clipboard API, falling back to a hidden textarea when
 * `navigator.clipboard` is unavailable (non-secure HTTP origins).
 *
 * @param text - Text to place on the clipboard.
 * @returns Whether the copy succeeded.
 */
async function copyTextToClipboard(text: string): Promise<boolean> {
  try {
    if (typeof navigator !== "undefined" && navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    // Fall through to the execCommand fallback.
  }

  try {
    const textarea = document.createElement("textarea");
    textarea.value = text;
    textarea.setAttribute("readonly", "");
    textarea.style.position = "fixed";
    textarea.style.left = "-9999px";
    document.body.appendChild(textarea);
    textarea.select();
    const ok = document.execCommand("copy");
    document.body.removeChild(textarea);
    return ok;
  } catch {
    return false;
  }
}

/**
 * Compares two message metric payloads to avoid unnecessary rerenders.
 *
 * @param prev - Previous metrics object associated with the message.
 * @param next - Next metrics object associated with the message.
 * @returns `true` when both metric objects are effectively identical.
 */
function hasSameMetrics(prev: ChatMessage["metrics"], next: ChatMessage["metrics"]): boolean {
  if (prev === next) return true;
  if (!prev || !next) return !prev && !next;

  return (
    prev.predictedTokens === next.predictedTokens &&
    prev.tokensPerSecond === next.tokensPerSecond &&
    prev.promptTokens === next.promptTokens &&
    prev.promptTokensPerSecond === next.promptTokensPerSecond &&
    prev.cachedPromptTokens === next.cachedPromptTokens &&
    prev.evaluatedPromptTokens === next.evaluatedPromptTokens
  );
}

/**
 * Compares two attachment lists to determine whether the rendered attachments changed.
 *
 * @param prev - Previous attachment list for the message.
 * @param next - Next attachment list for the message.
 * @returns `true` when both attachment lists contain the same attachment metadata.
 */
function hasSameAttachments(
  prev: ChatMessage["attachments"],
  next: ChatMessage["attachments"],
): boolean {
  if (prev === next) return true;
  if (!prev || !next) return !prev && !next;
  if (prev.length !== next.length) return false;

  return prev.every((attachment, index) => {
    const nextAttachment = next[index];
    return (
      attachment?.id === nextAttachment?.id &&
      attachment?.messageId === nextAttachment?.messageId &&
      attachment?.mimeType === nextAttachment?.mimeType &&
      attachment?.filePath === nextAttachment?.filePath &&
      attachment?.fileName === nextAttachment?.fileName &&
      attachment?.virBudget === nextAttachment?.virBudget &&
      attachment?.createdAt === nextAttachment?.createdAt
    );
  });
}

/**
 * Formats token throughput values for the assistant metrics footer.
 *
 * @param tokensPerSecond - Throughput value reported by the backend.
 * @returns A human-readable tokens-per-second string.
 */
function formatRate(tokensPerSecond: number): string {
  return `${tokensPerSecond.toFixed(tokensPerSecond >= 100 ? 0 : 1)} tokens/sec`;
}

/**
 * Props for {@link MessageBubble}.
 */
interface MessageBubbleProps {
  /** The message object to display. */
  message: ChatMessage;
  /** The selected visual style for the rendered bubble. */
  bubbleStyle?: "bubble" | "flat" | "compact";
  /** Whether this message is currently being streamed/written by the assistant. */
  isStreaming?: boolean;
  /** Callback triggered when the user saves an edit to their own or assistant's message. */
  onEdit: (id: string, newContent: string) => void;
  /** Callback to branch the chat history from this message. */
  onBranch: (id: string) => void;
  /** Callback to regenerate the assistant response for this turn. */
  onRegenerate: (id: string) => void;
  /** Callback to continue a truncated assistant response. */
  onContinue: (id: string) => void;
  /** Callback to delete this message and subsequent. */
  onDelete: (id: string) => void;
}

/**
 * Renders a chat message with role-specific styling.
 * Supports Markdown (GFM, Math), image/audio attachments, thinking blocks, and interactive tool calls.
 *
 * @param props - Component props.
 * @returns React functional component.
 */
export const MessageBubble = React.memo(
  /**
   * Renders a single chat message bubble, its attachments, and any tool-call affordances.
   *
   * @param props - Message bubble props controlling content, style, and message actions.
   * @returns The rendered message bubble element.
   */
  function MessageBubble({
    message,
    bubbleStyle = "bubble",
    isStreaming,
    onEdit,
    onBranch,
    onRegenerate,
    onContinue,
    onDelete,
  }: MessageBubbleProps) {
    const approveToolCall = useAppStore((state) => state.approveToolCall);
    const [isEditing, setIsEditing] = useState(false);
    const [editContent, setEditContent] = useState(message.content);

    const toolCalls = React.useMemo(
      () => parseToolCallsJson(message.toolCallsJson),
      [message.toolCallsJson],
    );

    const textareaRef = useRef<HTMLTextAreaElement>(null);
    const [displayContent, setDisplayContent] = useState(message.content);

    useEffect(() => {
      if (!isStreaming) {
        setDisplayContent(message.content);
        return;
      }
      const timer = window.setTimeout(() => setDisplayContent(message.content), 80);
      return () => window.clearTimeout(timer);
    }, [message.content, isStreaming]);

    const renderedContent =
      displayContent || (message.thinkingContent ? "" : message.rawContent) || "";
    const metrics = message.metrics;
    const wrapperSpacingClass = bubbleStyle === "compact" ? "my-3" : "my-6";
    const bubbleClassName =
      bubbleStyle === "compact"
        ? message.role === "user"
          ? "max-w-[85%] rounded-2xl px-4 py-3 shadow-sm text-sm bg-[var(--color-surface-elevated)] border border-[var(--color-border)] text-[var(--color-text-primary)]"
          : "max-w-[85%] rounded-2xl px-3 py-2 text-sm bg-[var(--color-surface)]/50 border border-[var(--color-border)] text-[var(--color-text-primary)]"
        : bubbleStyle === "flat"
          ? message.role === "user"
            ? "max-w-[85%] rounded-lg px-4 py-3 shadow-sm text-base bg-[var(--color-surface-elevated)] border border-[var(--color-border)] text-[var(--color-text-primary)]"
            : "max-w-[85%] rounded-lg px-4 py-3 text-base border border-[var(--color-border)] bg-[var(--color-surface)]/40 text-[var(--color-text-primary)]"
          : message.role === "user"
            ? "max-w-[85%] rounded-3xl p-5 shadow-sm text-base bg-[var(--color-surface-elevated)] border border-[var(--color-border)] text-[var(--color-text-primary)] rounded-tr-sm"
            : "max-w-[85%] rounded-3xl p-5 shadow-sm text-base bg-transparent text-[var(--color-text-primary)] rounded-tl-sm";

    useEffect(() => {
      if (isEditing && textareaRef.current) {
        textareaRef.current.focus();
        // Put cursor at end
        textareaRef.current.setSelectionRange(
          textareaRef.current.value.length,
          textareaRef.current.value.length,
        );
      }
    }, [isEditing]);

    /**
     * Copies the visible message content to the clipboard.
     *
     * @returns No return value.
     */
    const handleCopy = async () => {
      const copied = await copyTextToClipboard(message.content);
      if (!copied) {
        useAppStore
          .getState()
          .addNotification("Copy failed. Clipboard access is unavailable.", "error");
      }
    };

    /**
     * Persists an edited message when the edited content changed.
     *
     * @returns No return value.
     */
    const saveEdit = () => {
      if (editContent.trim() !== message.content) {
        onEdit(message.id, editContent);
      }
      setIsEditing(false);
    };

    return (
      <div
        className={`group relative flex flex-col ${message.role === "user" ? "items-end" : "items-start"} ${wrapperSpacingClass}`}>
        <div
          className={`text-xs uppercase tracking-widest font-bold text-[var(--color-text-muted)] mb-1 ${message.role === "user" ? "mr-1" : "ml-1"}`}>
          {message.role}
        </div>

        {message.attachments && message.attachments.length > 0 && (
          <div
            className={`flex flex-wrap gap-2 max-w-[85%] ${message.role === "user" ? "ml-auto justify-end" : "justify-start"} mb-2`}>
            {message.attachments.map((att) => {
              if (att.mimeType.startsWith("image/")) {
                return (
                  <img
                    key={att.id}
                    src={`/api/attachments/${att.filePath}`}
                    alt={att.fileName}
                    className="max-h-32 rounded-xl border border-[var(--color-border)] object-contain bg-black/20"
                    referrerPolicy="no-referrer"
                  />
                );
              }
              if (att.mimeType.startsWith("audio/")) {
                return (
                  <audio
                    key={att.id}
                    src={`/api/attachments/${att.filePath}`}
                    controls
                    className="h-10 border border-[var(--color-border)] rounded-full">
                    <track kind="captions" />
                  </audio>
                );
              }
              if (att.mimeType.startsWith("video/")) {
                return (
                  <video
                    key={att.id}
                    src={`/api/attachments/${att.filePath}`}
                    controls
                    className="max-h-32 rounded-xl border border-[var(--color-border)] object-contain bg-black/20">
                    <track kind="captions" src="" label="No captions available" />
                  </video>
                );
              }
              return (
                <div
                  key={att.id}
                  className="px-3 py-2 border border-[var(--color-border)] bg-[var(--color-surface-elevated)] fill-[var(--color-text-muted)] text-[var(--color-text-muted)] rounded-lg shadow-sm text-xs flex items-center gap-2">
                  <FileText size={14} /> {att.fileName}
                </div>
              );
            })}
          </div>
        )}

        {isEditing ? (
          <div className="w-full max-w-[85%] border border-[var(--color-accent)] rounded-2xl bg-[var(--color-surface-elevated)] p-2">
            <textarea
              ref={textareaRef}
              value={editContent}
              onChange={(e) => setEditContent(e.target.value)}
              className="w-full bg-transparent resize-none border-none outline-none text-[var(--color-text-primary)] min-h-[100px] font-sans"
              onKeyDown={(e) => {
                if (e.key === "Escape") {
                  setIsEditing(false);
                  setEditContent(message.content);
                } else if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
                  saveEdit();
                }
              }}
            />
            <div className="flex justify-end gap-2 mt-2">
              <button
                type="button"
                onClick={() => {
                  setIsEditing(false);
                  setEditContent(message.content);
                }}
                className="px-3 py-1.5 text-xs font-semibold rounded hover:bg-[var(--color-surface)] text-[var(--color-text-muted)] flex items-center">
                <X size={14} className="mr-1" /> Cancel
              </button>
              <button
                type="button"
                onClick={saveEdit}
                className="px-3 py-1.5 text-xs font-semibold rounded bg-[var(--color-accent)] text-white flex items-center hover:opacity-90">
                <Check size={14} className="mr-1" /> Save
              </button>
            </div>
          </div>
        ) : (
          <>
            {message.role === "assistant" && message.thinkingContent && (
              <ThinkingBlock content={message.thinkingContent} isLive={!!isStreaming} />
            )}
            <div
              data-bubble-style={bubbleStyle}
              data-testid="message-bubble-shell"
              className={bubbleClassName}>
              <div className="prose prose-invert max-w-none prose-p:leading-relaxed prose-pre:bg-[#11111b] prose-pre:border prose-pre:border-[var(--color-border)] prose-pre:rounded-xl">
                <ReactMarkdown remarkPlugins={REMARK_PLUGINS} rehypePlugins={REHYPE_PLUGINS}>
                  {renderedContent + (isStreaming ? " \u2588" : "")}
                </ReactMarkdown>
              </div>
            </div>
            {message.role === "assistant" && metrics && (
              <div className="mt-2 flex max-w-[85%] flex-wrap items-center gap-x-3 gap-y-1 text-[11px] font-medium text-[var(--color-text-muted)]">
                <span>{formatRate(metrics.tokensPerSecond)}</span>
                <span>{metrics.predictedTokens.toLocaleString()} output tokens</span>
                {(metrics.cachedPromptTokens > 0 || metrics.evaluatedPromptTokens > 0) && (
                  <span>
                    Prompt cache reuse: {metrics.cachedPromptTokens.toLocaleString()} /{" "}
                    {metrics.evaluatedPromptTokens.toLocaleString()} tokens
                  </span>
                )}
              </div>
            )}
          </>
        )}

        {toolCalls &&
          Array.isArray(toolCalls) &&
          toolCalls.map((tc) => {
            return (
              <ToolCard
                key={tc.id}
                messageId={message.id}
                toolCall={tc}
                onApprove={(id, args) => approveToolCall(message.id, id, true, args)}
                onReject={(id) => approveToolCall(message.id, id, false)}
              />
            );
          })}

        {!isEditing && (
          <div
            className={`mt-2 flex max-w-[85%] ${message.role === "user" ? "ml-auto justify-end" : "justify-start"}`}>
            <MessageActions
              role={message.role}
              onCopy={handleCopy}
              onEdit={() => {
                if (toolCalls && toolCalls.length > 0) {
                  if (
                    !window.confirm(
                      "WARNING: This message contains resolved tool calls. Editing it will invalidate downstream tool bindings. Continue?",
                    )
                  ) {
                    return;
                  }
                }
                setIsEditing(true);
              }}
              onBranch={() => onBranch(message.id)}
              onRegenerate={
                message.role === "assistant" ? () => onRegenerate(message.id) : undefined
              }
              onContinue={message.role === "assistant" ? () => onContinue(message.id) : undefined}
              onDelete={() => onDelete(message.id)}
            />
          </div>
        )}
      </div>
    );
  },
  (prev, next) => {
    return (
      prev.message.content === next.message.content &&
      prev.message.rawContent === next.message.rawContent &&
      prev.message.thinkingContent === next.message.thinkingContent &&
      hasSameAttachments(prev.message.attachments, next.message.attachments) &&
      hasSameMetrics(prev.message.metrics, next.message.metrics) &&
      prev.message.toolCallsJson === next.message.toolCallsJson &&
      prev.isStreaming === next.isStreaming &&
      prev.message.id === next.message.id &&
      prev.bubbleStyle === next.bubbleStyle
    );
  },
);
