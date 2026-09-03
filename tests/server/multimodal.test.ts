/**
 * @packageDocumentation
 * Tests for multimodal attachment processing and upload handling.
 */

import fs from "node:fs/promises";
import path from "node:path";
import { afterAll, afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import { getAppDataDir, getDb, initDb, resetDb } from "../../src/server/persistence/db";
import { buildContentParts, processUpload } from "../../src/server/multimodal";

const encoder = new TextEncoder();
let mkdirSpy: ReturnType<typeof spyOn<typeof fs, "mkdir">>;
let writeSpy: ReturnType<typeof spyOn<typeof Bun, "write">>;

const fileSpy = spyOn(Bun, "file").mockImplementation((filePath: string | URL) => {
  const pathStr = filePath.toString();
  return {
    exists: async () => true,
    size: 100,
    text: async () => {
      if (pathStr.includes("large-a.txt")) return "A".repeat(15000);
      if (pathStr.includes("large-b.txt")) return "B".repeat(15000);
      if (pathStr.includes("large-c.txt")) return "C".repeat(15000);
      if (pathStr.includes("img.png")) return "abc";
      if (pathStr.includes("audio.wav")) return "def";
      if (pathStr.includes("pic.jpg")) return "ghi";
      if (pathStr.includes("text.txt")) return "Hello text file";
      throw new Error(`File not found: ${pathStr}`);
    },
    arrayBuffer: async () => {
      if (pathStr.includes("img.png")) return encoder.encode("abc").buffer;
      if (pathStr.includes("audio.wav")) return encoder.encode("def").buffer;
      if (pathStr.includes("pic.jpg")) return encoder.encode("ghi").buffer;
      if (pathStr.includes("text.txt")) return encoder.encode("Hello text file").buffer;
      throw new Error(`File not found: ${pathStr}`);
    },
  } as any;
});
describe("multimodal", () => {
  beforeEach(async () => {
    mkdirSpy = spyOn(fs, "mkdir").mockResolvedValue(undefined);
    writeSpy = spyOn(Bun, "write").mockResolvedValue(3);
    await initDb(":memory:");
  });

  afterEach(() => {
    resetDb();
    mkdirSpy.mockRestore();
    writeSpy.mockRestore();
  });

  it("returns string when no media attachments", async () => {
    const res = await buildContentParts("test", []);
    expect(res).toBe("test");
  });

  it("stores uploaded attachments beneath the effective test app data dir", async () => {
    const db = getDb(":memory:");
    db.prepare("INSERT INTO chats (id, name, created_at, updated_at) VALUES (?, ?, ?, ?)").run(
      "chat-a",
      "Chat A",
      1,
      1,
    );
    db.prepare(
      "INSERT INTO messages (id, chat_id, role, content, raw_content, position, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
    ).run("msg-a", "chat-a", "user", "hello", "hello", 0, 1);

    const attachment = await processUpload(
      "chat-a",
      "msg-a",
      "note.txt",
      "text/plain",
      Uint8Array.from([97, 98, 99]).buffer,
    );

    const lastCall = writeSpy.mock.calls.at(-1);
    expect(lastCall).toBeDefined();
    expect(String(lastCall?.[0]).startsWith(path.join(getAppDataDir(), "attachments"))).toBe(true);
    expect(attachment.filePath.startsWith("attachments/chat-a/msg-a/")).toBe(true);
  });

  it("appends extracted text to string output", async () => {
    const res = await buildContentParts("Main prompt", [
      {
        id: "1",
        messageId: "2",
        mimeType: "text/plain",
        fileName: "test.txt",
        filePath: "attachments/test.txt",
        createdAt: 0,
        extractedText: "Hello world",
      } as any,
    ]);
    expect(res as string).toContain("--- Attached file: test.txt ---");
    expect(res as string).toContain("Hello world");
    expect(res as string).toContain("Main prompt");
  });

  it("loads text attachment content from stored file path when not already extracted", async () => {
    const res = await buildContentParts("Main prompt", [
      {
        id: "1",
        messageId: "2",
        mimeType: "text/plain",
        fileName: "text.txt",
        filePath: "attachments/text.txt",
        createdAt: 0,
      } as any,
    ]);
    expect(res as string).toContain("--- Attached file: text.txt ---");
    expect(res as string).toContain("Hello text file");
    expect(res as string).toContain("Main prompt");
  });

  it("does not duplicate extracted text when the stored message already includes attachment markers", async () => {
    const res = await buildContentParts(
      "Main prompt\n--- Attached file: test.txt ---\nHello world\n--- End of file ---\n",
      [
        {
          id: "1",
          messageId: "2",
          mimeType: "text/plain",
          fileName: "test.txt",
          filePath: "attachments/test.txt",
          createdAt: 0,
          extractedText: "Hello world",
        } as any,
      ],
    );
    expect(res as string).toContain("--- Attached file: test.txt ---");
    expect((res as string).match(/Hello world/g)?.length).toBe(1);
  });

  it("caps extracted text per attachment and per message when rebuilding prompt text", async () => {
    const res = await buildContentParts("Main prompt", [
      {
        id: "1",
        messageId: "2",
        mimeType: "text/plain",
        fileName: "large-a.txt",
        filePath: "attachments/large-a.txt",
        createdAt: 0,
      } as any,
      {
        id: "3",
        messageId: "4",
        mimeType: "text/plain",
        fileName: "large-b.txt",
        filePath: "attachments/large-b.txt",
        createdAt: 0,
      } as any,
      {
        id: "5",
        messageId: "6",
        mimeType: "text/plain",
        fileName: "large-c.txt",
        filePath: "attachments/large-c.txt",
        createdAt: 0,
      } as any,
    ]);

    expect(typeof res).toBe("string");
    expect((res as string).length).toBeLessThan(26000);
    expect(res as string).toContain("Attachment text truncated: kept 12000 of 15000 characters.");
    expect(res as string).toContain(
      "[Attachment text omitted: message attachment text budget exhausted.]",
    );
    expect(res as string).toContain("Main prompt");
  });

  it("builds image parts successfully if vision is supported", async () => {
    const attachments = [
      {
        id: "1",
        messageId: "2",
        mimeType: "image/png",
        fileName: "img.png",
        filePath: "attachments/img.png",
        createdAt: 0,
      } as any,
    ];
    const metadata = { hasVisionEncoder: true } as any;

    const res = await buildContentParts("Look at this", attachments, metadata);
    expect(Array.isArray(res)).toBe(true);
    const parts = res as any[];
    expect(parts[0].type).toBe("image_url");
    expect(parts[0].image_url.url).toBe("file://attachments/img.png");
    expect(parts[1].type).toBe("text");
    expect(parts[1].text).toBe("Look at this");
  });

  it("skips image if model has no vision encoder", async () => {
    const attachments = [
      {
        id: "1",
        messageId: "2",
        mimeType: "image/png",
        fileName: "img.png",
        filePath: "attachments/img.png",
        createdAt: 0,
      } as any,
    ];
    const metadata = { hasVisionEncoder: false } as any;

    const res = await buildContentParts("Look at this", attachments, metadata);
    expect(typeof res).toBe("string");
    expect(res).toBe("Look at this");
  });

  it("builds audio parts correctly using input_audio media parts", async () => {
    const attachments = [
      {
        id: "1",
        messageId: "2",
        mimeType: "audio/wav",
        fileName: "audio.wav",
        filePath: "attachments/audio.wav",
        createdAt: 0,
      } as any,
    ];
    const metadata = { hasAudioEncoder: true } as any;

    const res = await buildContentParts("Listen to this", attachments, metadata);
    expect(Array.isArray(res)).toBe(true);
    const parts = res as any[];
    expect(parts[0].type).toBe("input_audio");
    expect(parts[0].input_audio.url).toBe("file://attachments/audio.wav");
    expect(parts[1].type).toBe("text");
    expect(parts[1].text).toBe("Listen to this");
  });

  it("builds video parts correctly using input_video media parts", async () => {
    const attachments = [
      {
        id: "1",
        messageId: "2",
        mimeType: "video/mp4",
        fileName: "video.mp4",
        filePath: "attachments/video.mp4",
        createdAt: 0,
      } as any,
    ];
    const metadata = { hasVisionEncoder: true } as any;

    const res = await buildContentParts("Watch this", attachments, metadata);
    expect(Array.isArray(res)).toBe(true);
    const parts = res as any[];
    expect(parts[0].type).toBe("input_video");
    expect(parts[0].input_video.url).toBe("file://attachments/video.mp4");
    expect(parts[1].type).toBe("text");
    expect(parts[1].text).toBe("Watch this");
  });

  it("skips video if model has no vision encoder", async () => {
    const attachments = [
      {
        id: "1",
        messageId: "2",
        mimeType: "video/mp4",
        fileName: "video.mp4",
        filePath: "attachments/video.mp4",
        createdAt: 0,
      } as any,
    ];
    const metadata = { hasVisionEncoder: false } as any;

    const res = await buildContentParts("Watch this", attachments, metadata);
    expect(typeof res).toBe("string");
    expect(res).toBe("Watch this");
  });

  it("builds gemma4 image_url payloads without per-attachment budget fields", async () => {
    const attachments = [
      {
        id: "1",
        messageId: "2",
        mimeType: "image/jpeg",
        fileName: "pic.jpg",
        filePath: "attachments/pic.jpg",
        createdAt: 0,
      } as any,
    ];
    const metadata = { architecture: "gemma4", hasVisionEncoder: true } as any;

    const res = await buildContentParts("test", attachments, metadata);
    const parts = res as any[];
    expect(parts[0].type).toBe("image_url");
    expect(parts[0].resolution).toBeUndefined();
  });

  afterAll(() => {
    fileSpy.mockRestore();
  });
});
