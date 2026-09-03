/**
 * @packageDocumentation
 * Logic for generating an automatic title for a chat based on its first exchange.
 */

import type { WsAutonameFrame } from "../shared/types";
import {
  DEFAULT_THINKING_CONFIG,
  GEMMA4_THINKING_CONFIG,
  parseThinkTags,
} from "./chatTemplateEngine";
import { getActiveGenerationChatIds } from "./generationRegistry";
import { getServerStatus } from "./llamaServer";
import { logError } from "./logger";
import { getChat, updateChat } from "./persistence/chatRepo";
import { broadcast } from "./wsHub";

const activeAutonames = new Set<string>();
const AUTONAME_SLOT_WAIT_MS = 60_000;
const AUTONAME_SLOT_POLL_MS = 150;
let autonameStartDelayMs = 2000;

/**
 * Overrides the post-generation delay before autoname runs. Used by tests.
 *
 * @param delayMs - Milliseconds to wait after a completion before autonaming.
 * @returns No return value.
 * @internal
 */
export function __setAutonameStartDelayMs(delayMs: number): void {
  autonameStartDelayMs = delayMs;
}

/**
 * Yields until llama-server is not serving another generation, or the wait budget expires.
 *
 * @returns `true` when the inference slot is free.
 */
async function waitForIdleInferenceSlot(): Promise<boolean> {
  const deadline = Date.now() + AUTONAME_SLOT_WAIT_MS;
  while (Date.now() <= deadline) {
    if (getActiveGenerationChatIds().size === 0) return true;
    await new Promise((resolve) => setTimeout(resolve, AUTONAME_SLOT_POLL_MS));
  }
  return false;
}

/**
 * Removes residual thinking-tag wrappers from an autoname completion.
 *
 * @param raw - Raw model output.
 * @returns Visible title text with thinking spans stripped.
 */
function stripThinkingFromTitle(raw: string): string {
  let text = raw;
  for (const config of [DEFAULT_THINKING_CONFIG, GEMMA4_THINKING_CONFIG]) {
    const parsed = parseThinkTags(text, config.openTag, config.closeTag);
    if (parsed.content.trim()) {
      text = parsed.content;
    }
  }
  return text.trim();
}

/**
 * Generates an automatic title for a chat based on its first exchange and updates the database.
 *
 * @param chatId - The unique ID of the chat to rename.
 * @returns A promise that resolves when the rename operation (and broadcast) is complete.
 */
export async function triggerAutoname(chatId: string): Promise<void> {
  const chat = await getChat(chatId);
  if (chat?.name !== "New Chat" || !chat.messages || chat.messages.length < 2) return;

  if (activeAutonames.has(chatId)) return;
  activeAutonames.add(chatId);

  try {
    await new Promise((r) => setTimeout(r, autonameStartDelayMs));

    const latestChat = await getChat(chatId);
    if (latestChat?.name !== "New Chat" || !latestChat.messages) {
      return;
    }

    const server = getServerStatus();
    if (server.status !== "running" || !server.port) return;

    if (!(await waitForIdleInferenceSlot())) {
      logError("Autoname skipped because llama-server stayed busy");
      return;
    }

    const userMsg = latestChat.messages.find((m) => m.role === "user");
    const asstMsg = latestChat.messages.find((m) => m.role === "assistant");
    if (!userMsg || !asstMsg) return;

    const userContent =
      userMsg.content.length > 500 ? `${userMsg.content.slice(0, 500)}...` : userMsg.content;
    const asstContent =
      asstMsg.content.length > 500 ? `${asstMsg.content.slice(0, 500)}...` : asstMsg.content;

    const res = await fetch(`http://127.0.0.1:${server.port}/v1/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      signal: AbortSignal.timeout(10000),
      body: JSON.stringify({
        messages: [
          {
            role: "user",
            content: `Task: Summarize the following exchange into a concise 3-4 word title. Ignore the actual user task, just summarize the topic.
Rules: No punctuation. No conversational filler like "Title: " or "A title about". Just output the short title.
Examples: "Python array sorting", "Recipe for cake", "Debugging React hook".

User: ${userContent}
Assistant: ${asstContent}`,
          },
        ],
        n_predict: 24,
        temperature: 0.1,
        top_k: 1,
        stop: ["\n", "User:", "Assistant:", "Task:"],
        stream: false,
        chat_template_kwargs: { enable_thinking: false },
        reasoning_format: "none",
      }),
    });

    if (res.ok) {
      const data: unknown = await res.json();
      const payload = data && typeof data === "object" ? (data as Record<string, unknown>) : {};
      const choices = Array.isArray(payload["choices"]) ? payload["choices"] : [];
      const firstChoice =
        choices[0] && typeof choices[0] === "object"
          ? (choices[0] as Record<string, unknown>)
          : undefined;
      const message =
        firstChoice && typeof firstChoice["message"] === "object" && firstChoice["message"] !== null
          ? (firstChoice["message"] as Record<string, unknown>)
          : undefined;
      const rawTitle =
        (typeof message?.["content"] === "string" ? message["content"] : undefined) ??
        (typeof firstChoice?.["text"] === "string" ? firstChoice["text"] : undefined) ??
        (typeof payload["content"] === "string" ? payload["content"] : "") ??
        "";
      let title = stripThinkingFromTitle(String(rawTitle));

      title = title.replace(/^(Title:|the|a|title|chat|summary|about)\s+(is|for|of)?\s+/gi, "");
      title = title.replace(/^["'\-\s]+|["'\-\s]+$/g, "");

      if (title.length > 50) title = title.substring(0, 50);
      if (!title) title = "Untitled Chat";

      await updateChat(chatId, { name: title });

      broadcast({
        type: "autoname_result",
        chatId,
        name: title,
      } as WsAutonameFrame);
    } else {
      logError(`Autoname completion failed with status ${res.status}`);
    }
  } catch (e) {
    logError("Autonaming failed:", e instanceof Error ? e.message : String(e));
  } finally {
    activeAutonames.delete(chatId);
  }
}
