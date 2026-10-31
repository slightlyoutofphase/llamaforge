/**
 * @packageDocumentation
 * Tests for prompt cache statistics collection and retrieval.
 */

import { describe, expect, it } from "bun:test";
import { getPromptCacheStats, updatePromptCacheStats } from "../../src/server/promptCache";

describe("promptCache", () => {
  it("accumulates stats for a chat session", () => {
    const chatId = "chat-123";

    updatePromptCacheStats(chatId, {
      predicted_ms: 200,
      predicted_n: 20,
      predicted_per_second: 100,
      predicted_per_token_ms: 10,
      prompt_ms: 100,
      prompt_n: 10,
      prompt_per_second: 100,
      prompt_per_token_ms: 10,
      tokens_cached: 5,
      tokens_evaluated: 10,
    });

    let stats = getPromptCacheStats(chatId);
    expect(stats).toEqual({ totalEvaluated: 10, totalCached: 5 });

    updatePromptCacheStats(chatId, {
      predicted_ms: 300,
      predicted_n: 30,
      predicted_per_second: 100,
      predicted_per_token_ms: 10,
      prompt_ms: 150,
      prompt_n: 15,
      prompt_per_second: 100,
      prompt_per_token_ms: 10,
      tokens_cached: 10,
      tokens_evaluated: 15,
    });

    stats = getPromptCacheStats(chatId);
    expect(stats).toEqual({ totalEvaluated: 25, totalCached: 15 });
  });

  it("reads chat-completions cache_n and prompt_n", () => {
    updatePromptCacheStats("chat-cache-n", {
      predicted_ms: 661,
      predicted_n: 35,
      predicted_per_second: 52,
      predicted_per_token_ms: 18,
      prompt_ms: 31,
      prompt_n: 1,
      prompt_per_second: 32,
      prompt_per_token_ms: 31,
      cache_n: 236,
    });

    expect(getPromptCacheStats("chat-cache-n")).toEqual({
      totalEvaluated: 237,
      totalCached: 236,
    });
  });

  it("does not store NaN when cache fields are missing", () => {
    updatePromptCacheStats("chat-missing", {
      predicted_ms: 1,
      predicted_n: 1,
      predicted_per_second: 1,
      predicted_per_token_ms: 1,
      prompt_ms: 1,
      prompt_n: 4,
      prompt_per_second: 1,
      prompt_per_token_ms: 1,
    });

    const stats = getPromptCacheStats("chat-missing");
    expect(stats).toEqual({ totalEvaluated: 4, totalCached: 0 });
    expect(Number.isFinite(stats?.totalEvaluated)).toBe(true);
    expect(Number.isFinite(stats?.totalCached)).toBe(true);
  });

  it("returns undefined for unknown chat session", () => {
    expect(getPromptCacheStats("unknown")).toBeUndefined();
  });
});
