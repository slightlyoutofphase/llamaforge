/**
 * @packageDocumentation
 * In-process registry of active llama-server generations.
 * Kept separate from streamProxy so autoname can inspect the slot without a cycle.
 */

export type GenerationSession = {
  chatId: string;
  controller: AbortController;
  messageId: string;
  startedAt: number;
};

const activeGenerations = new Map<string, GenerationSession>();

/**
 * Returns the live generation session map used by streamProxy.
 *
 * @returns Mutable map of generation ID to session.
 */
export function getActiveGenerations(): Map<string, GenerationSession> {
  return activeGenerations;
}

/**
 * Returns the set of chat IDs that currently have active generations in progress.
 *
 * @returns Chat IDs with an in-flight generation.
 */
export function getActiveGenerationChatIds(): Set<string> {
  const chatIds = new Set<string>();
  for (const session of activeGenerations.values()) {
    chatIds.add(session.chatId);
  }
  return chatIds;
}
