/**
 * @packageDocumentation
 * Tests for conversation context occupancy accounting.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { getChatContextUsage } from "../../src/server/contextUsage";
import { addMessage, createChat, updateChat } from "../../src/server/persistence/chatRepo";
import { initDb, resetDb } from "../../src/server/persistence/db";
import { createSystemPreset } from "../../src/server/persistence/presetRepo";

describe("contextUsage", () => {
  beforeEach(async () => {
    await initDb(":memory:");
  });

  afterEach(() => {
    resetDb();
  });

  it("returns zero tokens for an empty chat", async () => {
    const chat = await createChat("Empty");
    const usage = await getChatContextUsage(chat.id);
    expect(usage).not.toBeNull();
    expect(usage?.usedTokens).toBe(0);
    expect(usage?.contextSize).toBeNull();
  });

  it("includes the system prompt and all messages when switching chats", async () => {
    const system = {
      id: "sys-usage",
      name: "Usage System",
      content: "SYSTEM PROMPT FOR CONTEXT",
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
    await createSystemPreset(system);
    const first = await createChat("First");
    const second = await createChat("Second");
    await updateChat(first.id, { systemPresetId: system.id });

    await addMessage({
      id: "m1",
      chatId: first.id,
      role: "user",
      content: "hello from first conversation",
      rawContent: "hello from first conversation",
      position: 0,
      createdAt: Date.now(),
    });
    await addMessage({
      id: "m2",
      chatId: second.id,
      role: "user",
      content: "x",
      rawContent: "x",
      position: 0,
      createdAt: Date.now(),
    });

    const firstUsage = await getChatContextUsage(first.id);
    const secondUsage = await getChatContextUsage(second.id);
    expect(firstUsage?.usedTokens).toBeGreaterThan(secondUsage?.usedTokens ?? 0);
    expect(await getChatContextUsage("missing")).toBeNull();
  });
});
