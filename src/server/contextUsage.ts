/**
 * @packageDocumentation
 * Estimates the token occupancy of a chat relative to the loaded context window.
 */

import { resolveInferencePreset } from "../shared/inferencePresetResolve";
import type { ChatContextUsage } from "../shared/types";
import { detectThinkingConfig } from "./chatTemplateEngine";
import { getActiveThinkingTagOverride, getServerStatus } from "./llamaServer";
import { getTokenizerEpoch, getTokens } from "./overflow";
import { getChatForPrompt, getMetadataForPath } from "./persistence/chatRepo";
import { getInferencePresets, getSystemPresets } from "./persistence/presetRepo";

/** Last context-usage result that can be reused while the memo key is unchanged. */
let contextUsageCache: { key: string; usage: ChatContextUsage } | null = null;

/**
 * Clears the memoized context-usage result. Intended for tests.
 *
 * @returns No return value.
 * @internal
 */
export function __resetContextUsageCache(): void {
  contextUsageCache = null;
}
import {
  buildApiMessages,
  buildRequestResponseFormat,
  buildRequestThinkingConfig,
  buildRequestTools,
  serializePromptForTokens,
  withSystemPrompt,
} from "./promptPayload";

/**
 * Calculates used/total context occupancy for a chat, using llama-server tokenization
 * when a model is loaded and a character heuristic otherwise.
 *
 * Pagination of the chat view is ignored: occupancy always uses the full transcript,
 * the active system prompt, and the same tools, response schema, and thinking kwargs
 * a send would include.
 *
 * @param chatId - Chat whose occupancy should be measured.
 * @returns Context usage, or `null` when the chat does not exist.
 */
export async function getChatContextUsage(chatId: string): Promise<ChatContextUsage | null> {
  const chat = await getChatForPrompt(chatId);
  if (!chat) return null;

  const server = getServerStatus();
  const contextSize =
    server.status === "running" && server.config?.contextSize ? server.config.contextSize : null;
  const systemPresets = await getSystemPresets();
  const systemPreset = systemPresets.find((preset) => preset.id === chat.systemPresetId);
  const systemContent = systemPreset?.content || "";
  const transcript = chat.messages ?? [];
  const cacheKey = [
    chatId,
    String(transcript.length),
    transcript.at(-1)?.id ?? "",
    String(chat.updatedAt),
    chat.inferencePresetId ?? "",
    systemContent,
    String(getTokenizerEpoch()),
    String(contextSize),
  ].join("\0");
  if (contextUsageCache?.key === cacheKey) return contextUsageCache.usage;

  const messages = withSystemPrompt(chatId, systemContent, transcript, chat.createdAt);
  if (messages.length === 0) {
    const usage = { usedTokens: 0, contextSize };
    contextUsageCache = { key: cacheKey, usage };
    return usage;
  }

  const inferencePresets = await getInferencePresets();
  const inferencePreset = resolveInferencePreset(inferencePresets, {
    chatPresetId: chat.inferencePresetId,
    modelPath: server.config?.modelPath,
  });
  const requestTools = await buildRequestTools(inferencePreset);
  const requestResponseFormat = buildRequestResponseFormat(inferencePreset);
  const thinkingTagOverride = getActiveThinkingTagOverride();
  const requestThinkingConfig = await buildRequestThinkingConfig(
    inferencePreset,
    server.config?.presetId,
    thinkingTagOverride?.enableToken,
  );
  const modelMeta = server.config?.modelPath
    ? await getMetadataForPath(server.config.modelPath)
    : null;
  const apiMessageContext = {
    preserveThinking: requestThinkingConfig.chat_template_kwargs.preserve_thinking,
    thinkingConfig: detectThinkingConfig(modelMeta?.architecture, thinkingTagOverride),
    modelMeta,
  };

  const usedTokens = await getTokens(messages, server.port ?? undefined, {
    buildPromptText: async (promptMessages) =>
      serializePromptForTokens(await buildApiMessages(promptMessages, apiMessageContext), {
        tools: requestTools,
        responseFormat: requestResponseFormat,
        thinking: requestThinkingConfig,
      }),
  });
  const usage = { usedTokens, contextSize };
  contextUsageCache = { key: cacheKey, usage };
  return usage;
}
