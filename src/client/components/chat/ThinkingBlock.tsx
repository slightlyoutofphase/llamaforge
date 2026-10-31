/**
 * @packageDocumentation
 * Provides the ThinkingBlock component for rendering language model "thinking" or reasoning steps.
 */

import { ChevronDown, ChevronRight, Loader2 } from "lucide-react";
import { memo, useEffect, useState } from "react";
import ReactMarkdown from "react-markdown";
import rehypeKatex from "rehype-katex";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import { thinkingHeaderLabel } from "../../../shared/generationMetrics";
import { normalizeThinkingTrace, THINKING_TRACE_BODY_CLASS } from "../../../shared/thinkingDisplay";

/**
 * Properties for the ThinkingBlock component.
 */
interface ThinkingBlockProps {
  /** The text content of the thinking block. */
  content: string;
  /** Whether the block is currently generating live. */
  isLive?: boolean;
  /** Wall-clock thinking duration in milliseconds, once known. */
  durationMs?: number | undefined;
}

/**
 * Renders a thinking trace without subscribing to the elapsed-time ticker.
 *
 * @param props - Markdown source for the trace.
 * @returns The memoized markdown body.
 */
const ThinkingTraceBody = memo(function ThinkingTraceBody({ content }: { content: string }) {
  return (
    <div data-testid="thinking-trace" className={THINKING_TRACE_BODY_CLASS}>
      <ReactMarkdown remarkPlugins={[remarkGfm, remarkMath]} rehypePlugins={[rehypeKatex]}>
        {normalizeThinkingTrace(content)}
      </ReactMarkdown>
    </div>
  );
});

/**
 * Updates the live thinking label on a short interval.
 *
 * The ticker is its own component so each tick does not re-parse the trace.
 *
 * @param props - Whether the trace is live and the duration to show after it ends.
 * @returns The header label text.
 */
function ThinkingElapsedLabel({
  isLive,
  durationMs,
}: {
  isLive: boolean;
  durationMs: number | undefined;
}) {
  const [liveElapsedMs, setLiveElapsedMs] = useState(0);

  useEffect(() => {
    if (!isLive) {
      setLiveElapsedMs(0);
      return;
    }
    const startedAt = Date.now();
    setLiveElapsedMs(0);
    const timer = window.setInterval(() => {
      setLiveElapsedMs(Date.now() - startedAt);
    }, 100);
    return () => window.clearInterval(timer);
  }, [isLive]);

  return <>{thinkingHeaderLabel(isLive, liveElapsedMs, durationMs)}</>;
}

/**
 * A collapsible block for displaying large "thinking" reasoning outputs from models.
 *
 * @param props - The component properties: {@link ThinkingBlockProps}.
 * @returns The rendered React element.
 */
export function ThinkingBlock({ content, isLive, durationMs }: ThinkingBlockProps) {
  const [isExpanded, setIsExpanded] = useState(false);

  useEffect(() => {
    setIsExpanded(Boolean(isLive));
  }, [isLive]);

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
        <span className="font-mono text-xs font-semibold tracking-wide flex items-center gap-2">
          <ThinkingElapsedLabel isLive={!!isLive} durationMs={durationMs} />
          {isLive && <Loader2 size={10} className="animate-spin text-[var(--color-accent)]" />}
        </span>
      </button>

      {isExpanded && (
        <div className="p-3 pt-1 border-t border-[var(--color-border)] text-[var(--color-text-secondary)] font-mono opacity-80 overflow-auto max-h-[400px]">
          <ThinkingTraceBody content={content} />
        </div>
      )}
    </div>
  );
}
