/**
 * @packageDocumentation
 * Tests for shared generation metric helpers.
 */

import { describe, expect, it } from "bun:test";
import {
  buildMessageMetrics,
  draftAcceptancePercent,
  formatDurationSeconds,
  formatStopReasonLabel,
  formatThoughtDuration,
  thinkingHeaderLabel,
  throughputPerSecond,
} from "../../src/shared/generationMetrics";
import type { LlamaTimings } from "../../src/shared/types";

const timings = (overrides: Partial<LlamaTimings> = {}): LlamaTimings => ({
  predicted_ms: 100,
  predicted_n: 5,
  predicted_per_second: 0,
  predicted_per_token_ms: 20,
  prompt_ms: 50,
  prompt_n: 10,
  prompt_per_second: 0,
  prompt_per_token_ms: 5,
  tokens_cached: 3,
  tokens_evaluated: 10,
  ...overrides,
});

describe("generationMetrics", () => {
  it("derives tokens/sec from counts and milliseconds instead of a zero reported rate", () => {
    expect(throughputPerSecond(5, 100, 0)).toBe(50);
    expect(throughputPerSecond(10, 50, Number.POSITIVE_INFINITY)).toBe(200);
    expect(throughputPerSecond(0, 0, 12.5)).toBe(12.5);
    expect(throughputPerSecond(-1, 100, 9)).toBe(0);
  });

  it("builds message metrics including stop reason, duration, and draft acceptance", () => {
    const metrics = buildMessageMetrics(
      timings({
        predicted_per_second: 0,
        prompt_per_second: 999,
        draft_n: 80,
        draft_n_accepted: 45,
      }),
      128,
      { thinkingDurationMs: 3200, stopReason: "eos", thinkingSource: "native" },
    );

    expect(metrics.tokensPerSecond).toBe(50);
    expect(metrics.promptTokensPerSecond).toBe(200);
    expect(metrics.generationMs).toBe(100);
    expect(metrics.promptMs).toBe(50);
    expect(metrics.thinkingDurationMs).toBe(3200);
    expect(metrics.stopReason).toBe("eos");
    expect(metrics.thinkingSource).toBe("native");
    expect(metrics.draftTokens).toBe(80);
    expect(metrics.draftTokensAccepted).toBe(45);
    expect(draftAcceptancePercent(timings({ draft_n: 80, draft_n_accepted: 45 }))).toBeCloseTo(
      56.25,
    );
  });

  it("formats LM Studio-style duration and stop-reason labels", () => {
    expect(formatDurationSeconds(130)).toBe("0.13s");
    expect(formatThoughtDuration(3200)).toBe("Thought for 3.2 seconds");
    expect(formatThoughtDuration(40)).toBe("Thought for <0.1 seconds");
    expect(formatStopReasonLabel("eos")).toBe("EOS Token Found");
    expect(formatStopReasonLabel("contextLengthReached")).toBe("Context Length Reached");
  });

  it("builds thinking headers for live and completed traces", () => {
    expect(thinkingHeaderLabel(true, 0)).toBe("Thinking");
    expect(thinkingHeaderLabel(true, 1500)).toBe("Thinking (1.5s)");
    expect(thinkingHeaderLabel(false, 0, 3200)).toBe("Thought for 3.2 seconds");
    expect(thinkingHeaderLabel(false, 0)).toBe("Thinking trace");
  });
});
