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
  logVerbose,
  setConfiguredLogLevel,
  setSilent,
} from "../../src/server/logger";
import { beforeEach, afterEach } from "bun:test";

/**
 * Replaces `setInterval` so tests can fire the heartbeat callback immediately.
 * The dummy timer comes from the real `setInterval` so the return type matches.
 *
 * @returns Captured tick function, restore callback, and the dummy timer id.
 */
function captureHeartbeatInterval(): {
  getTick: () => (() => void) | undefined;
  restore: () => void;
} {
  const originalSetInterval = globalThis.setInterval.bind(globalThis);
  const originalClearInterval = globalThis.clearInterval.bind(globalThis);
  let captured: (() => void) | undefined;
  let dummy: ReturnType<typeof setInterval> | undefined;

  globalThis.setInterval = ((handler: TimerHandler) => {
    captured = typeof handler === "function" ? () => (handler as () => void)() : () => {};
    dummy = originalSetInterval(() => {}, 60 * 60 * 1000);
    return dummy;
  }) as unknown as typeof setInterval;

  return {
    getTick: () => captured,
    restore: () => {
      globalThis.setInterval = originalSetInterval;
      if (dummy !== undefined) {
        originalClearInterval(dummy as Parameters<typeof originalClearInterval>[0]);
      }
    },
  };
}

describe("wsHub", () => {
  beforeEach(() => {
    clearConnections();
    setSilent(true);
  });

  afterEach(() => {
    setSilent(Bun.env.NODE_ENV === "test");
    setConfiguredLogLevel("info");
  });
  it("broadcasts messages to all registered connections", () => {
    const send1 = mock((data: string) => {
      void data;
    });
    const send2 = mock((data: string) => {
      void data;
    });

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
    const send = mock((data: string) => {
      void data;
    });
    const ws = { send } as unknown as ServerWebSocket<unknown>;
    addConnection(ws);

    broadcastStatus("running");
    expect(send).toHaveBeenCalledWith(JSON.stringify({ type: "server_status", status: "running" }));

    removeConnection(ws);
  });

  it("broadcastLog sends log frame with timestamp", () => {
    const send = mock((data: string) => {
      void data;
    });
    const ws = { send } as unknown as ServerWebSocket<unknown>;
    addConnection(ws);

    broadcastLog("info", "test log");
    const firstPayload = send.mock.calls[0]?.[0];
    expect(typeof firstPayload).toBe("string");
    if (typeof firstPayload !== "string") {
      throw new Error("expected a broadcast log payload");
    }
    const sent = JSON.parse(firstPayload) as {
      type: string;
      level: string;
      body: string;
      ts?: number;
    };
    expect(sent.type).toBe("log");
    expect(sent.level).toBe("info");
    expect(sent.body).toBe("test log");
    expect(sent.ts).toBeDefined();

    removeConnection(ws);
  });

  it("filters emitted logs according to the configured backend log level", () => {
    const send = mock((data: string) => {
      void data;
    });
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
      const errorPayload = send.mock.calls[0]?.[0];
      expect(typeof errorPayload).toBe("string");
      if (typeof errorPayload !== "string") {
        throw new Error("expected a filtered log payload");
      }
      const sent = JSON.parse(errorPayload) as { level: string; body: string };
      expect(sent.level).toBe("error");
      expect(sent.body).toContain("visible error");
    } finally {
      infoSpy.mockRestore();
      debugSpy.mockRestore();
      errorSpy.mockRestore();
      removeConnection(ws);
    }
  });

  it("emits verbose logs only when the configured level is verbose", () => {
    const send = mock((data: string) => {
      void data;
    });
    const ws = { send } as unknown as ServerWebSocket<unknown>;
    const debugSpy = spyOn(console, "debug").mockImplementation(() => {});

    try {
      addConnection(ws);
      setSilent(false);
      setConfiguredLogLevel("debug");
      logVerbose("hidden verbose");
      expect(send).toHaveBeenCalledTimes(0);

      setConfiguredLogLevel("verbose");
      logVerbose("visible verbose", { temperature: 0.8 });
      expect(send).toHaveBeenCalledTimes(1);
      const verbosePayload = send.mock.calls[0]?.[0];
      expect(typeof verbosePayload).toBe("string");
      if (typeof verbosePayload !== "string") {
        throw new Error("expected a verbose log payload");
      }
      const sent = JSON.parse(verbosePayload) as { body: string };
      expect(sent.body).toContain("visible verbose");
      expect(sent.body).toContain("temperature");
    } finally {
      debugSpy.mockRestore();
      removeConnection(ws);
    }
  });

  it("schedules heartbeat pings and keeps active sockets alive after pong updates", () => {
    const nowSpy = spyOn(Date, "now");
    let now = 1_000;
    nowSpy.mockImplementation(() => now);
    const heartbeat = captureHeartbeatInterval();

    try {
      const ping = mock(() => {});
      const close = mock(() => {});
      const ws = { send: mock(() => {}), ping, close } as unknown as ServerWebSocket<unknown>;

      addConnection(ws);
      expect(heartbeat.getTick()).toBeDefined();

      heartbeat.getTick()?.();
      expect(ping).toHaveBeenCalledTimes(1);
      expect(close).not.toHaveBeenCalled();

      now += 10_000;
      recordPong(ws);
      now += 10_000;
      heartbeat.getTick()?.();

      expect(ping).toHaveBeenCalledTimes(2);
      expect(close).not.toHaveBeenCalled();

      removeConnection(ws);
    } finally {
      nowSpy.mockRestore();
      heartbeat.restore();
    }
  });

  it("closes stale sockets and stops the heartbeat when the last connection disappears", () => {
    const originalClearInterval = globalThis.clearInterval.bind(globalThis);
    const nowSpy = spyOn(Date, "now");
    let now = 5_000;
    nowSpy.mockImplementation(() => now);
    const heartbeat = captureHeartbeatInterval();
    const clearIntervalSpy = spyOn(globalThis, "clearInterval").mockImplementation((id) => {
      originalClearInterval(id as Parameters<typeof originalClearInterval>[0]);
    });

    try {
      const ping = mock(() => {});
      const close = mock(() => {});
      const ws = { send: mock(() => {}), ping, close } as unknown as ServerWebSocket<unknown>;

      addConnection(ws);
      now += 70_000;
      heartbeat.getTick()?.();

      expect(close).toHaveBeenCalledWith(1001, "Heartbeat timeout");
      expect(clearIntervalSpy).toHaveBeenCalledTimes(1);
      expect(ping).not.toHaveBeenCalled();
    } finally {
      nowSpy.mockRestore();
      clearIntervalSpy.mockRestore();
      heartbeat.restore();
    }
  });
});
