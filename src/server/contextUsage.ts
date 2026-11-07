/**
 * @packageDocumentation
 * Estimates the token occupancy of a chat relative to the loaded context window.
 */

import type { ChatContextUsage, MessageMetrics } from "../shared/types";
import { getServerStatus } from "./llamaServer";
import { getChatForPrompt } from "./persistence/chatRepo";

/** Last completion occupancy, kept after unload so the meter does not rebuild a prompt. */
const lastOccupancyByChat = new Map<string, number>();

/** Last context-usage result that can be reused while the memo key is unchanged. */
let contextUsageCache: { key: string; usage: ChatContextUsage } | null = null;

/**
 * Remembers `cache_n + prompt_n + predicted_n` for a chat.
 *
 * @param chatId - Chat that just finished a completion.
 * @param usedTokens - Occupancy from that completion's timings.
 * @returns No return value.
 */
export function recordChatOccupancy(chatId: string, usedTokens: number): void {
  if (!Number.isFinite(usedTokens) || usedTokens < 0) return;
  lastOccupancyByChat.set(chatId, Math.floor(usedTokens));
  if (contextUsageCache?.key.startsWith(`${chatId}\0`)) contextUsageCache = null;
}

/**
 * Clears the memoized context-usage result. Intended for tests.
 *
 * @returns No return value.
 * @internal
 */
export function __resetContextUsageCache(): void {
  contextUsageCache = null;
  lastOccupancyByChat.clear();
}

/**
 * Reads occupancy from the newest assistant metrics that came from completion timings.
 *
 * `evaluatedPromptTokens` is `cache_n + prompt_n`. `predictedTokens` is `predicted_n`.
 * The pre-send `promptTokens` estimate is not used.
 *
 * @param metrics - Persisted assistant metrics.
 * @returns Occupancy, or `null` when the timings were not stored.
 */
function occupancyFromMetrics(metrics: MessageMetrics | undefined): number | null {
  if (!metrics) return null;
  if (
    !Number.isFinite(metrics.evaluatedPromptTokens) ||
    !Number.isFinite(metrics.predictedTokens)
  ) {
    return null;
  }
  if (metrics.evaluatedPromptTokens <= 0 && metrics.predictedTokens <= 0) return null;
  return metrics.evaluatedPromptTokens + metrics.predictedTokens;
}

/**
 * Returns the last completion occupancy for a chat.
 *
 * This does not rebuild the prompt. While a model is running, `contextSize` is
 * the loaded window. After unload it is empty and the used-token number stays.
 *
 * @param chatId - Chat whose occupancy should be read.
 * @returns Context usage, or `null` when the chat does not exist.
 */
export async function getChatContextUsage(chatId: string): Promise<ChatContextUsage | null> {
  const chat = await getChatForPrompt(chatId);
  if (!chat) return null;

  const server = getServerStatus();
  const contextSize =
    server.status === "running" && server.config?.contextSize ? server.config.contextSize : null;
  const transcript = chat.messages ?? [];
  const cacheKey = [
    chatId,
    String(transcript.length),
    transcript.at(-1)?.id ?? "",
    String(chat.updatedAt),
    String(contextSize),
    String(lastOccupancyByChat.get(chatId) ?? ""),
  ].join("\0");
  if (contextUsageCache?.key === cacheKey) return contextUsageCache.usage;

  let usedTokens = lastOccupancyByChat.get(chatId);
  if (usedTokens === undefined) {
    for (let index = transcript.length - 1; index >= 0; index--) {
      const message = transcript[index];
      if (message?.role !== "assistant") continue;
      const fromMetrics = occupancyFromMetrics(message.metrics);
      if (fromMetrics !== null) {
        usedTokens = fromMetrics;
        break;
      }
    }
  }
  const usage = { usedTokens: usedTokens ?? 0, contextSize };
  contextUsageCache = { key: cacheKey, usage };
  return usage;
}
