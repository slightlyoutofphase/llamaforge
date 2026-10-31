/**
 * @packageDocumentation
 * Tests for WebSocket control frames that stop in-flight generations.
 */

import { beforeEach, describe, expect, it, spyOn } from "bun:test";
import type { ServerWebSocket } from "bun";
import * as streamProxy from "../../src/server/streamProxy";
import { dispatchClientFrame, handleClientSocketClosed } from "../../src/server/wsControl";
import { addConnection, clearConnections, removeConnection } from "../../src/server/wsHub";

describe("wsControl", () => {
  beforeEach(() => {
    clearConnections();
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
