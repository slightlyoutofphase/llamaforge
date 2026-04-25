/**
 * @packageDocumentation
 * Registry for WebSocket connections to broadcast frames.
 * Manages client lifecycle (add/remove) and various broadcast helpers.
 */

import type { LlamaServerStatus, WsFrame } from "@shared/types.js";
import type { ServerWebSocket } from "bun";

const connections = new Set<ServerWebSocket<unknown>>();

/**
 * Adds a new WebSocket connection to the broadcast registry.
 *
 * @param ws - The newly opened {@link ServerWebSocket}.
 */
export function addConnection(ws: ServerWebSocket<unknown>): void {
  connections.add(ws);
}

/**
 * Removes a WebSocket connection from the broadcast registry.
 *
 * @param ws - The {@link ServerWebSocket} that has closed.
 */
export function removeConnection(ws: ServerWebSocket<unknown>): void {
  connections.delete(ws);
}

/**
 * Broadcasts a standard WebSocket frame to all connected clients.
 *
 * @param frame - The {@link WsFrame} to stringify and send.
 */
export function broadcast(frame: WsFrame): void {
  const data = JSON.stringify(frame);
  for (const ws of Array.from(connections)) {
    try {
      ws.send(data);
    } catch (err) {
      connections.delete(ws);
      console.warn("Failed to send frame to websocket, removing connection:", err);
    }
  }
}

/**
 * Broadcasts the current model server status to all clients.
 *
 * @param status - The new {@link LlamaServerStatus}.
 */
export function broadcastStatus(status: LlamaServerStatus): void {
  broadcast({ type: "server_status", status });
}

/**
 * Broadcasts a system log message to all clients.
 *
 * @param level - The severity level of the log.
 * @param body - The text content of the log message.
 */
export function broadcastLog(
  level: "info" | "warn" | "error" | "debug" | "server",
  body: string,
): void {
  broadcast({ type: "log", level, body, ts: Date.now() });
}
