/**
 * @packageDocumentation
 * Chat repository — CRUD operations for chat sessions and messages.
 */

import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { ChatMessage, ChatSession, GgufDisplayMetadata } from "@shared/types.js";
import { logError, logWarn } from "../logger";
import { getDb } from "./db";

const APP_ROOT = path.join(os.homedir(), ".llamaforge");

/**
 * S6 fix: Computes the next message position for a chat using MAX(position) + 1.
 * Prevents position gaps and collisions after deletions or branching.
 */
export function getNextPosition(chatId: string): number {
  const db = getDb();
  const row = db
    .query<
      { max_pos: number | null },
      [string]
    >("SELECT MAX(position) as max_pos FROM messages WHERE chat_id = ?")
    .get(chatId);
  return (row?.max_pos ?? -1) + 1;
}

function resolveAttachmentPath(relativePath: string): string | null {
  if (!relativePath || typeof relativePath !== "string") return null;
  if (path.isAbsolute(relativePath)) return null;
  const normalized = path.normalize(relativePath);
  if (normalized.startsWith(`..${path.sep}`) || normalized === "..") return null;

  const absPath = path.join(APP_ROOT, normalized);
  const relative = path.relative(APP_ROOT, absPath);
  if (relative.startsWith("..") || path.isAbsolute(relative)) return null;
  return absPath;
}

function sanitizeFileName(fileName: string): string {
  const base = path.basename(fileName || "");
  return base.replace(/[^a-zA-Z0-9._-]/g, "_");
}

function isValidMessageRole(value: unknown): value is "system" | "user" | "assistant" | "tool" {
  return value === "system" || value === "user" || value === "assistant" || value === "tool";
}

function assertImportPayload(parsed: any) {
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    logError("[chatRepo] Invalid imported chat payload: not an object", { parsed });
    throw new Error("Imported chat must be a JSON object.");
  }
  if (!Array.isArray(parsed.messages)) {
    logError("[chatRepo] Invalid imported chat payload: missing messages array", { parsed });
    throw new Error("Imported chat must include a messages array.");
  }

  for (const [index, msg] of parsed.messages.entries()) {
    if (!msg || typeof msg !== "object") {
      throw new Error(`Message at index ${index} is invalid.`);
    }
    if (!isValidMessageRole(msg.role)) {
      throw new Error(`Message at index ${index} has invalid role.`);
    }
    if (typeof msg.content !== "string") {
      throw new Error(`Message at index ${index} requires a content string.`);
    }
    if (msg.attachments !== undefined) {
      if (!Array.isArray(msg.attachments)) {
        throw new Error(`Attachments for message at index ${index} must be an array.`);
      }
      for (const [attIndex, att] of msg.attachments.entries()) {
        if (!att || typeof att !== "object") {
          logError("[chatRepo] Invalid attachment object in imported chat", {
            messageIndex: index,
            attachmentIndex: attIndex,
            att,
          });
          throw new Error(`Attachment at index ${attIndex} for message ${index} is invalid.`);
        }
        if (typeof att.fileName !== "string" || att.fileName.length === 0) {
          logError("[chatRepo] Imported attachment missing fileName", {
            messageIndex: index,
            attachmentIndex: attIndex,
            att,
          });
          throw new Error(
            `Attachment at index ${attIndex} for message ${index} requires a valid fileName.`,
          );
        }
        if (typeof att.mimeType !== "string" || att.mimeType.length === 0) {
          throw new Error(
            `Attachment at index ${attIndex} for message ${index} requires a valid mimeType.`,
          );
        }
        if (typeof att.base64Data !== "string" || att.base64Data.length === 0) {
          throw new Error(
            `Attachment at index ${attIndex} for message ${index} requires base64Data.`,
          );
        }
      }
    }
  }
}

/**
 * Creates a new chat session with default metadata.
 *
 * @param name - Initial display name for the chat. Defaults to `"New Chat"`.
 * @param modelPath - Absolute path to the model that will be used for this chat. (Optional)
 * @returns A promise that resolves to the newly created {@link ChatSession} object.
 * @throws {DatabaseError} If the database operation fails.
 */
export async function createChat(
  name: string = "New Chat",
  modelPath?: string,
): Promise<ChatSession> {
  const db = getDb();
  const id = Bun.randomUUIDv7();
  const now = Date.now();
  const stmt = db.prepare(
    "INSERT INTO chats (id, name, created_at, updated_at, model_path) VALUES (?, ?, ?, ?, ?)",
  );
  stmt.run(id, name, now, now, modelPath || null);

  return {
    id,
    name,
    createdAt: now,
    updatedAt: now,
    isBranch: false,
    modelPath,
  };
}

/**
 * Retrieves a list of chat sessions, optionally filtered by name.
 *
 * @param search - Optional query string to filter chats by name (case-insensitive search).
 * @returns A promise that resolves to an array of {@link ChatSession} basic metadata.
 */
export async function getChats(
  search?: string,
  limit: number = 150,
  offset: number = 0,
): Promise<ChatSession[]> {
  const db = getDb();
  let query =
    "SELECT id, name, created_at as createdAt, updated_at as updatedAt, parent_id as parentId, is_branch as isBranch, model_path as modelPath, system_preset_id as systemPresetId, inference_preset_id as inferencePresetId FROM chats";
  const params: (string | number)[] = [];

  if (search) {
    query += " WHERE name LIKE ?";
    params.push(`%${search}%`);
  }

  query += " ORDER BY updated_at DESC LIMIT ? OFFSET ?";
  params.push(limit, offset);

  const stmt = db.query<ChatSession, (string | number)[]>(query);
  const rows = stmt.all(...params);
  return rows.map(
    (r) =>
      ({
        ...r,
        isBranch: Boolean(r.isBranch),
      }) as ChatSession,
  );
}

/**
 * Retrieves a single chat session including its full message history and attachments.
 *
 * @param id - The unique UUID of the chat session.
 * @returns A promise that resolves to the {@link ChatSession} or null if not found.
 */
export async function getChat(
  id: string,
  messageLimit?: number,
  messageOffset?: number,
): Promise<ChatSession | null> {
  const db = getDb();
  const stmt = db.query<ChatSession, [string]>(
    "SELECT id, name, created_at as createdAt, updated_at as updatedAt, parent_id as parentId, is_branch as isBranch, model_path as modelPath, system_preset_id as systemPresetId, inference_preset_id as inferencePresetId FROM chats WHERE id = ?",
  );
  const chatRow = stmt.get(id);

  if (!chatRow) return null;

  const chat = {
    ...chatRow,
    isBranch: Boolean(chatRow.isBranch),
  } as ChatSession;

  // M10 fix: support optional pagination to avoid loading 10,000+ messages in a single response.
  // When messageLimit is provided, load only the last N messages (for the HTTP API).
  // When omitted, load all messages (for internal callers like streamProxy).
  if (messageLimit !== undefined && messageLimit > 0) {
    const offset = messageOffset ?? 0;
    // Count total first so the client knows if there are more
    const countRow = db
      .query<{ cnt: number }, [string]>("SELECT COUNT(*) as cnt FROM messages WHERE chat_id = ?")
      .get(id);
    const totalMessages = countRow?.cnt ?? 0;
    (chat as any).totalMessages = totalMessages;

    // Load paginated slice (most recent messages first, then reverse for display order)
    const msgStmt = db.query<ChatMessage, [string, number, number]>(
      "SELECT id, chat_id as chatId, role, content, raw_content as rawContent, thinking_content as thinkingContent, position, created_at as createdAt, tool_call_id as toolCallId, tool_calls_json as toolCallsJson FROM messages WHERE chat_id = ? ORDER BY position DESC LIMIT ? OFFSET ?",
    );
    chat.messages = msgStmt.all(id, messageLimit, offset).reverse();
  } else {
    const msgStmt = db.query<ChatMessage, [string]>(
      "SELECT id, chat_id as chatId, role, content, raw_content as rawContent, thinking_content as thinkingContent, position, created_at as createdAt, tool_call_id as toolCallId, tool_calls_json as toolCallsJson FROM messages WHERE chat_id = ? ORDER BY position ASC",
    );
    chat.messages = msgStmt.all(id);
  }

  if (chat.messages.length > 0) {
    const messageIds = chat.messages.map((m) => m.id);
    const placeholders = messageIds.map(() => "?").join(",");
    const attStmt = db.query<
      {
        id: string;
        messageId: string;
        mimeType: string;
        filePath: string;
        fileName: string;
        virBudget: number | null;
        createdAt: number;
      },
      string[]
    >(
      `SELECT id, message_id as messageId, mime_type as mimeType, file_path as filePath, file_name as fileName, vir_budget as virBudget, created_at as createdAt FROM attachments WHERE message_id IN (${placeholders})`,
    );
    const allAttachments = attStmt.all(...messageIds);
    const attMap = new Map<string, any[]>();
    for (const att of allAttachments) {
      const arr = attMap.get(att.messageId) || [];
      arr.push({ ...att, virBudget: att.virBudget ?? undefined });
      attMap.set(att.messageId, arr);
    }
    for (const msg of chat.messages) {
      msg.attachments = attMap.get(msg.id) || [];
    }
  }

  return chat;
}

/**
 * M10 fix: Returns the total message count for a chat without loading them all.
 * Used by the frontend to display "load more" UI.
 *
 * @param chatId - The unique UUID of the chat session.
 * @returns The total number of messages in the chat.
 */
export function getChatMessageCount(chatId: string): number {
  const db = getDb();
  const row = db
    .query<{ cnt: number }, [string]>("SELECT COUNT(*) as cnt FROM messages WHERE chat_id = ?")
    .get(chatId);
  return row?.cnt ?? 0;
}

/**
 * Updates metadata for an existing chat session.
 *
 * @param id - The unique UUID of the chat session.
 * @param updates - Partial object containing fields to update.
 * @returns A promise that resolves when the update is complete.
 */
export async function updateChat(id: string, updates: Partial<ChatSession>): Promise<void> {
  const db = getDb();
  const setStatements: string[] = [];
  const values: (string | number)[] = [];

  if (updates.name !== undefined) {
    setStatements.push("name = ?");
    values.push(updates.name);
  }
  if (updates.modelPath !== undefined) {
    setStatements.push("model_path = ?");
    values.push(updates.modelPath);
  }
  if (updates.systemPresetId !== undefined) {
    setStatements.push("system_preset_id = ?");
    values.push(updates.systemPresetId);
  }
  if (updates.inferencePresetId !== undefined) {
    setStatements.push("inference_preset_id = ?");
    values.push(updates.inferencePresetId);
  }

  setStatements.push("updated_at = ?");
  values.push(Date.now());

  values.push(id);

  const query = `UPDATE chats SET ${setStatements.join(", ")} WHERE id = ?`;
  db.prepare(query).run(...values);
}

/**
 * Deletes a chat session and all its associated messages and attachments.
 *
 * @param id - The unique UUID of the chat session to delete.
 */
export async function deleteChat(id: string): Promise<void> {
  const db = getDb();

  const attachRows = db
    .query<{ file_path: string }, [string]>(
      `
    SELECT a.file_path 
    FROM attachments a
    JOIN messages m ON a.message_id = m.id
    WHERE m.chat_id = ?
  `,
    )
    .all(id);

  db.prepare("DELETE FROM chats WHERE id = ?").run(id);

  // M11 fix: evict prompt cache stats for the deleted chat
  try {
    const { evictPromptCacheStats } = await import("../promptCache");
    evictPromptCacheStats(id);
  } catch {
    // Non-critical — stats eviction failure shouldn't block chat deletion
  }

  for (const row of attachRows) {
    try {
      const fullPath = resolveAttachmentPath(row.file_path);
      if (fullPath) await fs.unlink(fullPath);
    } catch (e) {
      // S13 fix: log file deletion failures for debugging
      logWarn("[chatRepo] Failed to delete attachment file during chat cleanup", {
        chatId: id,
        filePath: row.file_path,
        error: e instanceof Error ? e.message : String(e),
      });
    }
  }

  // Also clean out the chat directory cleanly
  try {
    const chatDir = path.join(os.homedir(), ".llamaforge", "attachments", id);
    await fs.rm(chatDir, { recursive: true, force: true });
  } catch (e) {
    // S13 fix: log directory cleanup failures
    logWarn("[chatRepo] Failed to remove chat attachments directory", {
      chatId: id,
      error: e instanceof Error ? e.message : String(e),
    });
  }
}

/**
 * Appends a new message to a chat session.
 *
 * @param message - The {@link ChatMessage} object to persist.
 */
export async function addMessage(message: ChatMessage): Promise<void> {
  const db = getDb();
  const stmt = db.prepare(`
    INSERT INTO messages (id, chat_id, role, content, raw_content, thinking_content, position, created_at, tool_call_id, tool_calls_json)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  stmt.run(
    message.id,
    message.chatId,
    message.role,
    message.content,
    message.rawContent,
    message.thinkingContent || null,
    message.position,
    message.createdAt,
    message.toolCallId || null,
    message.toolCallsJson || null,
  );

  db.prepare("UPDATE chats SET updated_at = ? WHERE id = ?").run(Date.now(), message.chatId);
}

/**
 * Updates an individual message's textual content.
 *
 * @param id - UUID of the message.
 * @param content - Parsed content (with thinking tags removed if applicable).
 * @param rawContent - Original raw output from the model.
 * @param thinkingContent - Optional extracted thinking trace content.
 */
export async function updateMessage(
  id: string,
  content: string,
  rawContent: string,
  thinkingContent?: string,
): Promise<void> {
  const db = getDb();
  db.prepare(
    "UPDATE messages SET content = ?, raw_content = ?, thinking_content = ? WHERE id = ?",
  ).run(content, rawContent, thinkingContent || null, id);
  db.prepare(
    "UPDATE chats SET updated_at = ? WHERE id = (SELECT chat_id FROM messages WHERE id = ?)",
  ).run(Date.now(), id);
}

/**
 * Deletes all messages in a chat that appear after a specific position.
 *
 * @param chatId - UUID of the chat session.
 * @param position - The position index. Messages with position > this value will be removed.
 */
export async function deleteMessagesAfter(chatId: string, position: number): Promise<void> {
  const db = getDb();

  const attachRows = db
    .query<{ file_path: string }, [string, number]>(
      `
    SELECT a.file_path 
    FROM attachments a
    JOIN messages m ON a.message_id = m.id
    WHERE m.chat_id = ? AND m.position > ?
  `,
    )
    .all(chatId, position);

  db.prepare("DELETE FROM messages WHERE chat_id = ? AND position > ?").run(chatId, position);

  for (const row of attachRows) {
    try {
      const fullPath = resolveAttachmentPath(row.file_path);
      if (fullPath) await fs.unlink(fullPath);
    } catch {}
  }
}

/**
 * Deletes a specific message and all subsequent messages in that chat.
 *
 * @param chatId - UUID of the chat session.
 * @param messageId - UUID of the message to delete.
 */
export async function deleteMessageAndSubsequent(chatId: string, messageId: string): Promise<void> {
  const db = getDb();
  const row = db
    .query<
      { position: number },
      [string, string]
    >("SELECT position FROM messages WHERE id = ? AND chat_id = ?")
    .get(messageId, chatId);
  if (row) {
    const attachRows = db
      .query<{ file_path: string }, [string, number]>(
        `
      SELECT a.file_path 
      FROM attachments a
      JOIN messages m ON a.message_id = m.id
      WHERE m.chat_id = ? AND m.position >= ?
    `,
      )
      .all(chatId, row.position);

    db.prepare("DELETE FROM messages WHERE chat_id = ? AND position >= ?").run(
      chatId,
      row.position,
    );

    for (const attach of attachRows) {
      try {
        const fullPath = resolveAttachmentPath(attach.file_path);
        if (fullPath) await fs.unlink(fullPath);
      } catch {}
    }
  }
}

/**
 * Retrieves cached GGUF metadata for a specific file version.
 *
 * @param filePath - Absolute path to the .gguf file.
 * @param mtime - Last modified timestamp of the file.
 * @returns The cached metadata or null if not found.
 */
export async function cachedGgufMetadata(
  filePath: string,
  mtime: number,
): Promise<GgufDisplayMetadata | null> {
  const row = getDb()
    .query<
      { metadata_json: string },
      [string, number]
    >("SELECT metadata_json FROM model_cache WHERE file_path = ? AND mtime = ?")
    .get(filePath, mtime);
  return row ? JSON.parse(row.metadata_json) : null;
}

/**
 * Looks for cached display metadata for a specific model path.
 *
 * @param filePath - The full absolute path to the local GGUF file.
 * @returns A promise resolving to the metadata config or null if not found.
 */
export async function getMetadataForPath(filePath: string): Promise<GgufDisplayMetadata | null> {
  const row = getDb()
    .query<
      { metadata_json: string },
      [string]
    >("SELECT metadata_json FROM model_cache WHERE file_path = ? ORDER BY mtime DESC LIMIT 1")
    .get(filePath);
  return row ? JSON.parse(row.metadata_json) : null;
}

/**
 * Persist cached display metadata for a specific model path to avoid re-parsing massive binaries.
 *
 * @param filePath - The full absolute path to the local GGUF file.
 * @param mtime - The current modified time of the GGUF file (to invalidate cache appropriately).
 * @param metadata - The loaded and processed metadata variables mapping to standard properties.
 */
export async function setCachedGgufMetadata(
  filePath: string,
  mtime: number,
  metadata: GgufDisplayMetadata,
): Promise<void> {
  getDb()
    .prepare(
      "INSERT OR REPLACE INTO model_cache (file_path, mtime, metadata_json) VALUES (?, ?, ?)",
    )
    .run(filePath, mtime, JSON.stringify(metadata));
}

/**
 * Creates a new chat branch starting from a specific message.
 *
 * @param chatId - The original chat ID.
 * @param messageId - The message ID to serve as the branch point (inclusive).
 * @returns The ID of the newly created branch chat.
 */
export async function createBranch(chatId: string, messageId: string): Promise<string> {
  const db = getDb();
  const chat = await getChat(chatId);
  if (!chat?.messages) throw new Error("Chat not found");

  const msgIndex = chat.messages.findIndex((m) => m.id === messageId);
  if (msgIndex === -1) throw new Error("Message not found in chat");

  const messagesToCopy = chat.messages.slice(0, msgIndex + 1);

  const newChatId = Bun.randomUUIDv7();
  const now = Date.now();

  const insertChat = db.prepare(
    "INSERT INTO chats (id, name, created_at, updated_at, parent_id, is_branch, model_path, system_preset_id, inference_preset_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
  );

  const insertMsg = db.prepare(
    `INSERT INTO messages (id, chat_id, role, content, raw_content, thinking_content, position, created_at, tool_call_id, tool_calls_json)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );

  const insertAttachment = db.prepare(
    "INSERT INTO attachments (id, message_id, mime_type, file_path, file_name, vir_budget, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
  );

  // Files to copy after transaction
  const fileOperations: { oldPath: string; newPath: string }[] = [];

  const runTransaction = db.transaction(() => {
    insertChat.run(
      newChatId,
      `Branch: ${chat.name}`,
      now,
      now,
      chatId,
      1,
      chat.modelPath || null,
      chat.systemPresetId || null,
      chat.inferencePresetId || null,
    );

    for (const msg of messagesToCopy) {
      const newMsgId = Bun.randomUUIDv7();
      insertMsg.run(
        newMsgId,
        newChatId,
        msg.role,
        msg.content,
        msg.rawContent,
        msg.thinkingContent || null,
        msg.position,
        msg.createdAt,
        msg.toolCallId || null,
        msg.toolCallsJson || null,
      );

      // We read attachments from the existing array in `getChat` since it's already there!
      // But we need to use a slightly different loop structure since `chat.messages` has them.
      const attachments = msg.attachments || [];

      for (const att of attachments) {
        const ext = path.extname(sanitizeFileName(att.fileName)) || "";
        const safeName = Bun.randomUUIDv7() + ext;
        const newAppDir = path.join(APP_ROOT, "attachments", newChatId, newMsgId);
        const newFilePath = path.join(newAppDir, safeName);
        const oldFilePath = resolveAttachmentPath(att.filePath);
        if (!oldFilePath) {
          logError("[chatRepo] Invalid attachment path for branch copy", {
            chatId,
            messageId: msg.id,
            attachmentPath: att.filePath,
          });
          throw new Error(`Invalid attachment path for branch copy: ${att.filePath}`);
        }
        fileOperations.push({ oldPath: oldFilePath, newPath: newFilePath });

        const relPath = path.relative(APP_ROOT, newFilePath).split(path.sep).join("/");

        insertAttachment.run(
          Bun.randomUUIDv7(),
          newMsgId,
          att.mimeType,
          relPath,
          att.fileName,
          att.virBudget || null,
          att.createdAt,
        );
      }
    }
  });

  runTransaction();

  try {
    for (const op of fileOperations) {
      await fs.mkdir(path.dirname(op.newPath), { recursive: true });
      try {
        await fs.link(op.oldPath, op.newPath);
      } catch (_e) {
        await fs.copyFile(op.oldPath, op.newPath);
      }
    }
  } catch (err) {
    try {
      await deleteChat(newChatId);
    } catch (cleanupErr) {
      logError("Failed to clean up partially created branch after attachment failure:", cleanupErr);
    }
    throw new Error(
      `Branch creation failed while copying attachments: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  return newChatId;
}

/**
 * Exports a chat session to a portable format.
 *
 * @param chatId - The chat ID to export.
 * @param format - Export format: "json" (full object) or "markdown" (formatted text).
 * @returns The stringified representation of the chat.
 */
export async function exportChat(chatId: string, format: "json" | "markdown"): Promise<string> {
  const chat = await getChat(chatId);
  if (!chat) throw new Error("Chat not found");

  const db = getDb();
  if (chat.messages) {
    for (const m of chat.messages) {
      const attachments = db
        .query<
          {
            id: string;
            message_id: string;
            mime_type: string;
            file_path: string;
            file_name: string;
            vir_budget: number | null;
            created_at: number;
          },
          [string]
        >("SELECT * FROM attachments WHERE message_id = ?")
        .all(m.id);
      if (attachments.length > 0) {
        m.attachments = await Promise.all(
          attachments.map(async (att) => {
            const fp = resolveAttachmentPath(att.file_path);
            let b64 = "";
            if (fp) {
              try {
                const buf = await fs.readFile(fp);
                b64 = buf.toString("base64");
              } catch (_e) {
                logWarn("[chatRepo] Missing attachment file during export", {
                  filePath: att.file_path,
                  messageId: m.id,
                  attachmentId: att.id,
                });
                // ignore missing
              }
            }
            return {
              id: att.id,
              messageId: m.id,
              fileName: att.file_name,
              mimeType: att.mime_type,
              filePath: att.file_path,
              createdAt: att.created_at,
              virBudget: att.vir_budget ?? undefined,
              base64Data: b64,
            } as any; // base64Data is for export
          }),
        );
      }
    }
  }

  if (format === "json") {
    return JSON.stringify(chat, null, 2);
  }

  // markdown
  let md = `# ${chat.name}\n\n`;
  if (chat.messages) {
    for (const m of chat.messages) {
      md += `### ${m.role.toUpperCase()}\n\n`;

      if (m.thinkingContent) {
        md += `> **Thinking**\n> \n> ${m.thinkingContent.split("\n").join("\n> ")}\n\n`;
      }

      md += `${m.content}\n\n`;

      if (m.attachments && m.attachments.length > 0) {
        md += `*Attachments:* ${m.attachments.map((a) => `\`${a.fileName}\``).join(", ")}\n\n`;
      }

      if (m.toolCallsJson) {
        md += `*Tool Calls:* \`\`\`json\n${m.toolCallsJson}\n\`\`\`\n\n`;
      }

      md += `---\n\n`;
    }
  }
  return md;
}

/**
 * Imports a chat session from a JSON string.
 *
 * @param jsonContent - The stringified JSON chat data.
 * @returns The ID of the newly created chat.
 */
export async function importChat(jsonContent: string): Promise<string> {
  const db = getDb();
  let parsed: any;
  try {
    parsed = JSON.parse(jsonContent);
  } catch (err) {
    logError("[chatRepo] Failed to parse imported chat JSON", {
      error: err instanceof Error ? err.message : String(err),
      snippet: jsonContent.slice(0, 160),
    });
    throw new Error("Invalid JSON file");
  }

  assertImportPayload(parsed);

  const newChatId = Bun.randomUUIDv7();
  const now = Date.now();

  const insertChat = db.prepare(
    "INSERT INTO chats (id, name, created_at, updated_at, model_path, system_preset_id, inference_preset_id) VALUES (?, ?, ?, ?, ?, ?, ?)",
  );
  const insertMsg = db.prepare(
    `INSERT INTO messages (id, chat_id, role, content, raw_content, thinking_content, position, created_at, tool_call_id, tool_calls_json)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const insertAttachment = db.prepare(
    "INSERT INTO attachments (id, message_id, mime_type, file_path, file_name, vir_budget, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
  );

  // M3 fix: track attachment metadata alongside file writes so we can skip
  // DB records for attachments whose files fail to write to disk.
  const fileWrites: {
    filePath: string;
    base64Data: string;
    attId: string;
    newMsgId: string;
    mimeType: string;
    relPath: string;
    fileName: string;
    virBudget: number | null;
  }[] = [];

  const runTransaction = db.transaction(() => {
    insertChat.run(
      newChatId,
      `Imported: ${parsed.name || "Chat"}`,
      now,
      now,
      parsed.modelPath || null,
      parsed.systemPresetId || null,
      parsed.inferencePresetId || null,
    );

    if (Array.isArray(parsed.messages)) {
      for (let i = 0; i < parsed.messages.length; i++) {
        const msg = parsed.messages[i];
        if (!msg) continue;
        const newMsgId = Bun.randomUUIDv7();
        insertMsg.run(
          newMsgId,
          newChatId,
          msg.role,
          msg.content,
          msg.rawContent || msg.content,
          msg.thinkingContent || null,
          i,
          msg.createdAt || now,
          msg.toolCallId || null,
          msg.toolCallsJson || null,
        );

        if (Array.isArray(msg.attachments)) {
          for (const att of msg.attachments) {
            if (!att.base64Data) continue;
            const attId = Bun.randomUUIDv7();
            const ext = path.extname(sanitizeFileName(att.fileName)) || "";
            const safeName = Bun.randomUUIDv7() + ext;
            const appData = path.join(APP_ROOT, "attachments", newChatId, newMsgId);

            const filePath = path.join(appData, safeName);
            const relPath = path.relative(APP_ROOT, filePath).split(path.sep).join("/");

            // M3 fix: defer attachment record insertion until file write succeeds
            fileWrites.push({
              filePath,
              base64Data: att.base64Data,
              attId,
              newMsgId,
              mimeType: att.mimeType,
              relPath,
              fileName: att.fileName,
              virBudget: att.virBudget || null,
            });
          }
        }
      }
    }
  });

  runTransaction();

  // M3 fix: Execute file writes outside transaction, then insert attachment records
  // only for files that were successfully written. Log failures instead of swallowing.
  for (const fw of fileWrites) {
    try {
      await fs.mkdir(path.dirname(fw.filePath), { recursive: true });
      await fs.writeFile(fw.filePath, Buffer.from(fw.base64Data, "base64"));
      // File written successfully — now insert the DB record
      insertAttachment.run(
        fw.attId,
        fw.newMsgId,
        fw.mimeType,
        fw.relPath,
        fw.fileName,
        fw.virBudget,
        now,
      );
    } catch (err) {
      logWarn("[chatRepo] Failed to write imported attachment file, skipping DB record", {
        filePath: fw.filePath,
        fileName: fw.fileName,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  return newChatId;
}
