/**
 * @packageDocumentation
 * Types and utilities for prompt cache tracking.
 */
import type { LlamaTimings } from "@shared/types.js";

/**
 * Interface describing cumulative prompt evaluation statistics for a session.
 */
export interface PromptCacheStats {
  totalEvaluated: number;
  totalCached: number;
}

const stats: Record<string, PromptCacheStats> = {};

/**
 * Updates the prompt cache statistics for a chat session based on inference timings.
 *
 * @param chatId - The unique ID of the chat session.
 * @param timings - The performance timings returned by the model server.
 */
export function updatePromptCacheStats(chatId: string, timings: LlamaTimings): void {
  if (!stats[chatId]) {
    stats[chatId] = { totalEvaluated: 0, totalCached: 0 };
  }
  stats[chatId].totalEvaluated += timings.tokens_evaluated;
  stats[chatId].totalCached += timings.tokens_cached;
}

/**
 * Retrieves the accumulated prompt cache statistics for a chat session.
 *
 * @param chatId - The unique ID of the chat session.
 * @returns The gathered {@link PromptCacheStats} or undefined if no stats exist.
 */
export function getPromptCacheStats(chatId: string): PromptCacheStats | undefined {
  return stats[chatId];
}
