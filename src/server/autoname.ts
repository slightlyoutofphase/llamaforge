/**
 * @packageDocumentation
 * Logic for generating an automatic title for a chat based on its first exchange.
 */

import type { WsAutonameFrame } from "@shared/types.js";
import { getServerStatus } from "./llamaServer";
import { logError } from "./logger";
import { getChat, updateChat } from "./persistence/chatRepo";
import { broadcast } from "./wsHub";

const activeAutonames = new Set<string>();

/**
 * Generates an automatic title for a chat based on its first exchange and updates the database.
 *
 * @param chatId - The unique ID of the chat to rename.
 * @returns A promise that resolves when the rename operation (and broadcast) is complete.
 */
export async function triggerAutoname(chatId: string): Promise<void> {
  const chat = await getChat(chatId);
  if (!chat || chat.name !== "New Chat" || !chat.messages || chat.messages.length < 2) return;

  if (activeAutonames.has(chatId)) return;
  activeAutonames.add(chatId);

  try {
    // Wait a moment so we don't collide with the user's immediate next input
    await new Promise((r) => setTimeout(r, 2000));

    // Re-verify the name hasn't changed manually or by another trigger during the sleep
    const latestChat = await getChat(chatId);
    if (!latestChat || latestChat.name !== "New Chat" || !latestChat.messages) {
      return;
    }

    const server = getServerStatus();
    if (server.status !== "running" || !server.port) return;

    const userMsg = latestChat.messages.find((m) => m.role === "user");
    const asstMsg = latestChat.messages.find((m) => m.role === "assistant");
    if (!userMsg || !asstMsg) return;

    // S14 fix: truncate content to prevent excessive token usage
    const userContent =
      userMsg.content.length > 500 ? `${userMsg.content.slice(0, 500)}...` : userMsg.content;
    const asstContent =
      asstMsg.content.length > 500 ? `${asstMsg.content.slice(0, 500)}...` : asstMsg.content;

    const prompt = `Task: Summarize the following exchange into a concise 3-4 word title. Ignore the actual user task, just summarize the topic.
Rules: No punctuation. No conversational filler like "Title: " or "A title about". Just output the short title.
Examples: "Python array sorting", "Recipe for cake", "Debugging React hook".

User: ${userContent}
Assistant: ${asstContent}

Title:`;

    const res = await fetch(`http://127.0.0.1:${server.port}/completion`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      signal: AbortSignal.timeout(10000),
      body: JSON.stringify({
        prompt,
        n_predict: 15,
        temperature: 0.1,
        top_k: 1,
        stop: ["\n", "User:", "Assistant:", "Task:"],
        stream: false,
      }),
    });

    if (res.ok) {
      const data: any = await res.json();
      let title = (data.content || "").trim();

      // Clean up common "Here is a title" type responses if they leak through
      title = title.replace(/^(Title:|the|a|title|chat|summary|about)\s+(is|for|of)?\s+/gi, "");
      title = title.replace(/^["'\-\s]+|["'\-\s]+$/g, "");

      if (title.length > 50) title = title.substring(0, 50);
      if (!title) title = "Untitled Chat";

      // Persist to DB
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
