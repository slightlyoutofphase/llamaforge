/**
 * @packageDocumentation
 * Provides the main chat input bar, handling file uploads and text entry.
 */

import { Image as ImageIcon, Paperclip, Plus, Send, X } from "lucide-react";
import type React from "react";
import { useCallback, useEffect, useRef, useState } from "react";
import { useDropzone } from "react-dropzone";

/**
 * Properties for the InputBar component.
 */
interface InputBarProps {
  /** Callback fired when the user submits a message and attachments. */
  onSend: (content: string, files: File[]) => void;
  /** Whether the model is currently generating a response. */
  isGenerating: boolean;
  /** Whether a chat session is currently active and accepts messages. */
  isActive: boolean;
  /** Callback to stop generation. */
  onStop: () => void;
}

/**
 * The input bar for composing messages and uploading multimodal attachments.
 *
 * @param props - The component properties: {@link InputBarProps}.
 * @returns The rendered React element.
 */
export function InputBar({ onSend, isGenerating, isActive, onStop }: InputBarProps) {
  const [files, setFiles] = useState<{ id: string; file: File }[]>([]);
  const [inputContent, setInputContent] = useState("");
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  // biome-ignore lint/correctness/useExhaustiveDependencies: we want to trigger this when inputContent changes
  useEffect(() => {
    if (textareaRef.current) {
      textareaRef.current.style.height = "auto";
      textareaRef.current.style.height = `${Math.min(textareaRef.current.scrollHeight, 200)}px`;
    }
  }, [inputContent]);

  const onDrop = useCallback((acceptedFiles: File[]) => {
    const newItems = acceptedFiles.map((f) => ({ id: crypto.randomUUID(), file: f }));
    setFiles((prev) => [...prev, ...newItems]);
  }, []);

  const { getRootProps, getInputProps, isDragActive, open } = useDropzone({
    onDrop,
    noClick: true,
    noKeyboard: true,
    disabled: !isActive || isGenerating,
    accept: {
      "image/*": [],
      "audio/*": [],
      "application/pdf": [],
      "text/*": [],
    },
  });

  const handleSend = () => {
    if ((!inputContent.trim() && files.length === 0) || isGenerating) return;

    // We pass budgets as an array corresponding to the files array to ensure NO collisions
    onSend(
      inputContent,
      files.map((f) => f.file),
    );

    setInputContent("");
    setFiles([]);
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleSend();
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
          {files.map(({ id, file }) => (
            <div
              key={id}
              className="flex items-center gap-2 bg-[var(--color-bg)] border border-[var(--color-border)] px-2 py-1.5 rounded-lg text-sm group">
              {file.type.startsWith("image/") ? (
                <ImageIcon size={14} className="text-blue-400" />
              ) : (
                <Paperclip size={14} />
              )}
              <span className="truncate max-w-[150px] font-medium">{file.name}</span>
              <button
                type="button"
                onClick={() => {
                  setFiles((f) => f.filter((item) => item.id !== id));
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
          disabled={!isActive || isGenerating}
          className="p-2 text-[var(--color-text-muted)] hover:text-[var(--color-text-primary)] hover:bg-[var(--color-surface-elevated)] rounded-xl transition-all mr-2 shrink-0 mb-1 disabled:opacity-50 disabled:cursor-not-allowed"
          title="Attach files (Images, Audio, PDF, Text)">
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
          placeholder={isActive ? "Type your message..." : "Allocate a model to begin..."}
          disabled={!isActive || isGenerating}
          className="flex-1 bg-transparent border-none focus:outline-none resize-none py-3 px-1 min-h-[44px] max-h-[200px] text-[var(--color-text-primary)] placeholder-[var(--color-text-muted)] w-full disabled:opacity-50 disabled:cursor-not-allowed"
          rows={1}
        />

        <button
          type="button"
          onClick={isGenerating ? onStop : handleSend}
          disabled={!isActive}
          className={`p-2 ml-2 rounded-xl transition-all shrink-0 mb-1 disabled:opacity-50 disabled:cursor-not-allowed ${
            isGenerating
              ? "bg-[var(--color-error)] text-white shadow-md"
              : inputContent.trim() || files.length > 0
                ? "bg-[var(--color-accent)] text-white shadow-md"
                : "text-[var(--color-text-muted)] bg-[var(--color-surface-elevated)]"
          }`}>
          {isGenerating ? (
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
