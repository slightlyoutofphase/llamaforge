/**
 * @packageDocumentation
 * Types and utilities for prompt cache tracking.
 */
import type { LlamaTimings } from "@shared/types.js";

/**
 * Interface describing cumulative prompt evaluation statistics for a session.
 */
export interface PromptCacheStats {
  /** Total number of tokens evaluated by the model for the session. */
  totalEvaluated: number;
  /** Total number of tokens served from cache during the session. */
  totalCached: number;
}

// M11 fix: use a bounded Map instead of an unbounded Record to prevent slow memory leaks
const MAX_STATS_ENTRIES = 500;
const stats = new Map<string, PromptCacheStats>();

/**
 * Updates the prompt cache statistics for a chat session based on inference timings.
 *
 * @param chatId - The unique ID of the chat session.
 * @param timings - The performance timings returned by the model server.
 */
export function updatePromptCacheStats(chatId: string, timings: LlamaTimings): void {
  const existing = stats.get(chatId) ?? { totalEvaluated: 0, totalCached: 0 };
  existing.totalEvaluated += timings.tokens_evaluated;
  existing.totalCached += timings.tokens_cached;
  // Delete + set to move to end of insertion order (most-recently-used)
  stats.delete(chatId);
  stats.set(chatId, existing);

  // M11 fix: evict oldest 25% when exceeding bounds
  if (stats.size > MAX_STATS_ENTRIES) {
    const evictCount = Math.floor(stats.size * 0.25);
    let removed = 0;
    for (const key of stats.keys()) {
      if (removed >= evictCount) break;
      stats.delete(key);
      removed++;
    }
  }
}

/**
 * Retrieves the accumulated prompt cache statistics for a chat session.
 *
 * @param chatId - The unique ID of the chat session.
 * @returns The gathered {@link PromptCacheStats} or undefined if no stats exist.
 */
export function getPromptCacheStats(chatId: string): PromptCacheStats | undefined {
  return stats.get(chatId);
}

/**
 * Removes prompt cache statistics for a specific chat session.
 * Called when a chat is deleted to avoid tracking stats for non-existent chats.
 *
 * @param chatId - The unique ID of the chat session to evict stats for.
 */
export function evictPromptCacheStats(chatId: string): void {
  stats.delete(chatId);
}
