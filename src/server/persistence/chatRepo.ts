/**
 * @packageDocumentation
 * Chat repository — CRUD operations for chat sessions and messages.
 */

import fs from "node:fs/promises";
import path from "node:path";
import type {
  Attachment,
  ChatMessage,
  ChatSession,
  GgufDisplayMetadata,
  MessageMetrics,
} from "../../shared/types";
import { sanitizeToolCallsJson } from "../../shared/toolCalls";
import { logError, logWarn } from "../logger";
import { getAppDataDir, getDb, resolveAppDataPath } from "./db";
type ChatMessageRow = Omit<ChatMessage, "metrics"> & {
  metricsJson?: string | null;
};

/**
 * Normalizes persisted tool-call JSON before it is returned to callers or re-saved.
 *
 * @param toolCallsJson - Raw tool-call JSON payload from persistence.
 * @param context - Context string used for warning logs when invalid payloads are stripped.
 * @returns Sanitized tool-call JSON, or `undefined` when the payload is absent or invalid.
 */
function normalizeToolCallsJson(
  toolCallsJson: string | null | undefined,
  context: string,
): string | undefined {
  if (!toolCallsJson) return undefined;
  const sanitized = sanitizeToolCallsJson(toolCallsJson);
  if (!sanitized) {
    logWarn(`[chatRepo] Stripping invalid toolCallsJson in ${context}`);
  }
  return sanitized;
}

/**
 * Computes the next message position for a chat using `MAX(position) + 1`.
 *
 * @param chatId - Chat whose next message position should be calculated.
 * @returns Next available position for a message in the chat.
 */
export function getNextPosition(chatId: string): number {
  const db = getDb();
  const row = db
    .query<{ max_pos: number | null }, [string]>(
      "SELECT MAX(position) as max_pos FROM messages WHERE chat_id = ?",
    )
    .get(chatId);
  return (row?.max_pos ?? -1) + 1;
}

/**
 * Resolves a persisted attachment path back to an absolute path under the app data root.
 *
 * @param relativePath - Attachment path stored in the database.
 * @returns Absolute attachment path, or `null` when the stored path is unsafe.
 */
function resolveAttachmentPath(relativePath: string): string | null {
  if (!relativePath || typeof relativePath !== "string") return null;
  if (path.isAbsolute(relativePath)) return null;
  const normalized = path.normalize(relativePath);
  if (normalized.startsWith(`..${path.sep}`) || normalized === "..") return null;

  const appRoot = getAppDataDir();
  const absPath = path.join(appRoot, normalized);
  const relative = path.relative(appRoot, absPath);
  if (relative.startsWith("..") || path.isAbsolute(relative)) return null;
  return absPath;
}

/**
 * Sanitizes an attachment filename for safe filesystem reuse during chat export and branching.
 *
 * @param fileName - Raw attachment filename.
 * @returns Basename-safe filename containing only portable characters.
 */
function sanitizeFileName(fileName: string): string {
  const base = path.basename(fileName || "");
  return base.replace(/[^a-zA-Z0-9._-]/g, "_");
}

/**
 * Encodes binary data as a base64 string without using Node's Buffer API.
 *
 * @param bytes - Raw bytes to encode.
 * @returns Base64 representation of `bytes`.
 */
function bytesToBase64(bytes: Uint8Array): string {
  const chunkSize = 0x2000;
  let binary = "";
  for (let i = 0; i < bytes.length; i += chunkSize) {
    const chunk = bytes.subarray(i, Math.min(i + chunkSize, bytes.length));
    binary += String.fromCharCode(...chunk);
  }
  return btoa(binary);
}

/**
 * Decodes a base64 string into bytes without using Node's Buffer API.
 *
 * @param value - Base64 payload.
 * @returns Decoded bytes.
 */
function base64ToBytes(value: string): Uint8Array {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

/**
 * Checks whether a value is one of the valid persisted chat message roles.
 *
 * @param value - Unknown role candidate.
 * @returns `true` when the value matches a supported chat message role.
 */
function isValidMessageRole(value: unknown): value is "system" | "user" | "assistant" | "tool" {
  return value === "system" || value === "user" || value === "assistant" || value === "tool";
}

/**
 * Parses optional message metrics stored alongside an assistant message.
 *
 * @param metricsJson - JSON payload stored in the `metrics_json` column.
 * @returns Parsed message metrics, or `undefined` when the payload is absent or invalid.
 */
function parseMessageMetrics(metricsJson: string | null | undefined): MessageMetrics | undefined {
  if (!metricsJson) return undefined;

  try {
    const parsed = JSON.parse(metricsJson) as Partial<MessageMetrics>;
    if (
      typeof parsed.predictedTokens === "number" &&
      typeof parsed.tokensPerSecond === "number" &&
      typeof parsed.promptTokens === "number" &&
      typeof parsed.promptTokensPerSecond === "number" &&
      typeof parsed.cachedPromptTokens === "number" &&
      typeof parsed.evaluatedPromptTokens === "number"
    ) {
      return {
        predictedTokens: parsed.predictedTokens,
        tokensPerSecond: parsed.tokensPerSecond,
        promptTokens: parsed.promptTokens,
        promptTokensPerSecond: parsed.promptTokensPerSecond,
        cachedPromptTokens: parsed.cachedPromptTokens,
        evaluatedPromptTokens: parsed.evaluatedPromptTokens,
      };
    }
  } catch (err) {
    logWarn("[chatRepo] Failed to parse message metrics", err);
  }

  return undefined;
}

/**
 * Hydrates a raw message row from SQLite into the public chat message shape.
 *
 * @param row - Raw message row returned from SQLite.
 * @returns Hydrated chat message with parsed metrics and sanitized tool-call JSON.
 */
function hydrateChatMessage(row: ChatMessageRow): ChatMessage {
  const metrics = parseMessageMetrics(row.metricsJson);
  const { metricsJson: _metricsJson, toolCallsJson: _toolCallsJson, ...message } = row;
  const toolCallsJson = normalizeToolCallsJson(row.toolCallsJson, "message hydration");

  return {
    ...message,
    ...(toolCallsJson ? { toolCallsJson } : {}),
    ...(metrics ? { metrics } : {}),
  };
}

/**
 * Validates the outer structure of an imported chat payload before persistence.
 *
 * @param parsed - Parsed JSON payload supplied for chat import.
 * @returns No return value.
 * @throws {Error} If the payload or any message/attachment entry is invalid.
 */
function assertImportPayload(parsed: unknown): asserts parsed is {
  name?: string;
  modelPath?: string;
  systemPresetId?: string;
  inferencePresetId?: string;
  messages: ChatMessage[];
} {
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    logError("[chatRepo] Invalid imported chat payload: not an object", { parsed });
    throw new Error("Imported chat must be a JSON object.");
  }
  const record = parsed as Record<string, unknown>;
  if (!Array.isArray(record["messages"])) {
    logError("[chatRepo] Invalid imported chat payload: missing messages array", { parsed });
    throw new Error("Imported chat must include a messages array.");
  }

  const messages = record["messages"] as unknown[];
  for (const [index, rawMsg] of messages.entries()) {
    if (!rawMsg || typeof rawMsg !== "object") {
      throw new Error(`Message at index ${index} is invalid.`);
    }
    const msg = rawMsg as Record<string, unknown>;
    if (!isValidMessageRole(msg["role"])) {
      throw new Error(`Message at index ${index} has invalid role.`);
    }
    if (
      msg["role"] === "tool" &&
      (typeof msg["toolCallId"] !== "string" || msg["toolCallId"].length === 0)
    ) {
      throw new Error(`Tool message at index ${index} requires a valid toolCallId.`);
    }
    if (typeof msg["content"] !== "string") {
      throw new Error(`Message at index ${index} requires a content string.`);
    }
    if (msg["attachments"] !== undefined) {
      if (!Array.isArray(msg["attachments"])) {
        throw new Error(`Attachments for message at index ${index} must be an array.`);
      }
      for (const [attIndex, rawAtt] of msg["attachments"].entries()) {
        if (!rawAtt || typeof rawAtt !== "object") {
          logError("[chatRepo] Invalid attachment object in imported chat", {
            messageIndex: index,
            attachmentIndex: attIndex,
            att: rawAtt,
          });
          throw new Error(`Attachment at index ${attIndex} for message ${index} is invalid.`);
        }
        const att = rawAtt as Record<string, unknown>;
        if (typeof att["fileName"] !== "string" || att["fileName"].length === 0) {
          logError("[chatRepo] Imported attachment missing fileName", {
            messageIndex: index,
            attachmentIndex: attIndex,
            att,
          });
          throw new Error(
            `Attachment at index ${attIndex} for message ${index} requires a valid fileName.`,
          );
        }
        if (typeof att["mimeType"] !== "string" || att["mimeType"].length === 0) {
          throw new Error(
            `Attachment at index ${attIndex} for message ${index} requires a valid mimeType.`,
          );
        }
        if (typeof att["base64Data"] !== "string" || att["base64Data"].length === 0) {
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

function escapeLikePattern(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/%/g, "\\%").replace(/_/g, "\\_");
}

/**
 * Retrieves a list of chat sessions, optionally filtered by name.
 *
 * @param search - Optional query string to filter chats by name (case-insensitive search).
 * @param limit - Maximum number of chats to return.
 * @param offset - Number of chats to skip before returning results.
 * @returns A promise that resolves to an array of {@link ChatSession} basic metadata.
 */
export async function getChats(
  search?: string,
  limit: number = 300,
  offset: number = 0,
): Promise<ChatSession[]> {
  const db = getDb();
  let query =
    "SELECT id, name, created_at as createdAt, updated_at as updatedAt, parent_id as parentId, is_branch as isBranch, model_path as modelPath, system_preset_id as systemPresetId, inference_preset_id as inferencePresetId FROM chats";
  const params: (string | number)[] = [];

  if (search) {
    query += " WHERE name LIKE ? ESCAPE '\\'";
    params.push(`%${escapeLikePattern(search)}%`);
  }

  query += " ORDER BY created_at DESC, id DESC LIMIT ? OFFSET ?";
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
 * @param messageLimit - Optional maximum number of messages to load.
 * @param messageOffset - Optional offset applied when paginating messages.
 * @returns A promise that resolves to the {@link ChatSession} or null if not found.
 */
export async function getChat(
  id: string,
  messageLimit?: number,
  messageOffset?: number,
  beforePosition?: number,
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
    // Count total first so the client knows if there are more
    const countRow = db
      .query<{ cnt: number }, [string]>("SELECT COUNT(*) as cnt FROM messages WHERE chat_id = ?")
      .get(id);
    const totalMessages = countRow?.cnt ?? 0;
    chat.totalMessages = totalMessages;

    if (beforePosition !== undefined) {
      const msgStmt = db.query<ChatMessageRow, [string, number, number]>(
        "SELECT id, chat_id as chatId, role, content, raw_content as rawContent, thinking_content as thinkingContent, position, created_at as createdAt, tool_call_id as toolCallId, tool_calls_json as toolCallsJson, metrics_json as metricsJson FROM messages WHERE chat_id = ? AND position < ? ORDER BY position DESC LIMIT ?",
      );
      chat.messages = msgStmt
        .all(id, beforePosition, messageLimit)
        .reverse()
        .map(hydrateChatMessage);
    } else {
      const offset = messageOffset ?? 0;
      const msgStmt = db.query<ChatMessageRow, [string, number, number]>(
        "SELECT id, chat_id as chatId, role, content, raw_content as rawContent, thinking_content as thinkingContent, position, created_at as createdAt, tool_call_id as toolCallId, tool_calls_json as toolCallsJson, metrics_json as metricsJson FROM messages WHERE chat_id = ? ORDER BY position DESC LIMIT ? OFFSET ?",
      );
      chat.messages = msgStmt.all(id, messageLimit, offset).reverse().map(hydrateChatMessage);
    }
  } else {
    const msgStmt = db.query<ChatMessageRow, [string]>(
      "SELECT id, chat_id as chatId, role, content, raw_content as rawContent, thinking_content as thinkingContent, position, created_at as createdAt, tool_call_id as toolCallId, tool_calls_json as toolCallsJson, metrics_json as metricsJson FROM messages WHERE chat_id = ? ORDER BY position ASC",
    );
    chat.messages = msgStmt.all(id).map(hydrateChatMessage);
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
    const attMap = new Map<string, Attachment[]>();
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
 * @returns A promise that resolves once the chat row and any attachment files have been removed.
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

  db.prepare("UPDATE chats SET parent_id = NULL WHERE parent_id = ?").run(id);
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
      if (fullPath) await Bun.file(fullPath).delete();
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
    const chatDir = resolveAppDataPath("attachments", id);
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
 * @returns A promise that resolves once the message row and chat timestamp are written.
 */
export async function addMessage(message: ChatMessage): Promise<void> {
  const db = getDb();
  const insert = db.transaction((msg: ChatMessage) => {
    const position = getNextPosition(msg.chatId);
    msg.position = position;
    db.prepare(
      `
    INSERT INTO messages (id, chat_id, role, content, raw_content, thinking_content, position, created_at, tool_call_id, tool_calls_json, metrics_json)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `,
    ).run(
      msg.id,
      msg.chatId,
      msg.role,
      msg.content,
      msg.rawContent,
      msg.thinkingContent || null,
      position,
      msg.createdAt,
      msg.toolCallId || null,
      normalizeToolCallsJson(msg.toolCallsJson, "message save") || null,
      msg.metrics ? JSON.stringify(msg.metrics) : null,
    );

    db.prepare("UPDATE chats SET updated_at = ? WHERE id = ?").run(Date.now(), msg.chatId);
  });
  insert(message);
}

/**
 * Updates an individual message's textual content.
 *
 * @param id - UUID of the message.
 * @param content - Parsed content (with thinking tags removed if applicable).
 * @param rawContent - Original raw output from the model.
 * @param thinkingContent - Optional extracted thinking trace content.
 * @returns A promise that resolves once the message row and parent chat timestamp are updated.
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
 * @returns A promise that resolves once the target messages and attachment files are removed.
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
      if (fullPath) await Bun.file(fullPath).delete();
    } catch {}
  }
}

/**
 * Deletes a specific message and all subsequent messages in that chat.
 *
 * @param chatId - UUID of the chat session.
 * @param messageId - UUID of the message to delete.
 * @returns A promise that resolves once the target messages and attachment files are removed.
 */
export async function deleteMessageAndSubsequent(chatId: string, messageId: string): Promise<void> {
  const db = getDb();
  const row = db
    .query<{ position: number }, [string, string]>(
      "SELECT position FROM messages WHERE id = ? AND chat_id = ?",
    )
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
        if (fullPath) await Bun.file(fullPath).delete();
      } catch {}
    }
  }
}

/**
 * Companion mmproj identity stored alongside a primary GGUF cache row so a
 * changed projector invalidates vision/audio encoder flags.
 */
export type GgufCacheCompanion = {
  /** Absolute path to the companion mmproj file, or empty when none. */
  mmprojPath?: string | null;
  /** mtime of the companion file in milliseconds, or 0 when none. */
  mmprojMtime?: number | null;
};

/**
 * Retrieves cached GGUF metadata for a specific file version.
 *
 * When `companion` is provided, the mmproj path and mtime must also match so a
 * replaced projector is not served from a stale cache row.
 *
 * @param filePath - Absolute path to the .gguf file.
 * @param mtime - Last modified timestamp of the file.
 * @param companion - Optional mmproj identity that must match the cache row.
 * @returns The cached metadata or null if not found.
 */
export async function cachedGgufMetadata(
  filePath: string,
  mtime: number,
  companion?: GgufCacheCompanion,
): Promise<GgufDisplayMetadata | null> {
  if (companion !== undefined) {
    const mmprojPath = companion.mmprojPath ?? "";
    const mmprojMtime = companion.mmprojMtime ?? 0;
    const row = getDb()
      .query<{ metadata_json: string }, [string, number, string, number]>(
        "SELECT metadata_json FROM model_cache WHERE file_path = ? AND mtime = ? AND mmproj_path = ? AND mmproj_mtime = ?",
      )
      .get(filePath, mtime, mmprojPath, mmprojMtime);
    return row ? JSON.parse(row.metadata_json) : null;
  }

  const row = getDb()
    .query<{ metadata_json: string }, [string, number]>(
      "SELECT metadata_json FROM model_cache WHERE file_path = ? AND mtime = ?",
    )
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
    .query<{ metadata_json: string }, [string]>(
      "SELECT metadata_json FROM model_cache WHERE file_path = ? ORDER BY mtime DESC LIMIT 1",
    )
    .get(filePath);
  return row ? JSON.parse(row.metadata_json) : null;
}

/**
 * Persist cached display metadata for a specific model path to avoid re-parsing massive binaries.
 *
 * @param filePath - The full absolute path to the local GGUF file.
 * @param mtime - The current modified time of the GGUF file (to invalidate cache appropriately).
 * @param metadata - The loaded and processed metadata variables mapping to standard properties.
 * @param companion - Optional mmproj identity included in the cache key.
 * @returns A promise that resolves once the cache row has been written.
 */
export async function setCachedGgufMetadata(
  filePath: string,
  mtime: number,
  metadata: GgufDisplayMetadata,
  companion?: GgufCacheCompanion,
): Promise<void> {
  const mmprojPath = companion?.mmprojPath ?? "";
  const mmprojMtime = companion?.mmprojMtime ?? 0;
  getDb().prepare("DELETE FROM model_cache WHERE file_path = ?").run(filePath);
  getDb()
    .prepare(
      "INSERT INTO model_cache (file_path, mtime, mmproj_path, mmproj_mtime, metadata_json) VALUES (?, ?, ?, ?, ?)",
    )
    .run(filePath, mtime, mmprojPath, mmprojMtime, JSON.stringify(metadata));
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
    `INSERT INTO messages (id, chat_id, role, content, raw_content, thinking_content, position, created_at, tool_call_id, tool_calls_json, metrics_json)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
        normalizeToolCallsJson(msg.toolCallsJson, "branch copy") || null,
        msg.metrics ? JSON.stringify(msg.metrics) : null,
      );

      // We read attachments from the existing array in `getChat` since it's already there!
      // But we need to use a slightly different loop structure since `chat.messages` has them.
      const attachments = msg.attachments || [];

      for (const att of attachments) {
        const ext = path.extname(sanitizeFileName(att.fileName)) || "";
        const safeName = Bun.randomUUIDv7() + ext;
        const newAppDir = resolveAppDataPath("attachments", newChatId, newMsgId);
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

        const relPath = path.relative(getAppDataDir(), newFilePath).split(path.sep).join("/");

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
                const bytes = await Bun.file(fp).bytes();
                b64 = bytesToBase64(bytes);
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
            };
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
  let parsed: unknown;
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

  const MAX_IMPORT_JSON_CHARS = 50 * 1024 * 1024;
  const MAX_ATTACHMENT_SIZE_BYTES = 10 * 1024 * 1024;
  if (jsonContent.length > MAX_IMPORT_JSON_CHARS) {
    throw new Error("Import payload exceeds 50MB.");
  }

  const newChatId = Bun.randomUUIDv7();
  const now = Date.now();

  const insertChat = db.prepare(
    "INSERT INTO chats (id, name, created_at, updated_at, model_path, system_preset_id, inference_preset_id) VALUES (?, ?, ?, ?, ?, ?, ?)",
  );
  const insertMsg = db.prepare(
    `INSERT INTO messages (id, chat_id, role, content, raw_content, thinking_content, position, created_at, tool_call_id, tool_calls_json, metrics_json)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
          normalizeToolCallsJson(msg.toolCallsJson, "chat import") || null,
          msg.metrics ? JSON.stringify(msg.metrics) : null,
        );

        if (Array.isArray(msg.attachments)) {
          for (const att of msg.attachments) {
            if (!att.base64Data) continue;
            const decodedBytes = base64ToBytes(att.base64Data).byteLength;
            if (decodedBytes > MAX_ATTACHMENT_SIZE_BYTES) {
              throw new Error(
                `Imported attachment ${att.fileName || "unnamed"} exceeds the 10MB limit.`,
              );
            }
            const attId = Bun.randomUUIDv7();
            const ext = path.extname(sanitizeFileName(att.fileName)) || "";
            const safeName = Bun.randomUUIDv7() + ext;
            const appData = resolveAppDataPath("attachments", newChatId, newMsgId);

            const filePath = path.join(appData, safeName);
            const relPath = path.relative(getAppDataDir(), filePath).split(path.sep).join("/");

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
      await Bun.write(fw.filePath, base64ToBytes(fw.base64Data));
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
