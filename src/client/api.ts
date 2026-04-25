/**
 * @packageDocumentation
 * Low-level fetch wrappers for the LlamaForge REST API.
 * All functions return promises and throw Errors on non-OK responses.
 */

import type { InferencePreset, LoadPreset, SystemPromptPreset } from "@shared/types.js";

/**
 * Fetches all available model load presets from the backend.
 *
 * @returns A promise resolving to an array of {@link LoadPreset}.
 * @throws {Error} If the fetch fails.
 */
export async function fetchLoadPresets(): Promise<LoadPreset[]> {
  const res = await fetch("/api/presets/load");
  if (!res.ok) throw new Error("Failed to fetch load presets");
  return res.json();
}

/**
 * Creates a new model load preset.
 *
 * @param preset - The {@link LoadPreset} object to persist.
 * @returns A promise that resolves when the preset is created.
 */
export async function createLoadPreset(preset: LoadPreset): Promise<void> {
  const res = await fetch("/api/presets/load", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(preset),
  });
  if (!res.ok) throw new Error("Failed to create load preset");
}

/**
 * Updates an existing model load preset.
 *
 * @param id - The unique ID of the preset to update.
 * @param updates - Partial object containing fields to change.
 * @returns A promise that resolves when the update is complete.
 */
export async function updateLoadPreset(id: string, updates: Partial<LoadPreset>): Promise<void> {
  const res = await fetch(`/api/presets/load/${id}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(updates),
  });
  if (!res.ok) throw new Error("Failed to update load preset");
}

/**
 * Deletes a model load preset.
 *
 * @param id - The unique ID of the preset to remove.
 * @returns A promise that resolves when the deletion is complete.
 */
export async function deleteLoadPreset(id: string): Promise<void> {
  const res = await fetch(`/api/presets/load/${id}`, { method: "DELETE" });
  if (!res.ok) throw new Error("Failed to delete load preset");
}

/**
 * Fetches all available inference presets from the backend.
 *
 * @returns A promise resolving to an array of {@link InferencePreset}.
 * @throws {Error} If the fetch fails.
 */
export async function fetchInferencePresets(): Promise<InferencePreset[]> {
  const res = await fetch("/api/presets/inference");
  if (!res.ok) throw new Error("Failed to fetch inference presets");
  return res.json();
}

/**
 * Creates a new inference preset.
 *
 * @param preset - The {@link InferencePreset} object to persist.
 * @returns A promise that resolves when the preset is created.
 */
export async function createInferencePreset(preset: InferencePreset): Promise<void> {
  const res = await fetch("/api/presets/inference", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(preset),
  });
  if (!res.ok) throw new Error("Failed to create inference preset");
}

/**
 * Updates an existing inference preset.
 *
 * @param id - The unique ID of the preset to update.
 * @param updates - Partial object containing fields to change.
 * @returns A promise that resolves when the update is complete.
 */
export async function updateInferencePreset(
  id: string,
  updates: Partial<InferencePreset>,
): Promise<void> {
  const res = await fetch(`/api/presets/inference/${id}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(updates),
  });
  if (!res.ok) throw new Error("Failed to update inference preset");
}

/**
 * Deletes an inference preset.
 *
 * @param id - The unique ID of the preset to remove.
 * @returns A promise that resolves when the deletion is complete.
 */
export async function deleteInferencePreset(id: string): Promise<void> {
  const res = await fetch(`/api/presets/inference/${id}`, { method: "DELETE" });
  if (!res.ok) throw new Error("Failed to delete inference preset");
}

/**
 * Fetches all chat sessions from the backend, optionally filtered.
 *
 * @param q - Search query string.
 * @returns A promise resolving to an array of {@link ChatSession}.
 * @throws {Error} If the fetch fails.
 */
export async function fetchChats(
  q?: string,
  limit?: number,
  offset?: number,
): Promise<import("@shared/types.js").ChatSession[]> {
  const params = new URLSearchParams();
  if (q) params.set("q", q);
  if (limit !== undefined) params.set("limit", limit.toString());
  if (offset !== undefined) params.set("offset", offset.toString());

  const url = `/api/chats${params.toString() ? `?${params.toString()}` : ""}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error("Failed to fetch chats");
  return res.json();
}

/**
 * Creates a new chat session.
 *
 * @param data - Initial metadata for the chat session.
 * @returns A promise resolving to the created {@link ChatSession}.
 */
export async function createChat(
  data: Partial<import("@shared/types.js").ChatSession> = {},
): Promise<import("@shared/types.js").ChatSession> {
  const res = await fetch("/api/chats", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(data),
  });
  if (!res.ok) throw new Error("Failed to create chat");
  return res.json();
}

/**
 * Fetches a single chat session with full history.
 *
 * @param id - The unique UUID of the chat session.
 * @returns A promise resolving to the {@link ChatSession}.
 */
export async function fetchChat(id: string): Promise<import("@shared/types.js").ChatSession> {
  const res = await fetch(`/api/chats/${id}`);
  if (!res.ok) throw new Error("Failed to fetch chat");
  return res.json();
}

/**
 * Updates an existing chat session's metadata.
 *
 * @param id - The unique UUID of the chat.
 * @param updates - Partial object containing updates.
 * @returns A promise that resolves when complete.
 */
export async function updateChat(
  id: string,
  updates: Partial<import("@shared/types.js").ChatSession>,
): Promise<void> {
  const res = await fetch(`/api/chats/${id}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(updates),
  });
  if (!res.ok) throw new Error("Failed to update chat");
}

/**
 * Updates a specific message's content.
 *
 * @param chatId - The ID of the chat.
 * @param messageId - The ID of the message.
 * @param content - The new text content.
 * @param thinkingContent - Optional updated thinking block.
 * @returns A promise that resolves when complete.
 */
export async function updateMessage(
  chatId: string,
  messageId: string,
  content: string,
  thinkingContent?: string,
): Promise<void> {
  const res = await fetch(`/api/chats/${chatId}/messages/${messageId}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ content, thinkingContent }),
  });
  if (!res.ok) throw new Error("Failed to update message");
}

/**
 * Deletes a message and all subsequent messages in a chat session.
 *
 * @param chatId - The unique UUID of the chat.
 * @param messageId - The unique UUID of the message.
 * @returns A promise that resolves when complete.
 */
export async function deleteMessage(chatId: string, messageId: string): Promise<void> {
  const res = await fetch(`/api/chats/${chatId}/messages/${messageId}`, {
    method: "DELETE",
  });
  if (!res.ok) throw new Error("Failed to delete message");
}

/**
 * Deletes a chat session.
 *
 * @param id - The ID of the chat.
 * @returns A promise that resolves when complete.
 */
export async function deleteChat(id: string): Promise<void> {
  const res = await fetch(`/api/chats/${id}`, { method: "DELETE" });
  if (!res.ok) throw new Error("Failed to delete chat");
}

/**
 * Creates a new branch from a specific message index.
 *
 * @param id - The source chat ID.
 * @param messageId - The message ID to branch from.
 * @returns A promise resolving to the new {@link ChatSession}.
 */
export async function branchChat(
  id: string,
  messageId: string,
): Promise<import("@shared/types.js").ChatSession> {
  const res = await fetch(`/api/chats/${id}/branch`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ messageId }),
  });
  if (!res.ok) throw new Error("Failed to branch chat");
  return res.json();
}

/**
 * Triggers re-generation for the active turn in a chat.
 *
 * @param id - The chat ID.
 * @returns A promise resolving to the new message metadata.
 */
export async function regenerateChat(id: string): Promise<{ messageId: string }> {
  const res = await fetch(`/api/chats/${id}/regenerate`, { method: "POST" });
  if (!res.ok) throw new Error("Failed to regenerate chat");
  return res.json();
}

/**
 * Continues a partial assistant response.
 *
 * @param id - The chat ID.
 * @returns A promise resolving to the updated message metadata.
 */
export async function continueChat(id: string): Promise<{ messageId: string }> {
  const res = await fetch(`/api/chats/${id}/continue`, { method: "POST" });
  if (!res.ok) throw new Error("Failed to continue chat");
  return res.json();
}

/**
 * Exports a chat history in the requested format.
 *
 * @param id - The chat ID.
 * @param format - The export format (json or markdown).
 * @returns A promise resolving to the formatted content string.
 */
export async function exportChat(
  id: string,
  format: "json" | "markdown" = "json",
): Promise<string> {
  const res = await fetch(`/api/chats/${id}/export`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ format }),
  });
  if (!res.ok) throw new Error("Failed to export chat");
  const data = await res.json();
  return data.content;
}

/**
 * Imports a chat session from a JSON string.
 *
 * @param content - The JSON string content.
 * @returns A promise resolving to the ID of the newly created chat.
 */
export async function importChat(content: string): Promise<{ id: string }> {
  const res = await fetch("/api/chats/import", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ content }),
  });
  if (!res.ok) throw new Error("Failed to import chat");
  return res.json();
}

/**
 * Fetches all system prompt presets.
 *
 * @returns A promise resolving to an array of {@link SystemPromptPreset}.
 */
export async function fetchSystemPresets(): Promise<SystemPromptPreset[]> {
  const res = await fetch("/api/presets/system");
  if (!res.ok) throw new Error("Failed to fetch system presets");
  return res.json();
}

/**
 * Creates a new system prompt preset.
 *
 * @param preset - The {@link SystemPromptPreset} object.
 * @returns A promise that resolves when complete.
 */
export async function createSystemPreset(preset: SystemPromptPreset): Promise<void> {
  const res = await fetch("/api/presets/system", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(preset),
  });
  if (!res.ok) throw new Error("Failed to create system preset");
}

/**
 * Updates an existing system prompt preset.
 *
 * @param id - The unique ID.
 * @param updates - Partial updates.
 * @returns A promise that resolves when complete.
 */
export async function updateSystemPreset(
  id: string,
  updates: Partial<SystemPromptPreset>,
): Promise<void> {
  const res = await fetch(`/api/presets/system/${id}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(updates),
  });
  if (!res.ok) throw new Error("Failed to update system preset");
}

/**
 * Deletes a system prompt preset.
 *
 * @param id - The ID to remove.
 * @returns A promise that resolves when complete.
 */
export async function deleteSystemPreset(id: string): Promise<void> {
  const res = await fetch(`/api/presets/system/${id}`, { method: "DELETE" });
  if (!res.ok) throw new Error("Failed to delete system preset");
}

// --- Settings ---

/**
 * Fetches application settings.
 *
 * @returns A promise resolving to the settings object.
 */
export async function fetchSettings(): Promise<any> {
  const res = await fetch("/api/settings");
  if (!res.ok) throw new Error("Failed to fetch settings");
  return res.json();
}

/**
 * Updates application settings.
 *
 * @param updates - Partial settings object.
 * @returns A promise that resolves when complete.
 */
export async function updateSettings(updates: any): Promise<void> {
  const res = await fetch("/api/settings", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(updates),
  });
  if (!res.ok) throw new Error("Failed to update settings");
}

/**
 * Forces a hardware-aware optimization for a specific model path.
 *
 * @param modelPath - Absolute path to the .gguf model.
 * @returns A promise resolving to an optimized partial {@link ModelLoadConfig}.
 * @throws {Error} If the optimization request fails.
 */
export async function optimizeHardware(
  modelPath: string,
): Promise<Partial<import("@shared/types.js").ModelLoadConfig>> {
  const res = await fetch("/api/hardware/optimize", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ modelPath }),
  });
  if (!res.ok) throw new Error("Hardware optimization failed");
  return res.json();
}
