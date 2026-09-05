/**
 * @packageDocumentation
 * Tests for thinking-trace display normalization.
 */

import { describe, expect, it } from "bun:test";
import {
  isThinkingTraceLive,
  normalizeThinkingTrace,
  THINKING_TRACE_BODY_CLASS,
} from "../../src/shared/thinkingDisplay";

describe("thinking display helpers", () => {
  it("exports a stable CSS class for compact thinking-trace typography", () => {
    expect(THINKING_TRACE_BODY_CLASS).toBe("thinking-trace");
  });

  it("trims and collapses runaway blank lines to a single paragraph break", () => {
    const raw = '\r\nThinking Process:\n\n\n\n\nAnalyze the Input:\n\n\nInput: "hello."\n';
    expect(normalizeThinkingTrace(raw)).toBe(
      'Thinking Process:\n\nAnalyze the Input:\n\nInput: "hello."',
    );
  });

  it("leaves a single intentional blank line intact", () => {
    expect(normalizeThinkingTrace("alpha\n\nbeta")).toBe("alpha\n\nbeta");
  });

  it("returns an empty string for whitespace-only traces", () => {
    expect(normalizeThinkingTrace("  \n\n  ")).toBe("");
  });

  it("keeps the thought timer live only while thinking and the answer is still empty", () => {
    expect(isThinkingTraceLive(true, "plan", "")).toBe(true);
    expect(isThinkingTraceLive(true, "plan", "answer")).toBe(false);
    expect(isThinkingTraceLive(true, undefined, "")).toBe(false);
    expect(isThinkingTraceLive(false, "plan", "")).toBe(false);
  });
});
