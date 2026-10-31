/**
 * @packageDocumentation
 * Tests for WebSocket control frames that stop in-flight generations.
 */

import { beforeEach, describe, expect, it, spyOn } from "bun:test";
import type { ServerWebSocket } from "bun";
import * as logger from "../../src/server/logger";
import * as streamProxy from "../../src/server/streamProxy";
import {
  dispatchClientFrame,
  handleClientSocketClosed,
  observeWebSocketTask,
} from "../../src/server/wsControl";
import {
  addConnection,
  clearConnections,
  getConnectionCount,
  removeConnection,
} from "../../src/server/wsHub";

describe("wsControl", () => {
  beforeEach(() => {
    clearConnections();
  });

  it("leaves generations running when another tab is still connected", async () => {
    const abortSpy = spyOn(streamProxy, "abortAllGenerations").mockImplementation(() => {});
    const first = { send: () => 0 } as unknown as ServerWebSocket<unknown>;
    const second = { send: () => 0 } as unknown as ServerWebSocket<unknown>;
    addConnection(first);
    addConnection(second);

    try {
      await dispatchClientFrame(first, JSON.stringify({ type: "session_close" }));
      expect(abortSpy).not.toHaveBeenCalled();
    } finally {
      abortSpy.mockRestore();
      removeConnection(first);
      removeConnection(second);
    }
  });

  it("aborts every generation when the client closes its session", async () => {
    const abortSpy = spyOn(streamProxy, "abortAllGenerations").mockImplementation(() => {});
    const ws = { send: () => 0 } as unknown as ServerWebSocket<unknown>;
    addConnection(ws);

    try {
      await dispatchClientFrame(ws, JSON.stringify({ type: "session_close" }));
      expect(abortSpy).toHaveBeenCalledWith("disconnected");
    } finally {
      abortSpy.mockRestore();
      removeConnection(ws);
    }
  });

  it("aborts active generations when the last socket closes", async () => {
    const abortSpy = spyOn(streamProxy, "abortAllGenerations").mockImplementation(() => {});
    const ws = { send: () => 0 } as unknown as ServerWebSocket<unknown>;
    addConnection(ws);
    removeConnection(ws);

    try {
      await handleClientSocketClosed();
      expect(abortSpy).toHaveBeenCalledWith("disconnected");
    } finally {
      abortSpy.mockRestore();
    }
  });

  it("does not resolve tool approvals from a WebSocket frame", async () => {
    const tools = await import("../../src/server/tools");
    const resolveSpy = spyOn(tools, "resolveToolApproval").mockReturnValue("resolved");
    const ws = { send: () => 0 } as unknown as ServerWebSocket<unknown>;
    addConnection(ws);
    try {
      await dispatchClientFrame(
        ws,
        JSON.stringify({
          type: "tool_approval",
          chatId: "chat-1",
          toolCallId: "call-1",
          approved: true,
        }),
      );
      expect(resolveSpy).not.toHaveBeenCalled();
    } finally {
      resolveSpy.mockRestore();
      removeConnection(ws);
    }
  });

  it("logs a frame that throws and leaves the socket open", async () => {
    const abortSpy = spyOn(streamProxy, "abortGeneration").mockImplementation(() => {
      throw new Error("frame failed");
    });
    const logSpy = spyOn(logger, "logError").mockImplementation(() => {});
    const ws = { send: () => 0 } as unknown as ServerWebSocket<unknown>;
    addConnection(ws);

    try {
      observeWebSocketTask(
        dispatchClientFrame(ws, JSON.stringify({ type: "cancel", chatId: "chat-1" })),
      );
      const deadline = Date.now() + 1_000;
      while (logSpy.mock.calls.length === 0 && Date.now() < deadline) {
        await Bun.sleep(10);
      }
      expect(logSpy).toHaveBeenCalledWith("WebSocket frame handling failed", expect.any(Error));
      expect(getConnectionCount()).toBe(1);
    } finally {
      abortSpy.mockRestore();
      logSpy.mockRestore();
      removeConnection(ws);
    }
  });

  it("leaves a generation running when another socket is still connected", async () => {
    const abortSpy = spyOn(streamProxy, "abortAllGenerations").mockImplementation(() => {});
    const first = { send: () => 0 } as unknown as ServerWebSocket<unknown>;
    const second = { send: () => 0 } as unknown as ServerWebSocket<unknown>;
    addConnection(first);
    addConnection(second);
    removeConnection(first);

    try {
      await handleClientSocketClosed();
      expect(abortSpy).not.toHaveBeenCalled();
    } finally {
      abortSpy.mockRestore();
      removeConnection(second);
    }
  });
});
