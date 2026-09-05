/**
 * @packageDocumentation
 * LM Studio-style pill row showing per-message generation metrics.
 */

import { Clock, Gauge, Hash, Sparkles } from "lucide-react";
import { formatDurationSeconds, formatStopReasonLabel } from "../../../shared/generationMetrics";
import type { MessageMetrics } from "../../../shared/types";

/**
 * Properties for {@link ResponseStatusBar}.
 */
interface ResponseStatusBarProps {
  /** Persisted assistant response metrics. */
  metrics: MessageMetrics;
}

/**
 * Formats token throughput for the speed pill.
 *
 * @param tokensPerSecond - Throughput value.
 * @returns Compact tok/sec label.
 */
function formatTokPerSec(tokensPerSecond: number): string {
  if (!Number.isFinite(tokensPerSecond) || tokensPerSecond < 0) return "0 tok/sec";
  const digits = tokensPerSecond >= 100 ? 0 : 2;
  return `${tokensPerSecond.toFixed(digits)} tok/sec`;
}

/**
 * Pill-shaped badges summarizing an assistant response, matching the LM Studio footer.
 *
 * @param props - Response metrics to display.
 * @returns Status-bar element.
 */
export function ResponseStatusBar({ metrics }: ResponseStatusBarProps) {
  const stopLabel = formatStopReasonLabel(metrics.stopReason);
  const elapsedMs = metrics.generationMs ?? metrics.promptMs;
  const draftPercent =
    typeof metrics.draftTokens === "number" &&
    metrics.draftTokens > 0 &&
    typeof metrics.draftTokensAccepted === "number"
      ? (Math.min(metrics.draftTokensAccepted, metrics.draftTokens) / metrics.draftTokens) * 100
      : undefined;

  return (
    <div
      data-testid="response-status-bar"
      className="mt-2 flex max-w-[85%] flex-wrap items-center gap-1.5">
      <span
        className="inline-flex items-center gap-1.5 rounded-full bg-[var(--color-surface-elevated)] px-2.5 py-1 text-[11px] text-[var(--color-text-primary)]"
        title="Output token throughput">
        <Gauge size={12} className="shrink-0 text-[var(--color-text-muted)]" />
        {formatTokPerSec(metrics.tokensPerSecond)}
      </span>
      <span
        className="inline-flex items-center gap-1.5 rounded-full bg-[var(--color-surface-elevated)] px-2.5 py-1 text-[11px] text-[var(--color-text-primary)]"
        title="Output tokens generated">
        <Hash size={12} className="shrink-0 text-[var(--color-text-muted)]" />
        {metrics.predictedTokens.toLocaleString()} tokens
      </span>
      {elapsedMs !== undefined && elapsedMs > 0 && (
        <span
          className="inline-flex items-center gap-1.5 rounded-full bg-[var(--color-surface-elevated)] px-2.5 py-1 text-[11px] text-[var(--color-text-primary)]"
          title="Generation duration">
          <Clock size={12} className="shrink-0 text-[var(--color-text-muted)]" />
          {formatDurationSeconds(elapsedMs)}
        </span>
      )}
      {stopLabel && (
        <span
          className="inline-flex items-center rounded-full bg-[var(--color-surface-elevated)] px-2.5 py-1 text-[11px] text-[var(--color-text-primary)]"
          title="Why generation stopped">
          Stop reason: {stopLabel}
        </span>
      )}
      {draftPercent !== undefined && (
        <span
          className="inline-flex items-center gap-1.5 rounded-full bg-[var(--color-surface-elevated)] px-2.5 py-1 text-[11px] text-[var(--color-text-primary)]"
          title="Speculative decoding draft-token acceptance">
          <Sparkles size={12} className="shrink-0 text-[var(--color-text-muted)]" />
          {draftPercent.toFixed(1)}% draft tokens accepted
        </span>
      )}
      {(metrics.cachedPromptTokens > 0 || metrics.evaluatedPromptTokens > 0) && (
        <span
          className="inline-flex items-center rounded-full bg-[var(--color-surface-elevated)] px-2.5 py-1 text-[11px] text-[var(--color-text-muted)]"
          title="Prompt tokens reused from cache versus evaluated">
          Prompt cache: {metrics.cachedPromptTokens.toLocaleString()} /{" "}
          {metrics.evaluatedPromptTokens.toLocaleString()}
        </span>
      )}
    </div>
  );
}
