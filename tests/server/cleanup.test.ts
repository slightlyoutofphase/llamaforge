/**
 * @packageDocumentation
 * Tests for cleanup operations on orphaned attachments.
 */

import { afterEach, beforeEach, describe, expect, it, mock, spyOn } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { cleanupOrphanedAttachments } from "../../src/server/persistence/cleanup";
import * as dbModule from "../../src/server/persistence/db";
import { getDb, initDb, resetDb } from "../../src/server/persistence/db";

describe("cleanupOrphanedAttachments", () => {
  let tmpDir: string;
  let rootDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "llamaforge-test-"));
    rootDir = path.join(tmpDir, "attachments");
    spyOn(dbModule, "getAppDataDir").mockReturnValue(tmpDir);

    await initDb(":memory:");
    await fs.mkdir(rootDir, { recursive: true });
  });

  afterEach(async () => {
    resetDb();
    mock.restore();
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it("removes unreferenced files and empty directories", async () => {
    const db = getDb();
    const chatDir = path.join(rootDir, "test-chat");
    const msgDir = path.join(chatDir, "msg-1");
    await fs.mkdir(msgDir, { recursive: true });

    const refPath = "attachments/test-chat/msg-1/referenced.txt";
    const orphanPath = "attachments/test-chat/msg-1/orphaned.txt";

    await Bun.write(path.join(tmpDir, refPath), "ok");
    await Bun.write(path.join(tmpDir, orphanPath), "delete me");

    // Only one file is referenced in DB
    db.prepare("INSERT INTO chats (id, name, created_at, updated_at) VALUES (?, ?, ?, ?)").run(
      "test-chat",
      "Test",
      Date.now(),
      Date.now(),
    );
    db.prepare(
      "INSERT INTO messages (id, chat_id, role, content, raw_content, position, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
    ).run("msg-1", "test-chat", "user", "hi", "hi", 0, Date.now());
    db.prepare(
      "INSERT INTO attachments (id, message_id, mime_type, file_path, file_name, created_at) VALUES (?, ?, ?, ?, ?, ?)",
    ).run("att-1", "msg-1", "text/plain", refPath, "referenced.txt", Date.now());

    await cleanupOrphanedAttachments();

    // Check if msgDir still exists before readdir
    const exists = await fs
      .access(msgDir)
      .then(() => true)
      .catch(() => false);
    expect(exists).toBe(true);

    const files = await fs.readdir(msgDir);
    expect(files).toContain("referenced.txt");
    expect(files).not.toContain("orphaned.txt");
  });

  it("keeps extracted video audio sidecars when the parent video is still referenced", async () => {
    const db = getDb();
    const chatDir = path.join(rootDir, "video-chat");
    const msgDir = path.join(chatDir, "msg-v");
    await fs.mkdir(msgDir, { recursive: true });

    const videoRel = "attachments/video-chat/msg-v/clip.mp4";
    const wavRel = "attachments/video-chat/msg-v/clip.extracted-audio.wav";
    const markerRel = "attachments/video-chat/msg-v/clip.no-audio";
    const strayWavRel = "attachments/video-chat/msg-v/other.extracted-audio.wav";

    await Bun.write(path.join(tmpDir, videoRel), "video");
    await Bun.write(path.join(tmpDir, wavRel), "wav");
    await Bun.write(path.join(tmpDir, markerRel), "");
    await Bun.write(path.join(tmpDir, strayWavRel), "stray");

    db.prepare("INSERT INTO chats (id, name, created_at, updated_at) VALUES (?, ?, ?, ?)").run(
      "video-chat",
      "Video",
      Date.now(),
      Date.now(),
    );
    db.prepare(
      "INSERT INTO messages (id, chat_id, role, content, raw_content, position, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
    ).run("msg-v", "video-chat", "user", "watch", "watch", 0, Date.now());
    db.prepare(
      "INSERT INTO attachments (id, message_id, mime_type, file_path, file_name, created_at) VALUES (?, ?, ?, ?, ?, ?)",
    ).run("att-v", "msg-v", "video/mp4", videoRel, "clip.mp4", Date.now());

    await cleanupOrphanedAttachments();

    const files = await fs.readdir(msgDir);
    expect(files).toContain("clip.mp4");
    expect(files).toContain("clip.extracted-audio.wav");
    expect(files).toContain("clip.no-audio");
    expect(files).not.toContain("other.extracted-audio.wav");
  });

  it("removes empty chat directories", async () => {
    const chatDir = path.join(rootDir, "empty-chat");
    await fs.mkdir(chatDir, { recursive: true });

    await cleanupOrphanedAttachments();

    await expect(fs.access(chatDir)).rejects.toThrow();
  });
});
