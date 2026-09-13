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

  it("returns undefined for unknown chat session", () => {
    expect(getPromptCacheStats("unknown")).toBeUndefined();
  });
});
