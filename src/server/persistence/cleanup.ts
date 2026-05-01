/**
 * @packageDocumentation
 * Cleanup utility for purging orphaned attachment files from disk.
 */

import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { logError, logInfo } from "../logger";
import { getActiveGenerationChatIds } from "../streamProxy";
import { getDb } from "./db";

/**
 * Scans the attachments directory and deletes any files that are not referenced in the SQLite database.
 * Also removes empty chat-specific attachment directories.
 *
 * @returns A promise that resolves when the scan and cleanup are complete.
 * @example
 * ```typescript
 * await cleanupOrphanedAttachments();
 * ```
 */
export async function cleanupOrphanedAttachments() {
  const rootDir = path.join(os.homedir(), ".llamaforge", "attachments");
  const db = getDb();

  try {
    const chatDirs = await fs.readdir(rootDir, { withFileTypes: true });

    // Get all files referenced in the DB
    const referencedFiles = db
      .query<{ file_path: string }, []>("SELECT file_path FROM attachments")
      .all()
      .map((r) => r.file_path);

    const referencedSet = new Set(referencedFiles);

    // M7 fix: skip cleanup for chats with active generations to prevent race conditions
    const activeChatIds = getActiveGenerationChatIds();
    await Promise.all(
      chatDirs.map(async (chatDir) => {
        if (!chatDir.isDirectory()) return;
        // M7 fix: skip chats with active generations
        if (activeChatIds.has(chatDir.name)) return;
        const chatDirPath = path.join(rootDir, chatDir.name);

        const messageDirs = await fs.readdir(chatDirPath, { withFileTypes: true }).catch(() => []);
        await Promise.all(
          messageDirs.map(async (msgDir) => {
            if (!msgDir.isDirectory()) return;
            const msgDirPath = path.join(chatDirPath, msgDir.name);

            const files = await fs.readdir(msgDirPath, { withFileTypes: true }).catch(() => []);
            await Promise.all(
              files.map(async (file) => {
                if (!file.isFile()) return;

                const relPath = ["attachments", chatDir.name, msgDir.name, file.name].join("/");
                if (!referencedSet.has(relPath)) {
                  logInfo(`Cleaning up orphaned attachment: ${relPath}`);
                  await fs
                    .unlink(path.join(msgDirPath, file.name))
                    .catch((e) => logError(`Failed to unlink orphaned file ${relPath}:`, e));
                }
              }),
            );

            // Clean up empty message directory
            const remainingInMsg = await fs.readdir(msgDirPath).catch(() => []);
            if (remainingInMsg.length === 0) {
              await fs
                .rmdir(msgDirPath)
                .catch((e) => logError(`Failed to rmdir ${msgDirPath}:`, e));
            }
          }),
        );

        // If chat directory is now empty, remove it
        const remainingInChat = await fs.readdir(chatDirPath).catch(() => []);
        if (remainingInChat.length === 0) {
          await fs.rmdir(chatDirPath).catch((e) => logError(`Failed to rmdir ${chatDirPath}:`, e));
        }
      }),
    );
  } catch (err: unknown) {
    if (err instanceof Error && "code" in err && err.code === "ENOENT") {
      // Expected if attachments dir doesn't exist yet
      return;
    }
    logError("Cleanup orphaned attachments failed:", err);
  }
}
