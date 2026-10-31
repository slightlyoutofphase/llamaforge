/**
 * @packageDocumentation
 * Tests for multimodal attachment processing and upload handling.
 */

import { afterAll, afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import fs from "node:fs/promises";
import path from "node:path";
import {
  __setAllowPipedVideo,
  __setExtractVideoFrames,
  __setPreferNativeInputVideo,
  __setResolveVideoAudioSidecar,
  buildContentParts,
  processUpload,
} from "../../src/server/multimodal";
import { getAppDataDir, getDb, initDb, resetDb } from "../../src/server/persistence/db";
import { saveSettings } from "../../src/server/persistence/settingsRepo";

const encoder = new TextEncoder();
let mkdirSpy: ReturnType<typeof spyOn<typeof fs, "mkdir">>;
let writeSpy: ReturnType<typeof spyOn<typeof Bun, "write">>;

const fileSpy = spyOn(Bun, "file").mockImplementation(
  (filePath: string | URL | ArrayBufferLike | Uint8Array<ArrayBuffer> | number) => {
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
  },
);
describe("multimodal", () => {
  beforeEach(async () => {
    mkdirSpy = spyOn(fs, "mkdir").mockResolvedValue(undefined);
    writeSpy = spyOn(Bun, "write").mockResolvedValue(3);
    __setExtractVideoFrames(async () => []);
    __setResolveVideoAudioSidecar(async () => {
      throw new Error("video audio sidecar resolution should be skipped unless enabled");
    });
    __setAllowPipedVideo(true);
    __setPreferNativeInputVideo(true);
    await initDb(":memory:");
  });

  afterEach(() => {
    resetDb();
    mkdirSpy.mockRestore();
    writeSpy.mockRestore();
    __setExtractVideoFrames(null);
    __setResolveVideoAudioSidecar(null);
    __setAllowPipedVideo(null);
    __setPreferNativeInputVideo(null);
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

  function seedAttachmentMessage(messageId = "msg-a"): void {
    const db = getDb(":memory:");
    db.prepare(
      "INSERT OR IGNORE INTO chats (id, name, created_at, updated_at) VALUES (?, ?, ?, ?)",
    ).run("chat-a", "Chat A", 1, 1);
    db.prepare(
      "INSERT INTO messages (id, chat_id, role, content, raw_content, position, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
    ).run(messageId, "chat-a", "user", "hello", "hello", 0, 1);
  }

  function ftypBytes(brand: string): ArrayBuffer {
    const bytes = new Uint8Array(16);
    bytes[3] = 16;
    bytes.set([0x66, 0x74, 0x79, 0x70], 4);
    const padded = brand.padEnd(4, " ").slice(0, 4);
    for (let index = 0; index < 4; index++) bytes[8 + index] = padded.charCodeAt(index);
    const copy = new ArrayBuffer(bytes.byteLength);
    new Uint8Array(copy).set(bytes);
    return copy;
  }

  it("classifies ftyp brands instead of treating every iso file as mp4", async () => {
    seedAttachmentMessage("msg-avif");
    const avif = await processUpload(
      "chat-a",
      "msg-avif",
      "photo.avif",
      "application/octet-stream",
      ftypBytes("avif"),
    );
    expect(avif.mimeType).toBe("image/avif");

    seedAttachmentMessage("msg-m4a");
    const audio = await processUpload(
      "chat-a",
      "msg-m4a",
      "song.m4a",
      "application/octet-stream",
      ftypBytes("M4A "),
    );
    expect(audio.mimeType).toBe("audio/mp4");

    seedAttachmentMessage("msg-mp4");
    const video = await processUpload(
      "chat-a",
      "msg-mp4",
      "clip.mp4",
      "application/octet-stream",
      ftypBytes("mp42"),
    );
    expect(video.mimeType).toBe("video/mp4");
  });

  it("does not decode binary uploads as text", async () => {
    seedAttachmentMessage("msg-zip");
    const zip = new Uint8Array([0x50, 0x4b, 0x03, 0x04, 0x00, 0x01]);
    const attachment = await processUpload(
      "chat-a",
      "msg-zip",
      "archive.zip",
      "text/plain",
      zip.buffer,
    );
    expect(attachment.mimeType).toBe("application/octet-stream");
    expect(attachment.extractedText).toBeUndefined();
  });

  it("marks extracted text that exceeds the attachment budget", async () => {
    seedAttachmentMessage("msg-long");
    const attachment = await processUpload(
      "chat-a",
      "msg-long",
      "notes.txt",
      "text/plain",
      new TextEncoder().encode("A".repeat(13_000)).buffer,
    );
    expect(attachment.textTruncated).toBe(true);
    expect(attachment.extractedText?.length).toBeLessThanOrEqual(12_000);
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

  it("does not sample stills when native input_video is preferred", async () => {
    __setPreferNativeInputVideo(true);
    __setExtractVideoFrames(async () => {
      throw new Error("video still sampling should be skipped");
    });
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
    expect((res as any[])[0].type).toBe("input_video");
  });

  it("samples video attachments into image_url frames when ffmpeg extraction succeeds", async () => {
    __setPreferNativeInputVideo(false);
    __setExtractVideoFrames(async () => [
      path.join(getAppDataDir(), "attachments", "video-frame-001.jpg"),
    ]);
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
    expect(parts[0].type).toBe("image_url");
    expect(parts[0].image_url.url).toBe("file://attachments/video-frame-001.jpg");
    expect(parts[1].type).toBe("text");
    expect(parts[1].text).toBe("Watch this");
  });

  it("skips piped input_video when frame extraction fails and piping is disabled", async () => {
    __setPreferNativeInputVideo(false);
    __setExtractVideoFrames(async () => []);
    __setAllowPipedVideo(false);
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
    expect(res).toBe("Watch this");
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

  it("does not extract video audio when the global toggle is off", async () => {
    await saveSettings({ includeVideoAudio: false });
    let resolved = 0;
    __setResolveVideoAudioSidecar(async () => {
      resolved += 1;
      return path.join(getAppDataDir(), "attachments", "clip.extracted-audio.wav");
    });
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
    const metadata = { hasVisionEncoder: true, hasAudioEncoder: true } as any;

    const res = await buildContentParts("Watch this", attachments, metadata);
    expect(resolved).toBe(0);
    expect(Array.isArray(res)).toBe(true);
    expect((res as any[]).map((part) => part.type)).toEqual(["input_video", "text"]);
  });

  it("does not extract video audio when the model has no audio encoder", async () => {
    await saveSettings({ includeVideoAudio: true });
    let resolved = 0;
    __setResolveVideoAudioSidecar(async () => {
      resolved += 1;
      return path.join(getAppDataDir(), "attachments", "clip.extracted-audio.wav");
    });
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
    const metadata = { hasVisionEncoder: true, hasAudioEncoder: false } as any;

    const res = await buildContentParts("Watch this", attachments, metadata);
    expect(resolved).toBe(0);
    expect((res as any[]).map((part) => part.type)).toEqual(["input_video", "text"]);
  });

  it("sends extracted video audio as a sibling input_audio part", async () => {
    await saveSettings({ includeVideoAudio: true });
    __setResolveVideoAudioSidecar(async () =>
      path.join(getAppDataDir(), "attachments", "video.extracted-audio.wav"),
    );
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
    const metadata = { hasVisionEncoder: true, hasAudioEncoder: true } as any;

    const res = await buildContentParts("Watch this", attachments, metadata);
    expect(Array.isArray(res)).toBe(true);
    const parts = res as any[];
    expect(parts.map((part) => part.type)).toEqual(["input_audio", "input_video", "text"]);
    expect(parts[0].input_audio.url).toBe("file://attachments/video.extracted-audio.wav");
    expect(parts[1].input_video.url).toBe("file://attachments/video.mp4");
    expect(parts[2].text).toBe("Watch this");
  });

  it("persists a soundtrack attachment once and reuses it on later sends", async () => {
    await saveSettings({ includeVideoAudio: true });
    const db = getDb();
    db.prepare("INSERT INTO chats (id, name, created_at, updated_at) VALUES (?, ?, ?, ?)").run(
      "chat-audio",
      "Audio Chat",
      1,
      1,
    );
    db.prepare(
      "INSERT INTO messages (id, chat_id, role, content, raw_content, position, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
    ).run("msg-audio", "chat-audio", "user", "Watch this", "Watch this", 0, 1);

    let resolved = 0;
    __setResolveVideoAudioSidecar(async () => {
      resolved += 1;
      return path.join(getAppDataDir(), "attachments", "video.extracted-audio.wav");
    });
    const video = {
      id: "vid-1",
      messageId: "msg-audio",
      mimeType: "video/mp4",
      fileName: "video.mp4",
      filePath: "attachments/video.mp4",
      createdAt: 0,
    };
    const metadata = { hasVisionEncoder: true, hasAudioEncoder: true } as any;

    await buildContentParts("Watch this", [video as any], metadata);
    expect(resolved).toBe(1);
    const stored = db
      .query<{ file_path: string; mime_type: string; file_name: string }, [string]>(
        "SELECT file_path, mime_type, file_name FROM attachments WHERE message_id = ?",
      )
      .all("msg-audio");
    expect(stored).toEqual([
      {
        file_path: "attachments/video.extracted-audio.wav",
        mime_type: "audio/wav",
        file_name: "video.extracted-audio.wav",
      },
    ]);

    const soundtrack = {
      id: "aud-1",
      messageId: "msg-audio",
      mimeType: "audio/wav",
      fileName: "video.extracted-audio.wav",
      filePath: "attachments/video.extracted-audio.wav",
      createdAt: 1,
    };
    const second = await buildContentParts(
      "Watch this",
      [video as any, soundtrack as any],
      metadata,
    );
    expect(resolved).toBe(1);
    expect((second as any[]).map((part) => part.type)).toEqual([
      "input_audio",
      "input_video",
      "text",
    ]);
    expect(
      db
        .query<{ count: number }, [string]>(
          "SELECT COUNT(*) as count FROM attachments WHERE message_id = ?",
        )
        .get("msg-audio")?.count,
    ).toBe(1);
  });

  it("sends an already-persisted soundtrack without extracting again", async () => {
    await saveSettings({ includeVideoAudio: true });
    let resolved = 0;
    __setResolveVideoAudioSidecar(async () => {
      resolved += 1;
      return path.join(getAppDataDir(), "attachments", "video.extracted-audio.wav");
    });
    const attachments = [
      {
        id: "1",
        messageId: "2",
        mimeType: "video/mp4",
        fileName: "video.mp4",
        filePath: "attachments/video.mp4",
        createdAt: 0,
      },
      {
        id: "2",
        messageId: "2",
        mimeType: "audio/wav",
        fileName: "video.extracted-audio.wav",
        filePath: "attachments/video.extracted-audio.wav",
        createdAt: 1,
      },
    ] as any;
    const metadata = { hasVisionEncoder: true, hasAudioEncoder: true } as any;

    const res = await buildContentParts("Watch this", attachments, metadata);
    expect(resolved).toBe(0);
    expect((res as any[]).map((part) => part.type)).toEqual(["input_audio", "input_video", "text"]);
  });

  it("does not send a persisted soundtrack when the global toggle is off", async () => {
    await saveSettings({ includeVideoAudio: false });
    let resolved = 0;
    __setResolveVideoAudioSidecar(async () => {
      resolved += 1;
      return path.join(getAppDataDir(), "attachments", "video.extracted-audio.wav");
    });
    const attachments = [
      {
        id: "1",
        messageId: "2",
        mimeType: "video/mp4",
        fileName: "video.mp4",
        filePath: "attachments/video.mp4",
        createdAt: 0,
      },
      {
        id: "2",
        messageId: "2",
        mimeType: "audio/wav",
        fileName: "video.extracted-audio.wav",
        filePath: "attachments/video.extracted-audio.wav",
        createdAt: 1,
      },
    ] as any;
    const metadata = { hasVisionEncoder: true, hasAudioEncoder: true } as any;

    const res = await buildContentParts("Watch this", attachments, metadata);
    expect(resolved).toBe(0);
    expect((res as any[]).map((part) => part.type)).toEqual(["input_video", "text"]);
  });

  it("keeps input_video only when the video has no audio stream", async () => {
    await saveSettings({ includeVideoAudio: true });
    __setResolveVideoAudioSidecar(async () => null);
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
    const metadata = { hasVisionEncoder: true, hasAudioEncoder: true } as any;

    const res = await buildContentParts("Watch this", attachments, metadata);
    expect((res as any[]).map((part) => part.type)).toEqual(["input_video", "text"]);
  });

  it("does not extract video audio when still frames are used instead of input_video", async () => {
    await saveSettings({ includeVideoAudio: true });
    __setPreferNativeInputVideo(false);
    __setExtractVideoFrames(async () => [
      path.join(getAppDataDir(), "attachments", "video-frame-001.jpg"),
    ]);
    let resolved = 0;
    __setResolveVideoAudioSidecar(async () => {
      resolved += 1;
      return path.join(getAppDataDir(), "attachments", "video.extracted-audio.wav");
    });
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
    const metadata = { hasVisionEncoder: true, hasAudioEncoder: true } as any;

    const res = await buildContentParts("Watch this", attachments, metadata);
    expect(resolved).toBe(0);
    expect((res as any[])[0].type).toBe("image_url");
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

  it("does not reuse another video's soundtrack on the same message", async () => {
    await saveSettings({ includeVideoAudio: true });
    const resolved: string[] = [];
    __setResolveVideoAudioSidecar(async (videoAbs: string) => {
      resolved.push(videoAbs);
      return `${videoAbs}.extracted-audio.wav`;
    });
    const attachments = [
      {
        id: "v1",
        messageId: "m1",
        mimeType: "video/mp4",
        fileName: "one.mp4",
        filePath: "attachments/one.mp4",
        createdAt: 0,
      },
      {
        id: "a1",
        messageId: "m1",
        mimeType: "audio/wav",
        fileName: "one.extracted-audio.wav",
        filePath: "attachments/one.extracted-audio.wav",
        createdAt: 1,
      },
      {
        id: "v2",
        messageId: "m1",
        mimeType: "video/mp4",
        fileName: "two.mp4",
        filePath: "attachments/two.mp4",
        createdAt: 2,
      },
    ] as any;

    const parts = (await buildContentParts("two clips", attachments, {
      hasVisionEncoder: true,
      hasAudioEncoder: true,
    } as any)) as any[];

    expect(resolved.some((videoAbs) => videoAbs.replaceAll("\\", "/").endsWith("two.mp4"))).toBe(
      true,
    );
    expect(parts.filter((part) => part.type === "input_video")).toHaveLength(2);
    expect(parts.filter((part) => part.type === "input_audio")).toHaveLength(2);
    expect(parts.map((part) => part.type)).toEqual([
      "input_audio",
      "input_audio",
      "input_video",
      "input_video",
      "text",
    ]);
    expect(parts[0].input_audio.url).toContain("one.extracted-audio.wav");
    expect(parts[1].input_audio.url).toContain("two.mp4.extracted-audio.wav");
  });

  it("puts autoextracted audio before earlier images and a manual audio clip", async () => {
    await saveSettings({ includeVideoAudio: true });
    __setResolveVideoAudioSidecar(async () =>
      path.join(getAppDataDir(), "attachments", "video.extracted-audio.wav"),
    );
    const attachments = [
      {
        id: "voice",
        messageId: "2",
        mimeType: "audio/wav",
        fileName: "voice.wav",
        filePath: "attachments/voice.wav",
        createdAt: 0,
      },
      {
        id: "pic",
        messageId: "2",
        mimeType: "image/jpeg",
        fileName: "pic.jpg",
        filePath: "attachments/pic.jpg",
        createdAt: 1,
      },
      {
        id: "vid",
        messageId: "2",
        mimeType: "video/mp4",
        fileName: "video.mp4",
        filePath: "attachments/video.mp4",
        createdAt: 2,
      },
    ] as any;
    const metadata = { hasVisionEncoder: true, hasAudioEncoder: true } as any;

    const parts = (await buildContentParts("what is this", attachments, metadata)) as any[];
    expect(parts.map((part) => part.type)).toEqual([
      "input_audio",
      "input_audio",
      "image_url",
      "input_video",
      "text",
    ]);
    expect(parts[0].input_audio.url).toBe("file://attachments/video.extracted-audio.wav");
    expect(parts[1].input_audio.url).toBe("file://attachments/voice.wav");
    expect(parts[2].image_url.url).toBe("file://attachments/pic.jpg");
    expect(parts[3].input_video.url).toBe("file://attachments/video.mp4");
  });

  afterAll(() => {
    fileSpy.mockRestore();
  });
});
