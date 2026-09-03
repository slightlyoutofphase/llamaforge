/**
 * @packageDocumentation
 * Registry for WebSocket connections to broadcast frames.
 * Manages client lifecycle (add/remove) and various broadcast helpers.
 */

import type { LlamaServerStatus, WsFrame } from "../shared/types";
import type { ServerWebSocket } from "bun";
import { logWarn } from "./logger";
const connections = new Set<ServerWebSocket<unknown>>();
const logBuffer: Extract<WsFrame, { type: "log" }>[] = [];
const MAX_BUFFER_SIZE = 200;

const lastPongTimes = new WeakMap<ServerWebSocket<unknown>, number>();

// M4 fix: periodic WebSocket heartbeat to detect stale/half-open connections
const PING_INTERVAL_MS = 30_000;
const STALE_THRESHOLD_MS = 65_000;
let pingInterval: ReturnType<typeof setInterval> | null = null;

/**
 * Starts the periodic heartbeat loop used to detect stale WebSocket clients.
 *
 * @returns No return value.
 */
function startHeartbeat(): void {
  if (pingInterval) return;
  pingInterval = setInterval(() => {
    const now = Date.now();
    for (const ws of Array.from(connections)) {
      const lastPong = lastPongTimes.get(ws) ?? now;
      if (now - lastPong > STALE_THRESHOLD_MS) {
        logWarn("[wsHub] Closing stale WebSocket (no pong received)");
        connections.delete(ws);
        stopHeartbeatIfEmpty();
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
        stopHeartbeatIfEmpty();
      }
    }
  }, PING_INTERVAL_MS);
}

/**
 * Stops the heartbeat timer when there are no active WebSocket clients left.
 *
 * @returns No return value.
 */
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
 * @returns No return value.
 */
export function addConnection(ws: ServerWebSocket<unknown>): void {
  connections.add(ws);
  // Send buffered logs to new connection
  for (const log of logBuffer) {
    sendPayload(ws, JSON.stringify(log));
  }
  lastPongTimes.set(ws, Date.now());
  startHeartbeat();
}

/**
 * Removes a WebSocket connection from the broadcast registry.
 *
 * @param ws - The {@link ServerWebSocket} that has closed.
 * @returns No return value.
 */
export function removeConnection(ws: ServerWebSocket<unknown>): void {
  connections.delete(ws);
  stopHeartbeatIfEmpty();
}

/**
 * Records a pong response from a WebSocket client, updating its last-seen time.
 *
 * @param ws - The {@link ServerWebSocket} that responded to a ping.
 * @returns No return value.
 */
export function recordPong(ws: ServerWebSocket<unknown>): void {
  lastPongTimes.set(ws, Date.now());
}

/**
 * Returns the number of currently registered WebSocket connections.
 *
 * @returns Active connection count.
 */
export function getConnectionCount(): number {
  return connections.size;
}

/**
 * Sends a JSON payload to a WebSocket client, dropping the socket on backpressure or send failure.
 *
 * @param ws - Target WebSocket.
 * @param data - Serialized frame text.
 * @returns `true` when the send was accepted.
 */
function sendPayload(ws: ServerWebSocket<unknown>, data: string): boolean {
  try {
    const result = ws.send(data);
    if (typeof result === "number" && result < 0) {
      connections.delete(ws);
      stopHeartbeatIfEmpty();
      try {
        ws.close(1013, "Backpressure");
      } catch {
        // Connection already dead
      }
      return false;
    }
    return true;
  } catch (err) {
    connections.delete(ws);
    stopHeartbeatIfEmpty();
    logWarn("Failed to send frame to websocket, removing connection:", err);
    return false;
  }
}

/**
 * Broadcasts a standard WebSocket frame to all connected clients.
 *
 * @param frame - The {@link WsFrame} to stringify and send.
 * @returns No return value.
 */
export function broadcast(frame: WsFrame): void {
  const data = JSON.stringify(frame);
  for (const ws of Array.from(connections)) {
    sendPayload(ws, data);
  }
}

/**
 * Broadcasts the current model server status to all clients.
 *
 * @param status - The new {@link LlamaServerStatus}.
 * @returns No return value.
 */
export function broadcastStatus(status: LlamaServerStatus): void {
  broadcast({ type: "server_status", status });
}

/**
 * Broadcasts a model-loading progress update to all connected clients.
 *
 * @param phase - The current loading phase.
 * @param progress - Estimated progress percentage (0–100).
 * @param detail - Optional human-readable detail about the current step.
 * @returns No return value.
 */
export function broadcastLoadProgress(
  phase: "spawning" | "loading_weights" | "offloading" | "initializing" | "ready",
  progress: number,
  detail?: string,
): void {
  broadcast({ type: "load_progress", phase, progress, detail });
}

/**
 * Broadcasts a system log message to all clients.
 *
 * @param level - The severity level of the log.
 * @param message - The text content of the log message.
 * @returns No return value.
 */
export function broadcastLog(level: string, message: string): void {
  const normalizedLevel: Extract<WsFrame, { type: "log" }>["level"] =
    level === "info" ||
    level === "warn" ||
    level === "error" ||
    level === "debug" ||
    level === "server"
      ? level
      : "server";
  const logFrame: Extract<WsFrame, { type: "log" }> = {
    type: "log",
    level: normalizedLevel,
    body: message,
    ts: Date.now(),
  };
  logBuffer.push(logFrame);
  if (logBuffer.length > MAX_BUFFER_SIZE) logBuffer.shift();
  broadcast(logFrame);
}
/**
 * Removes all active WebSocket connections and clears the log buffer.
 * Primarily used for ensuring isolation between automated tests.
 *
 * @returns No return value.
 */
export function clearConnections(): void {
  connections.clear();
  logBuffer.length = 0;
  stopHeartbeatIfEmpty();
}
