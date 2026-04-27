/**
 * @packageDocumentation
 * Registry for WebSocket connections to broadcast frames.
 * Manages client lifecycle (add/remove) and various broadcast helpers.
 */

import type { LlamaServerStatus, WsFrame } from "@shared/types.js";
import type { ServerWebSocket } from "bun";

const connections = new Set<ServerWebSocket<unknown>>();
const lastPongTimes = new WeakMap<ServerWebSocket<unknown>, number>();

// M4 fix: periodic WebSocket heartbeat to detect stale/half-open connections
const PING_INTERVAL_MS = 30_000;
const STALE_THRESHOLD_MS = 65_000;
let pingInterval: ReturnType<typeof setInterval> | null = null;

function startHeartbeat(): void {
  if (pingInterval) return;
  pingInterval = setInterval(() => {
    const now = Date.now();
    for (const ws of Array.from(connections)) {
      const lastPong = lastPongTimes.get(ws) ?? now;
      if (now - lastPong > STALE_THRESHOLD_MS) {
        console.warn("[wsHub] Closing stale WebSocket (no pong received)");
        connections.delete(ws);
        try {
          ws.close(1001, "Heartbeat timeout");
        } catch (_e) {
          // Connection already dead
        }
        continue;
      }
      try {
        ws.ping();
      } catch (_e) {
        connections.delete(ws);
      }
    }
  }, PING_INTERVAL_MS);
}

function stopHeartbeatIfEmpty(): void {
  if (connections.size === 0 && pingInterval) {
    clearInterval(pingInterval);
    pingInterval = null;
  }
}

/**
 * Adds a new WebSocket connection to the broadcast registry.
 *
 * @param ws - The newly opened {@link ServerWebSocket}.
 */
export function addConnection(ws: ServerWebSocket<unknown>): void {
  connections.add(ws);
  lastPongTimes.set(ws, Date.now());
  startHeartbeat();
}

/**
 * Removes a WebSocket connection from the broadcast registry.
 *
 * @param ws - The {@link ServerWebSocket} that has closed.
 */
export function removeConnection(ws: ServerWebSocket<unknown>): void {
  connections.delete(ws);
  stopHeartbeatIfEmpty();
}

/**
 * Records a pong response from a WebSocket client, updating its last-seen time.
 *
 * @param ws - The {@link ServerWebSocket} that responded to a ping.
 */
export function recordPong(ws: ServerWebSocket<unknown>): void {
  lastPongTimes.set(ws, Date.now());
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
