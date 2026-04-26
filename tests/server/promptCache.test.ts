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
      tokens_evaluated: 10,
      tokens_cached: 5,
      tokens_predicted: 20,
      t_eval_ms: 100,
      t_predict_ms: 200,
      t_eval_s: 0.1,
      t_predict_s: 0.2,
      t_eval_per_token_ms: 10,
      t_predict_per_token_ms: 10,
      tokens_per_second: 100,
    });

    let stats = getPromptCacheStats(chatId);
    expect(stats).toEqual({ totalEvaluated: 10, totalCached: 5 });

    updatePromptCacheStats(chatId, {
      tokens_evaluated: 15,
      tokens_cached: 10,
      tokens_predicted: 30,
      t_eval_ms: 150,
      t_predict_ms: 300,
      t_eval_s: 0.15,
      t_predict_s: 0.3,
      t_eval_per_token_ms: 10,
      t_predict_per_token_ms: 10,
      tokens_per_second: 100,
    });

    stats = getPromptCacheStats(chatId);
    expect(stats).toEqual({ totalEvaluated: 25, totalCached: 15 });
  });

  it("returns undefined for unknown chat session", () => {
    expect(getPromptCacheStats("unknown")).toBeUndefined();
  });
});
