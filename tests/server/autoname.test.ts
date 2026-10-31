/**
 * @packageDocumentation
 * Tests for automatic chat naming behavior.
 */

import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import {
  __setAutonameStartDelayMs,
  cleanAutonameTitle,
  triggerAutoname,
} from "../../src/server/autoname";
import { getActiveGenerations } from "../../src/server/generationRegistry";
import * as llamaServer from "../../src/server/llamaServer";
import { addMessage, createChat, getChat } from "../../src/server/persistence/chatRepo";
import { initDb, resetDb } from "../../src/server/persistence/db";
import { asFetch } from "../fixtures";

describe("autoname", () => {
  beforeEach(async () => {
    await initDb(":memory:");
    __setAutonameStartDelayMs(0);
    getActiveGenerations().clear();
  });

  afterEach(() => {
    __setAutonameStartDelayMs(2000);
    resetDb();
  });

  it("strips a title label without requiring a second space", () => {
    expect(cleanAutonameTitle("Title: Recipe notes")).toBe("Recipe notes");
    expect(cleanAutonameTitle("Summary of cakes")).toBe("cakes");
    expect(cleanAutonameTitle("Python array sorting")).toBe("Python array sorting");
  });

  it("ignores invalid or short chats", async () => {
    // If we call triggerAutoname with a nonexistent ID, it should gracefully return without throwing
    await expect(triggerAutoname("nonexistent_id")).resolves.toBeUndefined();
  });

  it("posts to chat completions with thinking disabled and strips leftover think tags", async () => {
    const chat = await createChat("New Chat");
    await addMessage({
      id: "u1",
      chatId: chat.id,
      role: "user",
      content: "How do I sort a Python list?",
      rawContent: "How do I sort a Python list?",
      position: 0,
      createdAt: Date.now(),
    });
    await addMessage({
      id: "a1",
      chatId: chat.id,
      role: "assistant",
      content: "Use list.sort() or sorted().",
      rawContent: "Use list.sort() or sorted().",
      position: 1,
      createdAt: Date.now(),
    });

    const statusSpy = spyOn(llamaServer, "getServerStatus").mockReturnValue({
      status: "running",
      port: 8080,
      config: null,
    });
    let capturedUrl = "";
    let capturedBody: unknown = null;
    const originalFetch = globalThis.fetch;
    globalThis.fetch = asFetch(async (input: RequestInfo | URL, init?: RequestInit) => {
      capturedUrl = String(input);
      capturedBody = init?.body ? JSON.parse(String(init.body)) : null;
      return new Response(
        JSON.stringify({
          choices: [{ message: { content: "<think>\nplan\n</think>Python list sorting" } }],
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    });

    try {
      await triggerAutoname(chat.id);
      expect(capturedUrl).toContain("/v1/chat/completions");
      expect(capturedBody).toEqual(
        expect.objectContaining({
          n_predict: 24,
          reasoning_format: "none",
          chat_template_kwargs: expect.objectContaining({ enable_thinking: false }),
        }),
      );
      const renamed = await getChat(chat.id);
      expect(renamed?.name).toBe("Python list sorting");
    } finally {
      globalThis.fetch = originalFetch;
      statusSpy.mockRestore();
    }
  });
});
