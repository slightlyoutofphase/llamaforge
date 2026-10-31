/**
 * @packageDocumentation
 * Shared helpers for deriving assistant response metrics from llama-server timings.
 */

import type { LlamaTimings, MessageMetrics, WsStopFrame } from "./types";

/**
 * Accepts a finite count that can be stored or added without producing `NaN`.
 *
 * @param value - Candidate token count from a timings payload.
 * @returns The count when it is a finite number greater than or equal to zero.
 */
function finiteNonNegative(value: number | undefined): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) return undefined;
  return value;
}

/**
 * Prompt-cache counters derived from a llama-server timings object.
 */
export interface PromptCacheCounts {
  /** Prompt tokens reused from cache for this request. */
  cachedPromptTokens: number;
  /**
   * Prompt tokens that occupy context after this request.
   * For chat completions this is `cache_n + prompt_n`.
   */
  evaluatedPromptTokens: number;
}

/**
 * Reads prompt-cache counters from llama-server timings.
 *
 * `/v1/chat/completions` reports `cache_n` (reused) and `prompt_n` (processed
 * this request). Their sum is the prompt portion of the context. The legacy
 * `/completion` fields `tokens_cached` and `tokens_evaluated` are used only
 * when `cache_n` is absent, including when those fields are missing entirely
 * so a partial payload cannot accumulate `NaN`.
 *
 * @param timings - Timing object from a completion chunk or stop frame.
 * @returns Finite cached and evaluated prompt-token counts.
 */
export function readPromptCacheCounts(timings: LlamaTimings): PromptCacheCounts {
  const cacheN = finiteNonNegative(timings.cache_n);
  const promptN = finiteNonNegative(timings.prompt_n) ?? 0;
  if (cacheN !== undefined) {
    return {
      cachedPromptTokens: cacheN,
      evaluatedPromptTokens: cacheN + promptN,
    };
  }
  return {
    cachedPromptTokens: finiteNonNegative(timings.tokens_cached) ?? 0,
    evaluatedPromptTokens: finiteNonNegative(timings.tokens_evaluated) ?? promptN,
  };
}

/**
 * Counts tokens occupying the context window at the end of a completion.
 *
 * Chat completions document this as `cache_n + prompt_n + predicted_n`.
 * Legacy payloads that only include `tokens_evaluated` use that prompt total
 * plus `predicted_n`, because `tokens_cached` is already inside
 * `tokens_evaluated` rather than an extra term.
 *
 * @param timings - Timing object from the completion stop chunk.
 * @returns Finite token count, or zero when the payload has no usable counts.
 */
export function contextOccupancyTokens(timings: LlamaTimings): number {
  const predicted = finiteNonNegative(timings.predicted_n) ?? 0;
  if (finiteNonNegative(timings.cache_n) !== undefined) {
    const cacheN = finiteNonNegative(timings.cache_n) ?? 0;
    const promptN = finiteNonNegative(timings.prompt_n) ?? 0;
    return cacheN + promptN + predicted;
  }
  const evaluated = finiteNonNegative(timings.tokens_evaluated);
  if (evaluated !== undefined) return evaluated + predicted;
  const cached = finiteNonNegative(timings.tokens_cached) ?? 0;
  const promptN = finiteNonNegative(timings.prompt_n) ?? 0;
  return cached + promptN + predicted;
}

/**
 * Computes tokens-per-second from a token count and an elapsed millisecond duration.
 *
 * llama-server's `predicted_per_second` / `prompt_per_second` fields are used only
 * when the duration is missing or zero, because those reported rates are sometimes
 * `0`, `Infinity`, or stale relative to `*_n` / `*_ms`.
 *
 * @param tokenCount - Number of tokens in the interval.
 * @param durationMs - Elapsed time in milliseconds.
 * @param reportedRate - Optional rate reported by llama-server.
 * @returns Finite non-negative tokens per second.
 */
export function throughputPerSecond(
  tokenCount: number,
  durationMs: number,
  reportedRate?: number,
): number {
  if (!Number.isFinite(tokenCount) || tokenCount < 0) return 0;
  if (Number.isFinite(durationMs) && durationMs > 0) {
    return (tokenCount / durationMs) * 1000;
  }
  if (typeof reportedRate === "number" && Number.isFinite(reportedRate) && reportedRate > 0) {
    return reportedRate;
  }
  return 0;
}

/**
 * Formats a generation stop reason using LM Studio-style labels.
 *
 * @param stopReason - Internal stop-reason identifier.
 * @returns Human-readable stop-reason text, or `undefined` when unknown.
 */
export function formatStopReasonLabel(
  stopReason: WsStopFrame["stopReason"] | string | undefined,
): string | undefined {
  switch (stopReason) {
    case "eos":
      return "EOS Token Found";
    case "max_tokens":
      return "Max Tokens";
    case "stop_string":
      return "Stop String";
    case "contextLengthReached":
      return "Context Length Reached";
    case "tool_calls":
      return "Tool Calls";
    case "error":
      return "Error";
    case "cancelled":
      return "Cancelled";
    default:
      return undefined;
  }
}

/**
 * Reads optional speculative-decoding counters from a timings payload.
 *
 * llama-server versions expose these under a few neighbouring names; all are
 * treated as optional so missing fields simply hide the draft-acceptance pill.
 *
 * @param timings - Timing object from a completion stop frame.
 * @returns Drafted/accepted counts when both are present and valid.
 */
export function readDraftTokenCounts(timings: LlamaTimings): {
  drafted: number;
  accepted: number;
} | null {
  const drafted = timings.draft_n;
  const accepted = timings.draft_n_accepted ?? timings.n_draft_accepted;
  if (
    typeof drafted !== "number" ||
    !Number.isFinite(drafted) ||
    drafted <= 0 ||
    typeof accepted !== "number" ||
    !Number.isFinite(accepted) ||
    accepted < 0
  ) {
    return null;
  }
  return { drafted, accepted: Math.min(accepted, drafted) };
}

/**
 * Computes the percentage of speculative draft tokens that were accepted.
 *
 * @param timings - Timing object from a completion stop frame.
 * @returns Acceptance percentage in `[0, 100]`, or `undefined` when unavailable.
 */
export function draftAcceptancePercent(timings: LlamaTimings): number | undefined {
  const counts = readDraftTokenCounts(timings);
  if (!counts) return undefined;
  return (counts.accepted / counts.drafted) * 100;
}

/**
 * Builds persisted assistant message metrics from llama-server timings.
 *
 * Throughput is derived from token counts and elapsed milliseconds rather than
 * copied from llama-server's precomputed rate fields, which can be zero or
 * non-finite even when `predicted_n` / `predicted_ms` are valid.
 *
 * @param timings - Timing payload from the completion stop chunk.
 * @param promptTokensCount - Prompt token count used for the request.
 * @param extras - Optional thinking duration and stop reason captured by the proxy.
 * @returns Message-level metrics suitable for persistence and UI display.
 */
export function buildMessageMetrics(
  timings: LlamaTimings,
  promptTokensCount: number,
  extras?: {
    thinkingDurationMs?: number | undefined;
    stopReason?: MessageMetrics["stopReason"] | undefined;
    thinkingSource?: MessageMetrics["thinkingSource"] | undefined;
  },
): MessageMetrics {
  const draft = readDraftTokenCounts(timings);
  const thinkingDurationMs = extras?.thinkingDurationMs;
  const stopReason = extras?.stopReason;
  const thinkingSource = extras?.thinkingSource;
  const generationMs =
    Number.isFinite(timings.predicted_ms) && timings.predicted_ms > 0
      ? timings.predicted_ms
      : undefined;
  const promptMs =
    Number.isFinite(timings.prompt_ms) && timings.prompt_ms > 0 ? timings.prompt_ms : undefined;

  return {
    predictedTokens: timings.predicted_n || 0,
    tokensPerSecond: throughputPerSecond(
      timings.predicted_n || 0,
      timings.predicted_ms || 0,
      timings.predicted_per_second,
    ),
    promptTokens: promptTokensCount,
    promptTokensPerSecond: throughputPerSecond(
      timings.prompt_n || 0,
      timings.prompt_ms || 0,
      timings.prompt_per_second,
    ),
    ...readPromptCacheCounts(timings),
    ...(generationMs !== undefined ? { generationMs } : {}),
    ...(promptMs !== undefined ? { promptMs } : {}),
    ...(typeof thinkingDurationMs === "number" &&
    Number.isFinite(thinkingDurationMs) &&
    thinkingDurationMs >= 0
      ? { thinkingDurationMs }
      : {}),
    ...(stopReason ? { stopReason } : {}),
    ...(thinkingSource ? { thinkingSource } : {}),
    ...(draft ? { draftTokens: draft.drafted, draftTokensAccepted: draft.accepted } : {}),
  };
}

/**
 * Formats a millisecond duration as a compact seconds label for status pills.
 *
 * @param durationMs - Duration in milliseconds.
 * @returns Human-readable seconds string such as `0.13s` or `12.4s`.
 */
export function formatDurationSeconds(durationMs: number): string {
  if (!Number.isFinite(durationMs) || durationMs < 0) return "0.00s";
  const seconds = durationMs / 1000;
  if (seconds < 10) return `${seconds.toFixed(2)}s`;
  if (seconds < 60) return `${seconds.toFixed(1)}s`;
  return `${Math.round(seconds)}s`;
}

/**
 * Formats thinking-phase duration in the LM Studio collapsed-header style.
 *
 * @param durationMs - Thinking duration in milliseconds.
 * @returns Label such as `Thought for 3.2 seconds`.
 */
export function formatThoughtDuration(durationMs: number): string {
  if (!Number.isFinite(durationMs) || durationMs < 0) {
    return "Thought for 0.0 seconds";
  }
  const seconds = durationMs / 1000;
  if (seconds < 0.1) return "Thought for <0.1 seconds";
  return `Thought for ${seconds.toFixed(1)} seconds`;
}

/**
 * Resolves the collapsed/expanded header label for a thinking block.
 *
 * @param isLive - Whether tokens are still streaming.
 * @param liveElapsedMs - Elapsed thinking time measured locally while live.
 * @param durationMs - Persisted thinking duration after completion.
 * @returns Header label text.
 */
export function thinkingHeaderLabel(
  isLive: boolean,
  liveElapsedMs: number,
  durationMs?: number,
): string {
  if (isLive) {
    if (liveElapsedMs >= 100) {
      return `Thinking (${(liveElapsedMs / 1000).toFixed(1)}s)`;
    }
    return "Thinking";
  }
  if (typeof durationMs === "number" && Number.isFinite(durationMs) && durationMs >= 0) {
    return formatThoughtDuration(durationMs);
  }
  return "Thinking trace";
}
