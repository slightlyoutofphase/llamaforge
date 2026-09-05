/**
 * @packageDocumentation
 * Display-time helpers for assistant thinking traces.
 *
 * Thinking text is often a mix of markdown headings and extra blank lines.
 * Those newlines must not be re-interpreted as visible CSS gaps on top of
 * markdown block spacing.
 */

/**
 * CSS class applied to the expanded thinking-trace body. Paired with rules in
 * `src/client/index.css` that keep heading/paragraph gaps compact.
 */
export const THINKING_TRACE_BODY_CLASS = "thinking-trace";

/**
 * Normalizes thinking-trace text for display.
 *
 * Converts Windows newlines and collapses runs of 3+ newlines into a single
 * paragraph break so models that emit sparse blank lines do not produce huge
 * vertical gaps once markdown is rendered.
 *
 * @param content - Raw thinking-trace text captured from the model.
 * @returns Trimmed text with at most one blank line between blocks.
 */
export function normalizeThinkingTrace(content: string): string {
  return content
    .replace(/\r\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/**
 * Whether the thinking block should show the live timer and spinner.
 *
 * Thinking is live only while thoughts are still arriving. The first visible
 * answer character means the model has left the think block, even if tokens
 * are still streaming into the final message.
 *
 * @param isStreaming - Whether this assistant row is the in-flight generation.
 * @param thinkingContent - Thinking trace captured so far, if any.
 * @param visibleContent - Visible assistant reply text captured so far.
 * @returns `true` when the thought bubble should keep counting.
 */
export function isThinkingTraceLive(
  isStreaming: boolean,
  thinkingContent: string | undefined,
  visibleContent: string,
): boolean {
  return Boolean(isStreaming && thinkingContent && visibleContent.length === 0);
}
