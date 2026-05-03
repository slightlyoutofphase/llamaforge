/**
 * @packageDocumentation
 * Tests for websocket hub broadcast and connection lifecycle.
 */

import { describe, expect, it, mock, spyOn } from "bun:test";
import type { ServerWebSocket } from "bun";
import {
  addConnection,
  broadcast,
  broadcastLog,
  broadcastStatus,
  clearConnections,
  recordPong,
  removeConnection,
} from "../../src/server/wsHub";
import {
  logDebug,
  logError,
  logInfo,
  setConfiguredLogLevel,
  setSilent,
} from "../../src/server/logger";
import { beforeEach, afterEach } from "bun:test";

describe("wsHub", () => {
  beforeEach(() => {
    clearConnections();
    setSilent(true);
  });

  afterEach(() => {
    setSilent(process.env.NODE_ENV === "test");
    setConfiguredLogLevel("info");
  });
  it("broadcasts messages to all registered connections", () => {
    const send1 = mock(() => {});
    const send2 = mock(() => {});

    const ws1 = { send: send1 } as unknown as ServerWebSocket<unknown>;
    const ws2 = { send: send2 } as unknown as ServerWebSocket<unknown>;

    addConnection(ws1);
    addConnection(ws2);

    const frame: any = { type: "token", delta: "hi" };
    broadcast(frame);

    expect(send1).toHaveBeenCalledWith(JSON.stringify(frame));
    expect(send2).toHaveBeenCalledWith(JSON.stringify(frame));

    removeConnection(ws1);
    broadcast({ type: "token", delta: "bye" } as any);

    expect(send1).toHaveBeenCalledTimes(1);
    expect(send2).toHaveBeenCalledTimes(2);

    // cleanup for other tests
    removeConnection(ws2);
  });

  it("broadcastStatus sends server_status frame", () => {
    const send = mock(() => {});
    const ws = { send } as unknown as ServerWebSocket<unknown>;
    addConnection(ws);

    broadcastStatus("running");
    expect(send).toHaveBeenCalledWith(JSON.stringify({ type: "server_status", status: "running" }));

    removeConnection(ws);
  });

  it("broadcastLog sends log frame with timestamp", () => {
    const send = mock(() => {});
    const ws = { send } as unknown as ServerWebSocket<unknown>;
    addConnection(ws);

    broadcastLog("info", "test log");
    const sent = JSON.parse(send.mock.calls[0]?.[0] as string);
    expect(sent.type).toBe("log");
    expect(sent.level).toBe("info");
    expect(sent.body).toBe("test log");
    expect(sent.ts).toBeDefined();

    removeConnection(ws);
  });

  it("filters emitted logs according to the configured backend log level", () => {
    const send = mock(() => {});
    const ws = { send } as unknown as ServerWebSocket<unknown>;
    const infoSpy = spyOn(console, "log").mockImplementation(() => {});
    const debugSpy = spyOn(console, "debug").mockImplementation(() => {});
    const errorSpy = spyOn(console, "error").mockImplementation(() => {});

    try {
      addConnection(ws);
      setSilent(false);
      setConfiguredLogLevel("error");

      logInfo("hidden info");
      logDebug("hidden debug");
      logError("visible error");

      expect(send).toHaveBeenCalledTimes(1);
      const sent = JSON.parse(send.mock.calls[0]?.[0] as string);
      expect(sent.level).toBe("error");
      expect(sent.body).toContain("visible error");
    } finally {
      infoSpy.mockRestore();
      debugSpy.mockRestore();
      errorSpy.mockRestore();
      removeConnection(ws);
    }
  });

  it("schedules heartbeat pings and keeps active sockets alive after pong updates", () => {
    const originalSetInterval = globalThis.setInterval;
    const originalClearInterval = globalThis.clearInterval;
    const nowSpy = spyOn(Date, "now");
    let heartbeatTick: (() => void) | undefined;
    let now = 1_000;

    nowSpy.mockImplementation(() => now);
    globalThis.setInterval = ((handler: TimerHandler) => {
      heartbeatTick = handler as () => void;
      return 1 as ReturnType<typeof setInterval>;
    }) as typeof setInterval;
    globalThis.clearInterval = mock(() => {}) as typeof clearInterval;

    try {
      const ping = mock(() => {});
      const close = mock(() => {});
      const ws = { send: mock(() => {}), ping, close } as unknown as ServerWebSocket<unknown>;

      addConnection(ws);
      expect(heartbeatTick).toBeDefined();

      heartbeatTick?.();
      expect(ping).toHaveBeenCalledTimes(1);
      expect(close).not.toHaveBeenCalled();

      now += 10_000;
      recordPong(ws);
      now += 10_000;
      heartbeatTick?.();

      expect(ping).toHaveBeenCalledTimes(2);
      expect(close).not.toHaveBeenCalled();

      removeConnection(ws);
    } finally {
      nowSpy.mockRestore();
      globalThis.setInterval = originalSetInterval;
      globalThis.clearInterval = originalClearInterval;
    }
  });

  it("closes stale sockets and stops the heartbeat when the last connection disappears", () => {
    const originalSetInterval = globalThis.setInterval;
    const originalClearInterval = globalThis.clearInterval;
    const nowSpy = spyOn(Date, "now");
    const clearIntervalSpy = mock(() => {});
    let heartbeatTick: (() => void) | undefined;
    let now = 5_000;

    nowSpy.mockImplementation(() => now);
    globalThis.setInterval = ((handler: TimerHandler) => {
      heartbeatTick = handler as () => void;
      return 1 as ReturnType<typeof setInterval>;
    }) as typeof setInterval;
    globalThis.clearInterval = clearIntervalSpy as typeof clearInterval;

    try {
      const ping = mock(() => {});
      const close = mock(() => {});
      const ws = { send: mock(() => {}), ping, close } as unknown as ServerWebSocket<unknown>;

      addConnection(ws);
      now += 70_000;
      heartbeatTick?.();

      expect(close).toHaveBeenCalledWith(1001, "Heartbeat timeout");
      expect(clearIntervalSpy).toHaveBeenCalledTimes(1);
      expect(ping).not.toHaveBeenCalled();
    } finally {
      nowSpy.mockRestore();
      globalThis.setInterval = originalSetInterval;
      globalThis.clearInterval = originalClearInterval;
    }
  });
});
