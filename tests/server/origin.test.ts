/**
 * @packageDocumentation
 * Tests for Origin / Host CSRF guards used by the HTTP and WebSocket routers.
 */

import { describe, expect, it } from "bun:test";
import {
  isAllowedMutationOrigin,
  isAllowedWebSocketOrigin,
  isLoopbackHostname,
} from "../../src/server/origin";

describe("origin checks", () => {
  it("treats localhost and loopback addresses as loopback", () => {
    expect(isLoopbackHostname("localhost")).toBe(true);
    expect(isLoopbackHostname("127.0.0.1")).toBe(true);
    expect(isLoopbackHostname("::1")).toBe(true);
    expect(isLoopbackHostname("evil.example")).toBe(false);
  });

  it("allows missing Origin on mutating loopback requests used by tests and curl", () => {
    const req = new Request("http://localhost/api/chats", { method: "POST" });
    expect(isAllowedMutationOrigin(req)).toBe(true);
  });

  it("rejects mutating requests from a third-party website", () => {
    const req = new Request("http://127.0.0.1:11435/api/chats", {
      method: "POST",
      headers: { Origin: "https://evil.example" },
    });
    expect(isAllowedMutationOrigin(req)).toBe(false);
  });

  it("requires Origin on WebSocket upgrades", () => {
    const missing = new Request("http://localhost/ws");
    expect(isAllowedWebSocketOrigin(missing)).toBe(false);

    const local = new Request("http://localhost/ws", {
      headers: { Origin: "http://127.0.0.1:3000" },
    });
    expect(isAllowedWebSocketOrigin(local)).toBe(true);

    const remote = new Request("http://localhost/ws", {
      headers: { Origin: "https://evil.example" },
    });
    expect(isAllowedWebSocketOrigin(remote)).toBe(false);
  });
});
