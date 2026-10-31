/**
 * @packageDocumentation
 * Tests for conversation context occupancy accounting.
 */

import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import { __resetContextUsageCache, getChatContextUsage } from "../../src/server/contextUsage";
import * as overflow from "../../src/server/overflow";
import { createDefaultInferenceSampling } from "../../src/shared/defaults";
import { addMessage, createChat, updateChat } from "../../src/server/persistence/chatRepo";
import { initDb, resetDb } from "../../src/server/persistence/db";
import { createInferencePreset, createSystemPreset } from "../../src/server/persistence/presetRepo";

describe("contextUsage", () => {
  beforeEach(async () => {
    __resetContextUsageCache();
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

  it("includes tool definitions when the chat's inference preset enables tools", async () => {
    const toolDescription = "Look up a library fact. ".repeat(80);
    await createInferencePreset({
      ...createDefaultInferenceSampling(),
      id: "tools-usage",
      name: "Tools Usage",
      isDefault: false,
      toolCallsEnabled: true,
      tools: [
        {
          name: "lookup_library",
          description: toolDescription,
          parameters: {
            type: "object",
            properties: {
              query: { type: "string", description: toolDescription },
            },
          },
        },
      ],
      createdAt: 1,
      updatedAt: 1,
    });

    const plain = await createChat("Plain");
    const withTools = await createChat("With Tools");
    await updateChat(withTools.id, { inferencePresetId: "tools-usage" });
    const text = "hello";
    await addMessage({
      id: "plain-user",
      chatId: plain.id,
      role: "user",
      content: text,
      rawContent: text,
      position: 0,
      createdAt: 1,
    });
    await addMessage({
      id: "tools-user",
      chatId: withTools.id,
      role: "user",
      content: text,
      rawContent: text,
      position: 0,
      createdAt: 1,
    });

    const plainUsage = await getChatContextUsage(plain.id);
    const toolUsage = await getChatContextUsage(withTools.id);
    expect(toolUsage?.usedTokens).toBeGreaterThan(plainUsage?.usedTokens ?? 0);
  });

  it("reuses a context-usage result until the transcript changes", async () => {
    const chat = await createChat("Cached usage");
    await addMessage({
      id: "usage-1",
      chatId: chat.id,
      role: "user",
      content: "hello",
      rawContent: "hello",
      position: 0,
      createdAt: 1,
    });
    const tokenSpy = spyOn(overflow, "getTokens");
    const first = await getChatContextUsage(chat.id);
    const second = await getChatContextUsage(chat.id);
    expect(second).toEqual(first);
    expect(tokenSpy).toHaveBeenCalledTimes(1);

    await addMessage({
      id: "usage-2",
      chatId: chat.id,
      role: "assistant",
      content: "more",
      rawContent: "more",
      position: 1,
      createdAt: 2,
    });
    const third = await getChatContextUsage(chat.id);
    expect(third?.usedTokens).toBeGreaterThan(first?.usedTokens ?? 0);
    expect(tokenSpy).toHaveBeenCalledTimes(2);
    tokenSpy.mockRestore();
  });
});
