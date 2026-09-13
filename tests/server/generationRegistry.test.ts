/**
 * @packageDocumentation
 * Tests for the in-process map of active llama-server generations.
 */

import { afterEach, describe, expect, it } from "bun:test";
import {
  getActiveGenerationChatIds,
  getActiveGenerations,
} from "../../src/server/generationRegistry";

describe("generationRegistry", () => {
  afterEach(() => {
    getActiveGenerations().clear();
  });

  it("returns an empty chat-id set when no generations are running", () => {
    expect(getActiveGenerations().size).toBe(0);
    expect(getActiveGenerationChatIds().size).toBe(0);
  });

  it("deduplicates chat IDs that have more than one in-flight generation", () => {
    const generations = getActiveGenerations();
    generations.set("gen-1", {
      chatId: "chat-a",
      controller: new AbortController(),
      messageId: "msg-1",
      startedAt: 1,
    });
    generations.set("gen-2", {
      chatId: "chat-a",
      controller: new AbortController(),
      messageId: "msg-2",
      startedAt: 2,
    });
    generations.set("gen-3", {
      chatId: "chat-b",
      controller: new AbortController(),
      messageId: "msg-3",
      startedAt: 3,
    });

    const chatIds = getActiveGenerationChatIds();
    expect(chatIds.size).toBe(2);
    expect(chatIds.has("chat-a")).toBe(true);
    expect(chatIds.has("chat-b")).toBe(true);
  });
});
