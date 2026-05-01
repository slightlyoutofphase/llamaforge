/**
 * @packageDocumentation
 * Tests for multimodal attachment processing and upload handling.
 */

import { describe, expect, it, mock } from "bun:test";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

const APP_ROOT = path.join(os.homedir(), ".llamaforge");

// Mock fs/promises for any remaining directory operations
mock.module("node:fs/promises", () => ({
  default: {
    mkdir: async () => {},
  },
  mkdir: async () => {},
}));

import { spyOn, afterAll } from "bun:test";

const fileSpy = spyOn(Bun, "file").mockImplementation((path: string | URL) => {
  const pathStr = path.toString();
  return {
    exists: async () => true,
    size: 100,
    text: async () => {
      if (pathStr.includes("img.png")) return "abc";
      if (pathStr.includes("audio.wav")) return "def";
      if (pathStr.includes("pic.jpg")) return "ghi";
      if (pathStr.includes("text.txt")) return "Hello text file";
      throw new Error(`File not found: ${pathStr}`);
    },
    arrayBuffer: async () => {
      if (pathStr.includes("img.png")) return Buffer.from("abc").buffer;
      if (pathStr.includes("audio.wav")) return Buffer.from("def").buffer;
      if (pathStr.includes("pic.jpg")) return Buffer.from("ghi").buffer;
      if (pathStr.includes("text.txt")) return Buffer.from("Hello text file").buffer;
      throw new Error(`File not found: ${pathStr}`);
    },
  } as any;
});

import { buildContentParts } from "../../src/server/multimodal";

describe("multimodal", () => {
  it("returns string when no media attachments", async () => {
    const res = await buildContentParts("test", []);
    expect(res).toBe("test");
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
    expect(parts[0].image_url.url).toBe(
      pathToFileURL(path.join(APP_ROOT, "attachments/img.png")).toString(),
    );
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

  it("builds audio parts correctly using image_url media parts", async () => {
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
    expect(parts[0].type).toBe("image_url");
    expect(parts[0].image_url.url).toBe(
      pathToFileURL(path.join(APP_ROOT, "attachments/audio.wav")).toString(),
    );
    expect(parts[1].type).toBe("text");
    expect(parts[1].text).toBe("Listen to this");
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
