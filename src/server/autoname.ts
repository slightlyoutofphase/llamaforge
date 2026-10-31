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
const autonameControllers = new Set<AbortController>();
const AUTONAME_SLOT_WAIT_MS = 60_000;
const AUTONAME_SLOT_POLL_MS = 150;
const AUTONAME_REQUEST_TIMEOUT_MS = 10_000;
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
 * Aborts the in-flight autoname request so a user generation can use the slot.
 *
 * The aborted attempt leaves the chat name unchanged and does not send another request.
 *
 * @returns No return value.
 */
export function cancelActiveAutoname(): void {
  for (const controller of autonameControllers) {
    controller.abort();
  }
}

/**
 * Waits for `delayMs`, or returns early when `signal` aborts.
 *
 * @param delayMs - Milliseconds to wait.
 * @param signal - Abort signal for the current autoname attempt.
 * @returns A promise that resolves when the delay ends or the attempt is cancelled.
 */
function waitForAbortOrDelay(delayMs: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted || delayMs <= 0) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(finish, delayMs);
    function finish(): void {
      clearTimeout(timer);
      signal.removeEventListener("abort", finish);
      resolve();
    }
    signal.addEventListener("abort", finish);
  });
}

/**
 * Yields until llama-server is not serving another generation, the wait budget expires, or autoname is cancelled.
 *
 * @param signal - Abort signal for the current autoname attempt.
 * @returns `true` when the inference slot is free. `false` when the wait expired or the attempt was cancelled.
 */
async function waitForIdleInferenceSlot(signal: AbortSignal): Promise<boolean> {
  const deadline = Date.now() + AUTONAME_SLOT_WAIT_MS;
  while (Date.now() <= deadline) {
    if (signal.aborted) return false;
    if (getActiveGenerationChatIds().size === 0) return true;
    await waitForAbortOrDelay(AUTONAME_SLOT_POLL_MS, signal);
  }
  return !signal.aborted && getActiveGenerationChatIds().size === 0;
}

/**
 * Strips a leading label from an autoname completion.
 *
 * Only the labels the model is told not to emit are removed: `title`, `summary`,
 * and `topic`, plus an optional `is`, `of`, `for`, or `about` connector.
 * Ordinary words such as "A Guide" and "Topicality" are left alone.
 *
 * @param raw - Title text after thinking tags have been removed.
 * @returns The cleaned title, or `Untitled Chat` when nothing remains.
 */
export function cleanAutonameTitle(raw: string): string {
  let title = raw.replace(/^(?:title|summary|topic)\b\s*(?:(?:is|of|for|about)\s+)?:?\s*/i, "");
  title = title.replace(/^["'\-\s]+|["'\-\s]+$/g, "");
  if (title.length > 50) title = title.substring(0, 50);
  return title || "Untitled Chat";
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
  const controller = new AbortController();
  autonameControllers.add(controller);

  try {
    await waitForAbortOrDelay(autonameStartDelayMs, controller.signal);
    if (controller.signal.aborted) return;

    const latestChat = await getChat(chatId);
    if (latestChat?.name !== "New Chat" || !latestChat.messages) {
      return;
    }

    const server = getServerStatus();
    if (server.status !== "running" || !server.port) return;
    if (controller.signal.aborted) return;

    if (!(await waitForIdleInferenceSlot(controller.signal))) {
      if (!controller.signal.aborted) {
        logError("Autoname skipped because llama-server stayed busy");
      }
      return;
    }
    if (controller.signal.aborted) return;

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
      signal: AbortSignal.any([
        controller.signal,
        AbortSignal.timeout(AUTONAME_REQUEST_TIMEOUT_MS),
      ]),
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
      const title = cleanAutonameTitle(stripThinkingFromTitle(String(rawTitle)));
      if (controller.signal.aborted) return;

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
    if (controller.signal.aborted) return;
    logError("Autonaming failed:", e instanceof Error ? e.message : String(e));
  } finally {
    autonameControllers.delete(controller);
    activeAutonames.delete(chatId);
  }
}
