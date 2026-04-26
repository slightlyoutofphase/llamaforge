/**
 * @packageDocumentation
 * Tests for websocket hub broadcast and connection lifecycle.
 */

import { describe, expect, it, mock } from "bun:test";
import type { ServerWebSocket } from "bun";
import {
  addConnection,
  broadcast,
  broadcastLog,
  broadcastStatus,
  removeConnection,
} from "../../src/server/wsHub";

describe("wsHub", () => {
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
});
