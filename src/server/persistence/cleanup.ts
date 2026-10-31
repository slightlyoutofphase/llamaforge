/**
 * @packageDocumentation
 * Cleanup utility for purging orphaned attachment files from disk.
 */

import fs from "node:fs/promises";
import path from "node:path";
import { logError, logInfo } from "../logger";
import { getActiveGenerationChatIds } from "../streamProxy";
import { videoAudioSidecarOwnerStem } from "../videoAudio";
import { getAppDataDir, getDb } from "./db";

/**
 * Whether a disk file is a video soundtrack cache that still belongs to a
 * referenced video attachment, even if the sidecar has no `attachments` row.
 *
 * @param relPath - Path relative to the app data root, using `/` separators.
 * @param referencedSet - `file_path` values currently stored in `attachments`.
 * @returns `true` when the file must not be deleted as an orphan.
 */
/**
 * Indexes referenced file stems by their directory prefix.
 *
 * @param referencedSet - `file_path` values currently stored in `attachments`.
 * @returns Directory prefix to the set of file stems in that directory.
 */
export function buildReferencedStemIndex(
  referencedSet: ReadonlySet<string>,
): Map<string, Set<string>> {
  const index = new Map<string, Set<string>>();
  for (const referenced of referencedSet) {
    const parts = referenced.split("/");
    const fileName = parts.at(-1);
    if (!fileName || parts.length < 2) continue;
    const dirPrefix = `${parts.slice(0, -1).join("/")}/`;
    const dot = fileName.lastIndexOf(".");
    const stem = dot > 0 ? fileName.slice(0, dot) : fileName;
    const stems = index.get(dirPrefix) ?? new Set<string>();
    stems.add(stem);
    index.set(dirPrefix, stems);
  }
  return index;
}

/**
 * Whether a disk file is a video soundtrack cache that still belongs to a referenced video.
 *
 * @param relPath - Path relative to the app data root, using `/` separators.
 * @param referencedSet - `file_path` values currently stored in `attachments`.
 * @param stemIndex - Directory-to-stem index built once per cleanup pass.
 * @returns `true` when the file must not be deleted as an orphan.
 */
export function isProtectedVideoAudioSidecar(
  relPath: string,
  referencedSet: ReadonlySet<string>,
  stemIndex?: ReadonlyMap<string, ReadonlySet<string>>,
): boolean {
  const parts = relPath.split("/");
  const fileName = parts.at(-1);
  if (!fileName) return false;
  const stem = videoAudioSidecarOwnerStem(fileName);
  if (!stem) return false;
  const dirPrefix = `${parts.slice(0, -1).join("/")}/`;
  const index = stemIndex ?? buildReferencedStemIndex(referencedSet);
  return index.get(dirPrefix)?.has(stem) ?? false;
}

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
  const rootDir = path.join(getAppDataDir(), "attachments");
  const db = getDb();

  try {
    const chatDirs = await fs.readdir(rootDir, { withFileTypes: true });

    // Get all files referenced in the DB
    const referencedFiles = db
      .query<{ file_path: string }, []>("SELECT file_path FROM attachments")
      .all()
      .map((r) => r.file_path);

    const referencedSet = new Set(referencedFiles);
    const stemIndex = buildReferencedStemIndex(referencedSet);

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
                if (
                  !referencedSet.has(relPath) &&
                  !isProtectedVideoAudioSidecar(relPath, referencedSet, stemIndex)
                ) {
                  logInfo(`Cleaning up orphaned attachment: ${relPath}`);
                  await Bun.file(path.join(msgDirPath, file.name))
                    .delete()
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
