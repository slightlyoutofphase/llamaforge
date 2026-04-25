/**
 * @packageDocumentation
 * Provides the ThinkingBlock component for rendering language model "thinking" or reasoning steps.
 */

import { ChevronDown, ChevronRight, Loader2 } from "lucide-react";
import { useEffect, useState } from "react";
import ReactMarkdown from "react-markdown";
import rehypeKatex from "rehype-katex";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";

/**
 * Properties for the ThinkingBlock component.
 */
interface ThinkingBlockProps {
  /** The text content of the thinking block. */
  content: string;
  /** Whether the block is currently generating live. */
  isLive?: boolean;
}

/**
 * A collapsible block for displaying large "thinking" reasoning outputs from models.
 *
 * @param props - The component properties: {@link ThinkingBlockProps}.
 * @returns The rendered React element.
 */
export function ThinkingBlock({ content, isLive }: ThinkingBlockProps) {
  const [isExpanded, setIsExpanded] = useState(false);

  useEffect(() => {
    if (isLive) {
      setIsExpanded(true);
    }
  }, [isLive]);

  const tokenEstimate = Math.ceil(content.length / 4);

  return (
    <div className="mb-2 max-w-[85%] border border-[var(--color-border)] rounded-lg bg-[var(--color-surface)]/50 overflow-hidden text-sm animate-in fade-in slide-in-from-left-2 duration-500">
      <button
        type="button"
        onClick={() => setIsExpanded((prev) => !prev)}
        aria-expanded={isExpanded}
        aria-label={isExpanded ? "Collapse thinking trace" : "Expand thinking trace"}
        className="w-full flex items-center px-3 py-2 text-[var(--color-text-muted)] hover:bg-[var(--color-surface-elevated)] transition-colors hover:text-[var(--color-text-primary)]">
        {isExpanded ? (
          <ChevronDown size={14} className="mr-2 shrink-0" />
        ) : (
          <ChevronRight size={14} className="mr-2 shrink-0" />
        )}
        <span className="font-mono text-xs font-semibold uppercase tracking-wider flex items-center gap-2">
          Thinking ({tokenEstimate} tokens)
          {isLive && <Loader2 size={10} className="animate-spin text-[var(--color-accent)]" />}
        </span>
      </button>

      {isExpanded && (
        <div className="p-3 pt-1 border-t border-[var(--color-border)] text-[var(--color-text-secondary)] font-mono opacity-80 overflow-auto max-h-[400px]">
          <div className="whitespace-pre-wrap">
            <ReactMarkdown remarkPlugins={[remarkGfm, remarkMath]} rehypePlugins={[rehypeKatex]}>
              {content.trim()}
            </ReactMarkdown>
          </div>
        </div>
      )}
    </div>
  );
}
