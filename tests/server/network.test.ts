/**
 * @packageDocumentation
 * Tests for loopback TCP port probing used when starting llama-server.
 */

import { describe, expect, it } from "bun:test";
import { findFreePort } from "../../src/server/utils/network";

describe("findFreePort", () => {
  it("returns a bindable port inside the requested range", async () => {
    const port = await findFreePort(49152, 49300);
    expect(port).toBeGreaterThanOrEqual(49152);
    expect(port).toBeLessThanOrEqual(49300);

    const listener = Bun.listen({
      hostname: "127.0.0.1",
      port,
      socket: {
        data() {},
        open() {},
        close() {},
        error() {},
      },
    });
    listener.stop();
  });

  it("throws when every port in the range is occupied", async () => {
    const occupied = await findFreePort(49152, 49300);
    const listener = Bun.listen({
      hostname: "127.0.0.1",
      port: occupied,
      socket: {
        data() {},
        open() {},
        close() {},
        error() {},
      },
    });

    try {
      await expect(findFreePort(occupied, occupied)).rejects.toThrow(
        `No free ports available in range ${occupied}-${occupied}`,
      );
    } finally {
      listener.stop();
    }
  });
});
