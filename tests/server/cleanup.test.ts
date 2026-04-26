/**
 * @packageDocumentation
 * Tests for cleanup operations on orphaned attachments.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { cleanupOrphanedAttachments } from "../../src/server/persistence/cleanup";
import { getDb, initDb, resetDb } from "../../src/server/persistence/db";

describe("cleanupOrphanedAttachments", () => {
  const rootDir = path.join(os.homedir(), ".llamaforge", "attachments");

  beforeEach(async () => {
    await initDb(":memory:");
    await fs.mkdir(rootDir, { recursive: true });
  });

  afterEach(async () => {
    resetDb();
    await fs.rm(path.join(os.homedir(), ".llamaforge"), { recursive: true, force: true });
  });

  it("removes unreferenced files and empty directories", async () => {
    const db = getDb();
    const chatDir = path.join(rootDir, "test-chat");
    const msgDir = path.join(chatDir, "msg-1");
    await fs.mkdir(msgDir, { recursive: true });

    const refPath = "attachments/test-chat/msg-1/referenced.txt";
    const orphanPath = "attachments/test-chat/msg-1/orphaned.txt";

    await fs.writeFile(path.join(os.homedir(), ".llamaforge", refPath), "ok");
    await fs.writeFile(path.join(os.homedir(), ".llamaforge", orphanPath), "delete me");

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

  it("removes empty chat directories", async () => {
    const chatDir = path.join(rootDir, "empty-chat");
    await fs.mkdir(chatDir, { recursive: true });

    await cleanupOrphanedAttachments();

    await expect(fs.access(chatDir)).rejects.toThrow();
  });
});
