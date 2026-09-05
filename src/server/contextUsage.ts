/**
 * @packageDocumentation
 * Estimates the token occupancy of a chat relative to the loaded context window.
 */

import type { ChatContextUsage, ChatMessage } from "../shared/types";
import { getServerStatus } from "./llamaServer";
import { getTokens } from "./overflow";
import { getChat } from "./persistence/chatRepo";
import { getSystemPresets } from "./persistence/presetRepo";

/**
 * Builds the prompt-side message list that inference would send for a chat,
 * including the configured system prompt.
 *
 * @param chatId - Chat whose occupancy should be measured.
 * @returns Messages that contribute to the context window, or `null` when the chat does not exist.
 */
async function buildChatPromptMessages(chatId: string): Promise<ChatMessage[] | null> {
  const chat = await getChat(chatId);
  if (!chat) return null;

  const sysPresets = await getSystemPresets();
  const sysPreset = sysPresets.find((preset) => preset.id === chat.systemPresetId);
  const messages: ChatMessage[] = [];
  const sysContent = sysPreset?.content?.trim() ?? "";
  if (sysContent) {
    messages.push({
      id: "sys",
      chatId,
      role: "system",
      content: sysContent,
      rawContent: sysContent,
      position: 0,
      createdAt: chat.createdAt,
    });
  }
  messages.push(...(chat.messages ?? []));
  return messages;
}

/**
 * Calculates used/total context occupancy for a chat, using llama-server tokenization
 * when a model is loaded and a character heuristic otherwise.
 *
 * Pagination of the chat view is ignored: occupancy always uses the full transcript
 * plus the active system prompt so switching conversations cannot under-count.
 *
 * @param chatId - Chat whose occupancy should be measured.
 * @returns Context usage, or `null` when the chat does not exist.
 */
export async function getChatContextUsage(chatId: string): Promise<ChatContextUsage | null> {
  const messages = await buildChatPromptMessages(chatId);
  if (messages === null) return null;

  const server = getServerStatus();
  const contextSize =
    server.status === "running" && server.config?.contextSize ? server.config.contextSize : null;
  if (messages.length === 0) {
    return { usedTokens: 0, contextSize };
  }

  const usedTokens = await getTokens(messages, server.port ?? undefined);
  return { usedTokens, contextSize };
}
