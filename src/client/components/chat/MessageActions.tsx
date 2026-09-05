/**
 * @packageDocumentation
 * Provides the MessageActions component for rendering interactive buttons below chat messages.
 */

import { ArrowRight, Copy, Edit2, GitBranch, RefreshCw, Trash2 } from "lucide-react";
import type React from "react";

/**
 * Properties for the MessageActions component.
 */
interface MessageActionsProps {
  /** The origin role of the message: "user", "assistant", "system", or "tool". */
  role: "user" | "assistant" | "system" | "tool";
  /** Triggered when the user clicks the edit button. */
  onEdit?: () => void;
  /** Triggered when the user clicks the branch button. */
  onBranch?: () => void;
  /** Triggered when the user clicks the regenerate / generate-response button. */
  onRegenerate?: (() => void) | undefined;
  /** Triggered when the user clicks the continue generation button. */
  onContinue?: (() => void) | undefined;
  /** Triggered when the user clicks the copy contents button. */
  onCopy?: (() => void) | undefined;
  /** Triggered when the user clicks the delete button. */
  onDelete?: () => void;
  /**
   * When true, mutating actions (edit, branch, regenerate, continue, delete) are disabled.
   * Copy remains available.
   */
  locked?: boolean;
}

/**
 * Action toolbar (Copy, Edit, Branch, Generate, Delete, etc.) rendered below user/assistant messages.
 *
 * @param props - The component properties: {@link MessageActionsProps}.
 * @returns The rendered React element, or null for system/tool roles.
 */
export function MessageActions({
  role,
  onEdit,
  onBranch,
  onRegenerate,
  onContinue,
  onCopy,
  onDelete,
  locked = false,
}: MessageActionsProps) {
  if (role === "system" || role === "tool") return null;

  return (
    <div
      data-testid="message-actions"
      className="flex items-center gap-1 opacity-75 transition-opacity hover:opacity-100 bg-[var(--color-bg)]/80 backdrop-blur border border-[var(--color-border)] rounded-lg p-0.5 shadow-sm">
      <ActionBtn icon={<Copy size={14} />} onClick={onCopy} title="Copy Content" />
      {onEdit && (
        <ActionBtn icon={<Edit2 size={14} />} onClick={onEdit} title="Edit" disabled={locked} />
      )}
      {onBranch && (
        <ActionBtn
          icon={<GitBranch size={14} />}
          onClick={onBranch}
          title="Branch from here"
          disabled={locked}
        />
      )}

      {onRegenerate && (
        <ActionBtn
          icon={<RefreshCw size={14} />}
          onClick={onRegenerate}
          title={role === "user" ? "Generate response" : "Regenerate"}
          disabled={locked}
        />
      )}
      {role === "assistant" && onContinue && (
        <ActionBtn
          icon={<ArrowRight size={14} />}
          onClick={onContinue}
          title="Continue generation"
          disabled={locked}
        />
      )}

      <ActionBtn
        icon={<Trash2 size={14} className="text-red-400" />}
        onClick={onDelete}
        title="Delete this and subsequent"
        disabled={locked}
      />
    </div>
  );
}

/**
 * Renders a single icon button within the message action toolbar.
 *
 * @param props - Button configuration including the icon, click handler, and tooltip label.
 * @returns The rendered action button, or `null` when no click handler is available.
 */
function ActionBtn({
  icon,
  onClick,
  title,
  disabled = false,
}: {
  icon: React.ReactNode;
  onClick?: (() => void) | undefined;
  title: string;
  disabled?: boolean;
}) {
  if (!onClick) return null;
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className="p-1.5 text-[var(--color-text-muted)] hover:text-[var(--color-text-primary)] hover:bg-[var(--color-surface)] rounded transition-colors disabled:opacity-40 disabled:pointer-events-none"
      title={title}>
      {icon}
    </button>
  );
}
