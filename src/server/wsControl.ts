/**
 * @packageDocumentation
 * Inbound WebSocket control frames for generation lifetime.
 *
 * Disconnect, unload, and the last browser tab closing must abort inference.
 * Leaving the llama-server stream running after the page has gone away is what
 * lets a later reconnect paint tokens the user already tried to stop.
 */

import type { ServerWebSocket } from "bun";
import type { GenerationAbortReason } from "./generationRegistry";
import { getConnectionCount, recordActivity } from "./wsHub";

/**
 * Reads a JSON object field as a string.
 *
 * @param record - Parsed client frame.
 * @param key - Field name.
 * @returns The string value, or `null` when the field is missing or empty.
 */
function readString(record: Record<string, unknown>, key: string): string | null {
  const value = record[key];
  return typeof value === "string" && value.length > 0 ? value : null;
}

/**
 * Aborts every active generation when no browser socket remains.
 *
 * The connection count is checked again after the dynamic import so a socket
 * that connected while the module was loading does not lose its stream.
 *
 * @param reason - Why the generations are stopping.
 * @returns A promise that resolves once the abort has been requested.
 */
async function abortIfNoClients(reason: GenerationAbortReason): Promise<void> {
  if (getConnectionCount() !== 0) return;
  const { abortAllGenerations } = await import("./streamProxy");
  if (getConnectionCount() !== 0) return;
  abortAllGenerations(reason);
  const { cancelPendingApprovals } = await import("./tools");
  if (getConnectionCount() !== 0) return;
  cancelPendingApprovals(undefined, reason === "unloaded" ? "unloaded" : "disconnected");
}

/**
 * Handles one client WebSocket payload.
 *
 * @param ws - Socket that sent the payload. Activity on it resets the stale timer.
 * @param raw - Raw text or binary frame.
 * @returns A promise that resolves once any requested abort has been issued.
 */
export async function dispatchClientFrame(
  ws: ServerWebSocket<unknown>,
  raw: string | Buffer,
): Promise<void> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw.toString());
  } catch {
    return;
  }
  if (!parsed || typeof parsed !== "object") return;
  recordActivity(ws);
  const frame = parsed as Record<string, unknown>;
  if (frame["type"] === "heartbeat") return;
  if (frame["type"] === "session_close") {
    // The closing tab is still in the connection set. Another open tab must
    // keep its generation; only the last tab stops inference.
    if (getConnectionCount() > 1) return;
    const { abortAllGenerations } = await import("./streamProxy");
    if (getConnectionCount() > 1) return;
    abortAllGenerations("disconnected");
    const { cancelPendingApprovals } = await import("./tools");
    if (getConnectionCount() > 1) return;
    cancelPendingApprovals(undefined, "disconnected");
    return;
  }
  if (frame["type"] === "cancel") {
    const chatId = readString(frame, "chatId");
    if (!chatId) return;
    const generationId = readString(frame, "generationId");
    const { abortGeneration } = await import("./streamProxy");
    if (generationId) abortGeneration(generationId, "cancelled");
    // The follow-up after a tool call uses a new generation id. Stop must
    // reach that generation even when the client still has the previous id.
    abortGeneration(chatId, "cancelled");
    return;
  }
  if (frame["type"] === "tool_approval") {
    const toolCallId = readString(frame, "toolCallId");
    if (!toolCallId) return;
    const { resolveToolApproval } = await import("./tools");
    const edited = frame["editedArguments"];
    resolveToolApproval(
      toolCallId,
      frame["approved"] === true,
      typeof edited === "string" ? edited : undefined,
      readString(frame, "chatId") ?? undefined,
    );
  }
}

/**
 * Stops inference after the last browser socket closes.
 *
 * An explicit `session_close` frame already aborted. Calling this again is a
 * no-op when nothing is left running, and it still covers a tab that died
 * without sending that frame.
 *
 * @returns A promise that resolves once the empty-client check has finished.
 */
export async function handleClientSocketClosed(): Promise<void> {
  await abortIfNoClients("disconnected");
}
