import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import {
  addMessage,
  createBranch,
  createChat,
  deleteChat,
  deleteMessagesAfter,
  getChat,
  getChats,
  updateChat,
  updateMessage,
} from "../../src/server/persistence/chatRepo";
import { initDb, resetDb } from "../../src/server/persistence/db";

describe("chatRepo", () => {
  beforeEach(async () => {
    await initDb(":memory:");
  });

  afterEach(() => {
    resetDb();
  });

  it("creates and retrieves a chat", async () => {
    const chat = await createChat("Test Chat");
    expect(chat.id).toBeDefined();
    expect(chat.name).toBe("Test Chat");

    const chats = await getChats();
    expect(chats.length).toBeGreaterThan(0);
    expect(chats.find((c) => c.id === chat.id)).toBeDefined();

    const single = await getChat(chat.id);
    expect(single?.id).toBe(chat.id);
    expect(single?.messages).toEqual([]);
  });

  it("updates and deletes a chat", async () => {
    const chat = await createChat("Update Me");
    await updateChat(chat.id, { name: "Updated Name" });
    const updated = await getChat(chat.id);
    expect(updated?.name).toBe("Updated Name");

    await deleteChat(chat.id);
    const deleted = await getChat(chat.id);
    expect(deleted).toBeNull();
  });

  it("adds and retrieves messages", async () => {
    const chat = await createChat("Message Test");
    await addMessage({
      id: "msg1",
      chatId: chat.id,
      role: "user",
      content: "Hello",
      rawContent: "Hello",
      position: 0,
      createdAt: Date.now(),
    });

    const retrieved = await getChat(chat.id);
    expect(retrieved?.messages?.length).toBe(1);
    expect(retrieved?.messages?.[0]?.content).toBe("Hello");
  });

  it("updates and deletes messages", async () => {
    const chat = await createChat("Message Update Test");
    await addMessage({
      id: "msg2",
      chatId: chat.id,
      role: "assistant",
      content: "Hi",
      rawContent: "Hi",
      position: 0,
      createdAt: Date.now(),
    });

    await updateMessage("msg2", "Hello there", "Hello there", "thinking");
    const updated = await getChat(chat.id);
    expect(updated?.messages?.[0]?.content).toBe("Hello there");
    expect(updated?.messages?.[0]?.thinkingContent).toBe("thinking");

    await deleteMessagesAfter(chat.id, -1);
    const empty = await getChat(chat.id);
    expect(empty?.messages?.length).toBe(0);
  });

  it("creates a branch", async () => {
    const chat = await createChat("Branch Info");
    await addMessage({
      id: "msg3",
      chatId: chat.id,
      role: "user",
      content: "M1",
      rawContent: "M1",
      position: 0,
      createdAt: Date.now(),
    });
    const branchId = await createBranch(chat.id, "msg3");

    const branch = await getChat(branchId);
    expect(branch).toBeDefined();
    expect(branch?.parentId).toBe(chat.id);
    expect(branch?.isBranch).toBe(true);
    expect(branch?.messages?.length).toBe(1);
  });

  const { exportChat, importChat } = require("../../src/server/persistence/chatRepo");

  it("exports and imports a chat session", async () => {
    const chat = await createChat("Exchange");
    await addMessage({
      id: "exp1",
      chatId: chat.id,
      role: "user",
      content: "Export test",
      rawContent: "Export test",
      position: 0,
      createdAt: Date.now(),
    });

    const json = await exportChat(chat.id, "json");
    expect(json).toContain("Export test");

    const importedId = await importChat(json);
    const importedChat = await getChat(importedId);
    expect(importedChat?.name).toContain("Exchange");
    expect(importedChat?.messages?.length).toBe(1);
    expect(importedChat?.messages?.[0].content).toBe("Export test");
  });

  it("exports a chat to markdown", async () => {
    const chat = await createChat("MD Export");
    await addMessage({
      id: "exp2",
      chatId: chat.id,
      role: "user",
      content: "Test list:\n- item 1",
      rawContent: "Test list:\n- item 1",
      position: 0,
      createdAt: Date.now(),
    });

    const md = await exportChat(chat.id, "markdown");
    expect(md).toContain("# MD Export");
    expect(md).toContain("### USER");
    expect(md).toContain("item 1");
  });
});
