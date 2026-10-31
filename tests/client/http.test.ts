/**
 * @packageDocumentation
 * Tests for the client HTTP helper timeout and abort behavior.
 */

import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import { asFetch } from "../fixtures";

describe("client http request helper", () => {
  const originalFetch = globalThis.fetch;
  const originalXmlHttpRequest = globalThis.XMLHttpRequest;

  beforeEach(() => {
    mock.restore();
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    globalThis.XMLHttpRequest = originalXmlHttpRequest;
    mock.restore();
  });

  it("uses fetch for POST requests even when XMLHttpRequest exists", async () => {
    let xhrConstructed = false;
    globalThis.XMLHttpRequest = class {
      constructor() {
        xhrConstructed = true;
      }
    } as unknown as typeof XMLHttpRequest;

    const fetchMock = mock(async () => new Response(JSON.stringify({ ok: true }), { status: 200 }));
    globalThis.fetch = asFetch(fetchMock);

    const { request } = await import(`../../src/client/http.ts?cachebust=${Date.now()}`);
    const res = await request("/api/chats", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "Fetch Path" }),
    });

    expect(res.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(xhrConstructed).toBe(false);
  });

  it("surfaces the server error text from a failed preset update", async () => {
    const fetchMock = mock(async () => {
      return new Response(JSON.stringify({ error: "must be >= 1" }), {
        status: 400,
        headers: { "Content-Type": "application/json" },
      });
    });
    globalThis.fetch = asFetch(fetchMock);
    const { updateLoadPreset } = await import(`../../src/client/api.ts?cachebust=${Date.now()}`);
    await expect(updateLoadPreset("preset-1", { name: "Broken" })).rejects.toThrow("must be >= 1");
  });

  it("rejects with TimeoutError when fetch exceeds the timeout budget", async () => {
    const fetchMock = mock(
      (_input: RequestInfo | URL, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          const signal = init?.signal;
          signal?.addEventListener(
            "abort",
            () => {
              reject(signal.reason ?? new DOMException("Aborted", "AbortError"));
            },
            { once: true },
          );
        }),
    );
    globalThis.fetch = asFetch(fetchMock);

    const { request } = await import(`../../src/client/http.ts?cachebust=${Date.now()}`);

    await expect(request("/api/chats", { method: "POST", timeoutMs: 20 })).rejects.toMatchObject({
      name: "TimeoutError",
      message: "Request timed out after 20ms",
    });
  });

  it("rejects with AbortError when the caller aborts the request", async () => {
    const fetchMock = mock(
      (_input: RequestInfo | URL, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          const signal = init?.signal;
          signal?.addEventListener(
            "abort",
            () => {
              reject(signal.reason ?? new DOMException("Aborted", "AbortError"));
            },
            { once: true },
          );
        }),
    );
    globalThis.fetch = asFetch(fetchMock);

    const { request } = await import(`../../src/client/http.ts?cachebust=${Date.now()}`);
    const controller = new AbortController();

    const pending = request("/api/chats", {
      method: "POST",
      timeoutMs: 1000,
      signal: controller.signal,
    });

    controller.abort();

    await expect(pending).rejects.toMatchObject({
      name: "AbortError",
      message: "Request aborted",
    });
  });
});
