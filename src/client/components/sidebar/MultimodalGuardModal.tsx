/**
 * @packageDocumentation
 * Provides a guard modal for switching models when current chat history contains unsupported multimodal content.
 */

import { AlertTriangle } from "lucide-react";

/**
 * Properties for the MultimodalGuardModal component.
 */
interface MultimodalGuardModalProps {
  /** Callback to close the modal. */
  onClose: () => void;
  /** Callback to start a new chat instead. */
  onNewChat: () => void;
  /** The reason the switch is blocked ("vision", "audio", or "both"). */
  reason: "vision" | "audio" | "both";
  /** A list of messages in the current chat that cause the incompatibility. */
  incompatibleMessages: { id: string; position: number }[];
}

/**
 * A modal warning users that they are attempting to load a model that lacks the multimodal
 * capabilities required by the current active chat session.
 *
 * @param props - The component properties: {@link MultimodalGuardModalProps}.
 * @returns The rendered React element.
 */
export function MultimodalGuardModal({
  onClose,
  onNewChat,
  reason,
  incompatibleMessages,
}: MultimodalGuardModalProps) {
  return (
    <div className="fixed inset-0 z-[110] flex items-center justify-center p-4 bg-black/70 backdrop-blur-md animate-in fade-in duration-300">
      <div className="bg-[var(--color-surface)] border-2 border-red-500/50 rounded-2xl w-full max-w-lg shadow-2xl overflow-hidden flex flex-col animate-in zoom-in-95 duration-300">
        <div className="p-6 bg-red-500/10 border-b border-red-500/20 flex items-center gap-4">
          <div className="p-3 bg-red-500 text-white rounded-xl shadow-lg shadow-red-500/20">
            <AlertTriangle size={28} />
          </div>
          <div>
            <h2 className="text-xl font-bold text-white">Incompatible Model Switch</h2>
            <p className="text-sm text-red-200/70">Multimodal history detected</p>
          </div>
        </div>

        <div className="p-8 space-y-6 text-[var(--color-text-primary)]">
          <p className="text-sm leading-relaxed">
            The target model does not support {reason === "both" ? "vision or audio" : reason}{" "}
            encoders. However, this conversation contains{" "}
            {reason === "both" ? "image and audio" : reason} attachments that are incompatible with
            the new model.
          </p>

          <div className="space-y-3">
            <h3 className="text-[10px] font-bold text-[var(--color-text-muted)] uppercase tracking-widest">
              Incompatible Messages
            </h3>
            <div className="bg-[var(--color-bg)] rounded-xl border border-[var(--color-border)] p-4 max-h-32 overflow-y-auto">
              {incompatibleMessages.length > 0 ? (
                <ul className="space-y-2">
                  {incompatibleMessages.map((m, index) => (
                    <li key={m.id} className="text-xs flex items-center gap-2">
                      <span className="w-1.5 h-1.5 rounded-full bg-red-500" />
                      Incompatible media found in message{" "}
                      {m.position !== undefined ? `at position ${m.position + 1}` : `${index + 1}`}
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="text-xs text-[var(--color-text-muted)]">
                  Multiple messages contain incompatible media.
                </p>
              )}
            </div>
          </div>

          <p className="text-xs text-[var(--color-text-muted)] italic">
            To proceed, you must either select a model with{" "}
            {reason === "both" ? "vision and audio" : reason} support, or start a new chat.
          </p>
        </div>

        <div className="p-4 bg-[var(--color-surface-elevated)] border-t border-[var(--color-border)] flex gap-4">
          <button
            type="button"
            onClick={onClose}
            className="flex-1 px-4 py-3 border border-[var(--color-border)] rounded-xl hover:bg-[var(--color-bg)] transition-all font-bold text-sm">
            Cancel Switch
          </button>
          <button
            type="button"
            onClick={onNewChat}
            className="flex-1 px-4 py-3 bg-[var(--color-accent)] text-white rounded-xl hover:shadow-xl transition-all font-bold text-sm shadow-indigo-500/20">
            Start New Chat
          </button>
        </div>
      </div>
    </div>
  );
}
