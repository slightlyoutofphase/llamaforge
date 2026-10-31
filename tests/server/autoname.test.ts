/**
 * @packageDocumentation
 * Tests for automatic chat naming behavior.
 */

import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import * as autoname from "../../src/server/autoname";
import {
  __setAutonameStartDelayMs,
  cancelActiveAutoname,
  cleanAutonameTitle,
  triggerAutoname,
} from "../../src/server/autoname";
import { getActiveGenerations } from "../../src/server/generationRegistry";
import * as llamaServer from "../../src/server/llamaServer";
import * as logger from "../../src/server/logger";
import { addMessage, createChat, getChat } from "../../src/server/persistence/chatRepo";
import { initDb, resetDb } from "../../src/server/persistence/db";
import { proxyCompletion } from "../../src/server/streamProxy";
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
    expect(cleanAutonameTitle("A Guide to Rust")).toBe("A Guide to Rust");
    expect(cleanAutonameTitle("Topic: Rust ownership")).toBe("Rust ownership");
    expect(cleanAutonameTitle("Topicality")).toBe("Topicality");
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

  it("a send during autoname aborts it and leaves the chat name unchanged", async () => {
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
    const logSpy = spyOn(logger, "logError").mockImplementation(() => {});
    let fetchStarted: (() => void) | undefined;
    const started = new Promise<void>((resolve) => {
      fetchStarted = resolve;
    });
    const originalFetch = globalThis.fetch;
    globalThis.fetch = asFetch((_input: RequestInfo | URL, init?: RequestInit) => {
      fetchStarted?.();
      return new Promise((_resolve, reject) => {
        const abort = () => reject(new DOMException("The operation was aborted.", "AbortError"));
        if (init?.signal?.aborted) {
          abort();
          return;
        }
        init?.signal?.addEventListener("abort", abort, { once: true });
      });
    });

    try {
      const pending = triggerAutoname(chat.id);
      await started;
      cancelActiveAutoname();
      await pending;
      expect((await getChat(chat.id))?.name).toBe("New Chat");
      expect(logSpy).not.toHaveBeenCalled();
    } finally {
      globalThis.fetch = originalFetch;
      statusSpy.mockRestore();
      logSpy.mockRestore();
    }
  });

  it("cancels autoname on a user send and leaves a tool follow-up alone", async () => {
    const statusSpy = spyOn(llamaServer, "getServerStatus").mockReturnValue({
      status: "idle",
      port: null,
      config: null,
    });
    const cancelSpy = spyOn(autoname, "cancelActiveAutoname").mockImplementation(() => {});
    try {
      await expect(
        proxyCompletion({ chatId: "missing-chat", content: "hello", attachments: [] }),
      ).rejects.toThrow("Llama-server is not running.");
      expect(cancelSpy).toHaveBeenCalledTimes(1);
      cancelSpy.mockClear();
      await expect(
        proxyCompletion({
          chatId: "missing-chat",
          content: "hello",
          attachments: [],
          isToolRecurse: true,
        }),
      ).rejects.toThrow("Llama-server is not running.");
      expect(cancelSpy).not.toHaveBeenCalled();
    } finally {
      cancelSpy.mockRestore();
      statusSpy.mockRestore();
    }
  });
});
