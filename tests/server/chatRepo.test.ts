/**
 * @packageDocumentation
 * Tests for the chat repository persistence layer.
 */

import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import fs from "node:fs/promises";
import path from "node:path";
import {
  addMessage,
  createBranch,
  createChat,
  deleteChat,
  deleteMessageAndSubsequent,
  deleteMessagesAfter,
  getChat,
  getChats,
  getLastMessageId,
  updateChat,
  updateMessage,
} from "../../src/server/persistence/chatRepo";
import {
  getAppDataDir,
  getDb,
  initDb,
  resetDb,
  resolveAppDataPath,
} from "../../src/server/persistence/db";
import { videoAudioSidecarPaths } from "../../src/server/videoAudio";

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

  it("deletes a parent chat and keeps its branches with a null parent", async () => {
    const parent = await createChat("Parent Chat");
    await addMessage({
      id: "branch-point",
      chatId: parent.id,
      role: "user",
      content: "Branch from here",
      rawContent: "Branch from here",
      position: 0,
      createdAt: Date.now(),
    });
    const branchId = await createBranch(parent.id, "branch-point");

    await deleteChat(parent.id);

    expect(await getChat(parent.id)).toBeNull();
    const branch = await getChat(branchId);
    expect(branch).not.toBeNull();
    expect(branch?.parentId).toBeNull();
    expect(branch?.isBranch).toBe(true);
  });

  it("lists chats by creation date instead of last update time", async () => {
    const nowSpy = spyOn(Date, "now");
    let now = 1000;
    nowSpy.mockImplementation(() => now++);

    try {
      const first = await createChat("First Chat");
      const second = await createChat("Second Chat");
      await updateChat(first.id, { name: "First Chat Renamed" });

      const chats = await getChats();
      expect(chats[0]?.id).toBe(second.id);
      expect(chats[1]?.id).toBe(first.id);
    } finally {
      nowSpy.mockRestore();
    }
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
      metrics: {
        predictedTokens: 32,
        tokensPerSecond: 21.5,
        promptTokens: 128,
        promptTokensPerSecond: 450.2,
        cachedPromptTokens: 64,
        evaluatedPromptTokens: 80,
      },
    });

    const retrieved = await getChat(chat.id);
    expect(retrieved?.messages?.length).toBe(1);
    expect(retrieved?.messages?.[0]?.content).toBe("Hello");
    expect(retrieved?.messages?.[0]?.metrics?.tokensPerSecond).toBe(21.5);
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

  it("deletes a message and every subsequent message in the same chat", async () => {
    const chat = await createChat("Delete Subsequent");
    await addMessage({
      id: "keep-user",
      chatId: chat.id,
      role: "user",
      content: "Hello",
      rawContent: "Hello",
      position: 0,
      createdAt: Date.now(),
    });
    await addMessage({
      id: "drop-assistant",
      chatId: chat.id,
      role: "assistant",
      content: "Hi",
      rawContent: "Hi",
      position: 1,
      createdAt: Date.now(),
    });
    await addMessage({
      id: "drop-later",
      chatId: chat.id,
      role: "user",
      content: "Again",
      rawContent: "Again",
      position: 2,
      createdAt: Date.now(),
    });

    await deleteMessageAndSubsequent(chat.id, "drop-assistant");
    const remaining = await getChat(chat.id);
    expect(remaining?.messages?.map((message) => message.id)).toEqual(["keep-user"]);
    expect(getLastMessageId(chat.id)).toBe("keep-user");
    expect(await deleteMessageAndSubsequent(chat.id, "drop-assistant")).toBe(false);
  });

  it("returns false when updating a message that is not in the chat", async () => {
    const chat = await createChat("Missing Update");
    expect(await updateMessage("no-such-message", "x", "x", undefined, chat.id)).toBe(false);
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

  it("copies extracted video audio sidecars when branching a chat", async () => {
    const chat = await createChat("Video Branch");
    const messageId = "vid-msg";
    await addMessage({
      id: messageId,
      chatId: chat.id,
      role: "user",
      content: "Watch this",
      rawContent: "Watch this",
      position: 0,
      createdAt: Date.now(),
    });

    const storedName = "clip.mp4";
    const appDir = resolveAppDataPath("attachments", chat.id, messageId);
    await fs.mkdir(appDir, { recursive: true });
    const videoAbs = path.join(appDir, storedName);
    await Bun.write(videoAbs, "video-bytes");
    const sourceSidecar = videoAudioSidecarPaths(videoAbs);
    await Bun.write(sourceSidecar.audioPath, "wav-bytes");
    await Bun.write(sourceSidecar.markerPath, "");

    const relativePath = path.relative(getAppDataDir(), videoAbs).split(path.sep).join("/");
    getDb()
      .prepare(
        "INSERT INTO attachments (id, message_id, mime_type, file_path, file_name, vir_budget, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
      )
      .run("att-vid", messageId, "video/mp4", relativePath, storedName, null, Date.now());

    const branchId = await createBranch(chat.id, messageId);
    const branch = await getChat(branchId);
    const copied = branch?.messages?.[0]?.attachments?.[0];
    expect(copied).toBeDefined();
    expect(copied?.mimeType).toBe("video/mp4");
    expect(copied?.fileName).toBe(storedName);
    expect(copied?.filePath).not.toBe(relativePath);
    if (!copied) {
      throw new Error("expected the branched message to keep the video attachment");
    }

    const copiedAbs = path.join(getAppDataDir(), copied.filePath);
    const copiedSidecar = videoAudioSidecarPaths(copiedAbs);
    expect(await Bun.file(copiedAbs).text()).toBe("video-bytes");
    expect(await Bun.file(copiedSidecar.audioPath).exists()).toBe(true);
    expect(await Bun.file(copiedSidecar.audioPath).text()).toBe("wav-bytes");
    expect(await Bun.file(copiedSidecar.markerPath).exists()).toBe(true);
  });

  it("keeps branched soundtrack attachment paths paired to the copied video stem", async () => {
    const chat = await createChat("Video Soundtrack Branch");
    const messageId = "vid-snd-msg";
    await addMessage({
      id: messageId,
      chatId: chat.id,
      role: "user",
      content: "Watch this",
      rawContent: "Watch this",
      position: 0,
      createdAt: Date.now(),
    });

    const storedName = "clip.mp4";
    const appDir = resolveAppDataPath("attachments", chat.id, messageId);
    await fs.mkdir(appDir, { recursive: true });
    const videoAbs = path.join(appDir, storedName);
    await Bun.write(videoAbs, "video-bytes");
    const sourceSidecar = videoAudioSidecarPaths(videoAbs);
    await Bun.write(sourceSidecar.audioPath, "wav-bytes");

    const videoRel = path.relative(getAppDataDir(), videoAbs).split(path.sep).join("/");
    const audioRel = path
      .relative(getAppDataDir(), sourceSidecar.audioPath)
      .split(path.sep)
      .join("/");
    const db = getDb();
    db.prepare(
      "INSERT INTO attachments (id, message_id, mime_type, file_path, file_name, vir_budget, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
    ).run("att-vid", messageId, "video/mp4", videoRel, storedName, null, Date.now());
    db.prepare(
      "INSERT INTO attachments (id, message_id, mime_type, file_path, file_name, vir_budget, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
    ).run(
      "att-wav",
      messageId,
      "audio/wav",
      audioRel,
      "clip.extracted-audio.wav",
      null,
      Date.now(),
    );

    const branchId = await createBranch(chat.id, messageId);
    const branch = await getChat(branchId);
    const copied = branch?.messages?.[0]?.attachments ?? [];
    const copiedVideo = copied.find((att) => att.mimeType.startsWith("video/"));
    const copiedAudio = copied.find((att) => att.mimeType.startsWith("audio/"));
    expect(copiedVideo).toBeDefined();
    expect(copiedAudio).toBeDefined();
    if (!copiedVideo || !copiedAudio) {
      throw new Error("expected branched video and soundtrack attachments");
    }

    const copiedVideoAbs = path.join(getAppDataDir(), copiedVideo.filePath);
    const expectedAudio = videoAudioSidecarPaths(copiedVideoAbs).audioPath;
    const copiedAudioAbs = path.join(getAppDataDir(), copiedAudio.filePath);
    expect(copiedAudioAbs).toBe(expectedAudio);
    expect(await Bun.file(copiedAudioAbs).text()).toBe("wav-bytes");
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
    expect(importedChat?.messages?.[0]?.content).toBe("Export test");
  });

  it("imports extracted soundtracks larger than 10MB and keeps them paired to the video", async () => {
    const { importChat } = require("../../src/server/persistence/chatRepo");
    const oversized = new Uint8Array(10 * 1024 * 1024 + 32);
    oversized.fill(9);
    const base64Data = Buffer.from(oversized).toString("base64");
    const importedId = await importChat(
      JSON.stringify({
        name: "Big Soundtrack",
        messages: [
          {
            role: "user",
            content: "Watch this",
            rawContent: "Watch this",
            createdAt: Date.now(),
            attachments: [
              {
                id: "v1",
                mimeType: "video/mp4",
                fileName: "clip.mp4",
                filePath: "attachments/c/m/clip.mp4",
                base64Data: Buffer.from("video-bytes").toString("base64"),
              },
              {
                id: "a1",
                mimeType: "audio/wav",
                fileName: "clip.extracted-audio.wav",
                filePath: "attachments/c/m/clip.extracted-audio.wav",
                base64Data,
              },
            ],
          },
        ],
      }),
    );
    const imported = await getChat(importedId);
    const copied = imported?.messages?.[0]?.attachments ?? [];
    const copiedVideo = copied.find((att) => att.mimeType.startsWith("video/"));
    const copiedAudio = copied.find((att) => att.mimeType.startsWith("audio/"));
    expect(copiedVideo).toBeDefined();
    expect(copiedAudio).toBeDefined();
    if (!copiedVideo || !copiedAudio) {
      throw new Error("expected imported video and soundtrack");
    }
    const copiedVideoAbs = path.join(getAppDataDir(), copiedVideo.filePath);
    expect(path.join(getAppDataDir(), copiedAudio.filePath)).toBe(
      videoAudioSidecarPaths(copiedVideoAbs).audioPath,
    );
    expect(
      (await Bun.file(path.join(getAppDataDir(), copiedAudio.filePath)).bytes()).byteLength,
    ).toBe(oversized.byteLength);
  });

  it("rejects imported tool messages without a toolCallId", async () => {
    const invalidImport = JSON.stringify({
      name: "Broken Tool Chat",
      messages: [
        {
          role: "tool",
          content: "{}",
        },
      ],
    });

    await expect(importChat(invalidImport)).rejects.toThrow("toolCallId");
  });

  it("strips malformed assistant toolCallsJson during import instead of failing the chat", async () => {
    const importedId = await importChat(
      JSON.stringify({
        name: "Malformed Tool Calls",
        messages: [
          {
            role: "assistant",
            content: "Still import this",
            toolCallsJson: "{not valid json",
          },
        ],
      }),
    );

    const importedChat = await getChat(importedId);
    expect(importedChat?.messages?.[0]?.content).toBe("Still import this");
    expect(importedChat?.messages?.[0]?.toolCallsJson).toBeUndefined();
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
