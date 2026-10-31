/**
 * @packageDocumentation
 * Provides the main chat input bar, handling file uploads and text entry.
 */

import { Loader2, Paperclip, Plus, Send, X } from "lucide-react";
import type React from "react";
import { useCallback, useEffect, useRef, useState } from "react";
import { useDropzone } from "react-dropzone";
import { useAppStore } from "../../store";

interface PendingAttachment {
  id: string;
  file: File;
  previewUrl: string | null;
}

const MAX_COMPOSER_FILES = 5;
const MAX_COMPOSER_FILE_BYTES = 10 * 1024 * 1024;

/**
 * Creates a local preview URL for attachments that can be rendered inline.
 *
 * @param file - Attachment selected by the user.
 * @returns An object URL for image attachments, or `null` when no preview should be shown.
 */
function createPreviewUrl(file: File): string | null {
  return file.type.startsWith("image/") || file.type.startsWith("video/")
    ? URL.createObjectURL(file)
    : null;
}

/**
 * Describes files the composer refused so the user can tell why nothing was attached.
 *
 * @param rejected - Dropzone rejection entries.
 * @returns A short error message.
 */
function describeRejectedFiles(
  rejected: readonly { file: File; errors: readonly { code: string }[] }[],
): string {
  const tooMany = rejected.some((entry) =>
    entry.errors.some((error) => error.code === "too-many-files"),
  );
  if (tooMany) {
    return `Only ${MAX_COMPOSER_FILES} attachments can be added.`;
  }
  const names = rejected.map((entry) => entry.file.name).filter(Boolean);
  const listed = names.length > 0 ? names.join(", ") : "That file";
  return `${listed} is not a supported attachment. Use an image, audio, video, PDF, or text file.`;
}

/**
 * Releases a previously allocated attachment preview URL.
 *
 * @param previewUrl - Object URL created for an attachment preview.
 * @returns No return value.
 */
function revokePreviewUrl(previewUrl: string | null) {
  if (previewUrl) {
    URL.revokeObjectURL(previewUrl);
  }
}

/**
 * Clones a file so the pending attachment list can be safely reused after submission.
 *
 * @param file - File selected from the browser file picker or drag-and-drop area.
 * @returns A new `File` instance containing the original file contents and metadata.
 */
async function cloneFile(file: File): Promise<File> {
  const buffer = await file.arrayBuffer();
  return new File([buffer], file.name, {
    type: file.type,
    lastModified: file.lastModified,
  });
}

/**
 * Properties for the InputBar component.
 */
interface InputBarProps {
  /** Callback fired when the user submits a message and attachments. */
  onSend: (content: string, files: File[]) => void | Promise<void>;
  /** Whether the model is currently generating a response. */
  isGenerating: boolean;
  /** True while the send POST is in flight and Stop should not be offered. */
  isSending?: boolean;
  /** Whether a chat session is currently active and accepts messages. */
  isActive: boolean;
  /** Callback to stop generation. */
  onStop: () => void;
  /**
   * True while the transcript is being reconciled with the server.
   * Blocks sending so a new message cannot land on a different history than the UI.
   */
  historyLocked?: boolean;
  /**
   * Identity of the conversation this composer belongs to.
   * Changing it discards unsent text and attachments so drafts cannot leak across chats.
   */
  conversationId?: string;
}

/**
 * The input bar for composing messages and uploading multimodal attachments.
 *
 * @param props - The component properties: {@link InputBarProps}.
 * @returns The rendered React element.
 */
export function InputBar({
  onSend,
  isGenerating,
  isSending = false,
  isActive,
  onStop,
  conversationId,
  historyLocked = false,
}: InputBarProps) {
  const [files, setFiles] = useState<PendingAttachment[]>([]);
  const [inputContent, setInputContent] = useState("");
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const filesRef = useRef<PendingAttachment[]>([]);

  useEffect(() => {
    filesRef.current = files;
  }, [files]);

  useEffect(() => {
    return () => {
      for (const file of filesRef.current) {
        revokePreviewUrl(file.previewUrl);
      }
    };
  }, []);

  useEffect(() => {
    if (conversationId === undefined) return;
    setInputContent("");
    setFiles((prev) => {
      for (const file of prev) {
        revokePreviewUrl(file.previewUrl);
      }
      return [];
    });
  }, [conversationId]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: we want to trigger this when inputContent changes
  useEffect(() => {
    if (textareaRef.current) {
      textareaRef.current.style.height = "auto";
      textareaRef.current.style.height = `${Math.min(textareaRef.current.scrollHeight, 200)}px`;
    }
  }, [inputContent]);

  const composerLocked = !isActive || historyLocked;
  const wasGeneratingRef = useRef(isGenerating);

  useEffect(() => {
    if (wasGeneratingRef.current && !isGenerating && isActive && !historyLocked) {
      textareaRef.current?.focus();
    }
    wasGeneratingRef.current = isGenerating;
  }, [historyLocked, isActive, isGenerating]);

  const onDrop = useCallback((acceptedFiles: File[]) => {
    const oversized = acceptedFiles.filter((file) => file.size > MAX_COMPOSER_FILE_BYTES);
    if (oversized.length > 0) {
      useAppStore.getState().setError("Attachments must be 10MB or smaller.");
    }
    setFiles((prev) => {
      const remainingSlots = Math.max(0, MAX_COMPOSER_FILES - prev.length);
      const withinSize = acceptedFiles.filter((file) => file.size <= MAX_COMPOSER_FILE_BYTES);
      if (withinSize.length > remainingSlots) {
        useAppStore.getState().setError(`Only ${MAX_COMPOSER_FILES} attachments can be added.`);
      }
      const accepted = withinSize.slice(0, remainingSlots).map((file) => ({
        id: crypto.randomUUID(),
        file,
        previewUrl: createPreviewUrl(file),
      }));
      return [...prev, ...accepted];
    });
  }, []);

  const onDropRejected = useCallback(
    (rejections: readonly { file: File; errors: readonly { code: string }[] }[]) => {
      useAppStore.getState().setError(describeRejectedFiles(rejections));
    },
    [],
  );

  const { getRootProps, getInputProps, isDragActive, open } = useDropzone({
    onDrop,
    onDropRejected,
    noClick: true,
    noKeyboard: true,
    disabled: composerLocked || isGenerating || isSending,
    maxFiles: MAX_COMPOSER_FILES,
    accept: {
      "image/*": [],
      "audio/*": [],
      "video/*": [],
      "application/pdf": [],
      "text/*": [],
    },
  });

  /**
   * Sends the current text and pending attachments to the parent chat view.
   *
   * @returns A promise that resolves once the send workflow completes.
   */
  const handleSend = async () => {
    if (!isActive || historyLocked || isGenerating || isSending) return;
    if (!inputContent.trim() && files.length === 0) return;

    const sentText = inputContent;
    const pendingFiles = [...files];
    const sentIds = new Set(pendingFiles.map((item) => item.id));
    const filesToSend = await Promise.all(pendingFiles.map(({ file }) => cloneFile(file)));

    try {
      await Promise.resolve(onSend(sentText, filesToSend));
    } catch {
      return;
    }

    setInputContent((current) => (current === sentText ? "" : current));
    setFiles((currentFiles) => {
      const kept: PendingAttachment[] = [];
      for (const item of currentFiles) {
        if (sentIds.has(item.id)) {
          revokePreviewUrl(item.previewUrl);
          continue;
        }
        kept.push(item);
      }
      return kept;
    });
  };

  /**
   * Submits the current message when the user presses Enter without Shift.
   *
   * @param e - Textarea keyboard event.
   * @returns No return value.
   */
  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.nativeEvent.isComposing || e.key === "Process") return;
    if (e.key === "Enter" && !e.shiftKey) {
      if (isGenerating || isSending) return;
      e.preventDefault();
      void handleSend();
    }
  };

  return (
    <div
      {...getRootProps()}
      className={`flex flex-col border rounded-2xl bg-[var(--color-surface)] shadow-sm transition-colors ${
        isDragActive
          ? "border-[var(--color-accent)] bg-[var(--color-surface-elevated)]"
          : "border-[var(--color-border)]"
      }`}>
      <input {...getInputProps()} />

      {isDragActive && (
        <div className="absolute inset-0 z-10 flex items-center justify-center bg-[var(--color-bg)]/80 rounded-2xl backdrop-blur-sm border-2 border-dashed border-[var(--color-accent)]">
          <p className="font-medium text-[var(--color-accent)]">Drop files to attach...</p>
        </div>
      )}

      {files.length > 0 && (
        <div className="flex flex-wrap gap-2 p-3 pb-0 max-h-32 overflow-y-auto">
          {files.map(({ id, file, previewUrl }) => (
            <div
              key={id}
              className="flex items-center gap-2 bg-[var(--color-bg)] border border-[var(--color-border)] px-2 py-1.5 rounded-lg text-sm group">
              {previewUrl && file.type.startsWith("video/") ? (
                <video
                  src={previewUrl}
                  aria-label={file.name}
                  muted
                  className="h-8 w-8 rounded object-cover"
                />
              ) : previewUrl ? (
                <img src={previewUrl} alt={file.name} className="h-8 w-8 rounded object-cover" />
              ) : (
                <Paperclip size={14} />
              )}
              <span className="truncate max-w-[150px] font-medium">{file.name}</span>
              <button
                type="button"
                onClick={() => {
                  setFiles((currentFiles) => {
                    const nextFiles: PendingAttachment[] = [];
                    for (const item of currentFiles) {
                      if (item.id === id) {
                        revokePreviewUrl(item.previewUrl);
                        continue;
                      }
                      nextFiles.push(item);
                    }
                    return nextFiles;
                  });
                }}
                className="text-[var(--color-text-muted)] hover:bg-[var(--color-surface-elevated)] p-0.5 rounded opacity-0 group-hover:opacity-100 transition-opacity">
                <X size={14} />
              </button>
            </div>
          ))}
        </div>
      )}
      <div className="flex items-end p-2 relative z-0">
        <button
          type="button"
          onClick={open}
          disabled={composerLocked || isGenerating || isSending}
          className="p-2 text-[var(--color-text-muted)] hover:text-[var(--color-text-primary)] hover:bg-[var(--color-surface-elevated)] rounded-xl transition-all mr-2 shrink-0 mb-1 disabled:opacity-50 disabled:cursor-not-allowed"
          title="Attach files (Images, Audio, Video, PDF, Text)">
          <Plus size={20} />
        </button>

        <label htmlFor="chatInput" className="sr-only">
          Chat input
        </label>
        <textarea
          id="chatInput"
          ref={textareaRef}
          value={inputContent}
          onChange={(e) => setInputContent(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder={
            historyLocked
              ? "Updating chat history..."
              : isActive
                ? "Type your message..."
                : "Allocate a model to begin..."
          }
          disabled={composerLocked}
          className="flex-1 bg-transparent border-none focus:outline-none resize-none py-3 px-1 min-h-[44px] max-h-[200px] text-[var(--color-text-primary)] placeholder-[var(--color-text-muted)] w-full disabled:opacity-50 disabled:cursor-not-allowed"
          rows={1}
        />

        <button
          type="button"
          aria-label={isSending ? "Sending" : isGenerating ? "Stop generation" : "Send message"}
          onClick={isGenerating && !isSending ? onStop : handleSend}
          disabled={!isActive || historyLocked || isSending}
          className={`p-2 ml-2 rounded-xl transition-all shrink-0 mb-1 disabled:opacity-50 disabled:cursor-not-allowed ${
            isSending
              ? "bg-[var(--color-accent)] text-white shadow-md"
              : isGenerating
                ? "bg-[var(--color-error)] text-white shadow-md"
                : inputContent.trim() || files.length > 0
                  ? "bg-[var(--color-accent)] text-white shadow-md"
                  : "text-[var(--color-text-muted)] bg-[var(--color-surface-elevated)]"
          }`}>
          {isSending ? (
            <Loader2 size={20} className="animate-spin" />
          ) : isGenerating ? (
            <div className="w-5 h-5 flex items-center justify-center">
              <div className="w-2 h-2 bg-white rounded-sm animate-pulse" />
            </div>
          ) : (
            <Send
              size={20}
              className={!inputContent.trim() && files.length === 0 ? "opacity-50" : ""}
            />
          )}
        </button>
      </div>
    </div>
  );
}
