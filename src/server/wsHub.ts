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

interface SocketHealth {
  /** Last inbound client activity: protocol pong, heartbeat, or any message. */
  lastInboundAt: number;
  /** Consecutive scheduled checks with no inbound activity and no event-loop stall. */
  missedPings: number;
}

const socketHealth = new WeakMap<ServerWebSocket<unknown>, SocketHealth>();

/**
 * How often the server pings each browser socket and emits an application heartbeat.
 * Menu panels and token rendering can stall a tick; the stall check below refuses
 * to treat that delay as a dead browser.
 */
export const WS_PING_INTERVAL_MS = 15_000;

/**
 * Inbound silence required before a scheduled check counts as a missed ping.
 * Two consecutive misses close the socket. A single late timer tick does not.
 */
export const WS_STALE_THRESHOLD_MS = 45_000;

const MISSED_PINGS_TO_CLOSE = 2;
let pingInterval: ReturnType<typeof setInterval> | null = null;
let lastHeartbeatTickAt = 0;

/**
 * Notes that a browser socket is still receiving and answering.
 *
 * Protocol pongs are not sufficient on their own: a token flood can leave the
 * ping frame queued behind unsent deltas, so the page also sends heartbeats
 * and every client message counts.
 *
 * @param ws - Socket that just produced inbound traffic.
 * @returns No return value.
 */
export function recordActivity(ws: ServerWebSocket<unknown>): void {
  const health = socketHealth.get(ws);
  if (!health) return;
  health.lastInboundAt = Date.now();
  health.missedPings = 0;
}

/**
 * Sends one protocol ping and one small application heartbeat.
 *
 * A failed ping is a miss for a later tick to judge. It does not drop the
 * socket on its own, because backpressure during inference is not a disconnect.
 *
 * @param ws - Socket to probe.
 * @param now - Clock reading for the heartbeat payload.
 * @returns No return value.
 */
function probeSocket(ws: ServerWebSocket<unknown>, now: number): void {
  try {
    if (typeof ws.ping !== "function") return;
    const pingResult = ws.ping();
    if (typeof pingResult === "number" && pingResult < 0) {
      return;
    }
  } catch {
    return;
  }
  sendPayload(ws, JSON.stringify({ type: "heartbeat", ts: now }));
}

/**
 * Closes a socket the browser has stopped answering.
 *
 * @param ws - Socket to remove and close.
 * @param reason - Close reason sent to the browser when the socket still accepts it.
 * @returns No return value.
 */
function dropSocket(ws: ServerWebSocket<unknown>, reason: string): void {
  connections.delete(ws);
  socketHealth.delete(ws);
  stopHeartbeatIfEmpty();
  try {
    ws.close(1001, reason);
  } catch {
    // Connection already dead
  }
}

/**
 * Starts the periodic heartbeat loop used to detect stale WebSocket clients.
 *
 * @returns No return value.
 */
function startHeartbeat(): void {
  if (pingInterval) return;
  lastHeartbeatTickAt = Date.now();
  pingInterval = setInterval(() => {
    const now = Date.now();
    const sinceLastTick = lastHeartbeatTickAt === 0 ? 0 : now - lastHeartbeatTickAt;
    const stalled = sinceLastTick > WS_STALE_THRESHOLD_MS;
    lastHeartbeatTickAt = now;
    for (const ws of Array.from(connections)) {
      const health = socketHealth.get(ws);
      if (!health) continue;
      if (stalled) {
        // The event loop was busy (a menu fetch, a long synchronous stretch).
        // The browser did not get a fair chance to answer the previous ping.
        health.missedPings = 0;
        probeSocket(ws, now);
        continue;
      }
      if (now - health.lastInboundAt <= WS_STALE_THRESHOLD_MS) {
        health.missedPings = 0;
        probeSocket(ws, now);
        continue;
      }
      health.missedPings += 1;
      if (health.missedPings >= MISSED_PINGS_TO_CLOSE) {
        logWarn("[wsHub] Closing stale WebSocket (no pong received)");
        dropSocket(ws, "Heartbeat timeout");
        continue;
      }
      probeSocket(ws, now);
    }
  }, WS_PING_INTERVAL_MS);
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
    lastHeartbeatTickAt = 0;
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
  socketHealth.set(ws, { lastInboundAt: Date.now(), missedPings: 0 });
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
  socketHealth.delete(ws);
  stopHeartbeatIfEmpty();
}

/**
 * Records a pong response from a WebSocket client, updating its last-seen time.
 *
 * @param ws - The {@link ServerWebSocket} that responded to a ping.
 * @returns No return value.
 */
export function recordPong(ws: ServerWebSocket<unknown>): void {
  recordActivity(ws);
}

/**
 * Closes every registered browser socket.
 *
 * Used when the process itself is going away so the page observes a close
 * frame instead of a half-open connection that keeps the composer in a
 * generating state.
 *
 * @param code - WebSocket close code.
 * @param reason - Short close reason.
 * @returns No return value.
 */
export function closeAllConnections(code = 1001, reason = "Server shutting down"): void {
  for (const ws of Array.from(connections)) {
    connections.delete(ws);
    socketHealth.delete(ws);
    try {
      ws.close(code, reason);
    } catch {
      // Connection already dead
    }
  }
  stopHeartbeatIfEmpty();
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
      // The browser is behind (a large render, an open menu, a token flood).
      // Drop this frame and keep the socket. Closing here used to kill a live
      // generation and then the reconnect path painted the rest of it anyway.
      return false;
    }
    return true;
  } catch (err) {
    dropSocket(ws, "Send failed");
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
