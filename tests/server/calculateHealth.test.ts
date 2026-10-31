/**
 * @packageDocumentation
 * Confirms the HTTP server still answers while the calculator worker rejects an oversized expression.
 */

import { afterEach, describe, expect, it } from "bun:test";
import { serve } from "bun";
import calculateTool from "../../src/server/builtinTools/calculate";
import { shutdownCalculateWorker } from "../../src/server/builtinTools/calculate";
import { createRouter } from "../../src/server/router";
import { initDb, resetDb } from "../../src/server/persistence/db";
import { bunNativeFetch } from "../happy-setup";

describe("calculate and /health", () => {
  let server: ReturnType<typeof serve> | null = null;

  afterEach(() => {
    shutdownCalculateWorker();
    server?.stop(true);
    server = null;
    resetDb();
  });

  it("answers /health while an oversized expression is rejected", async () => {
    await initDb(":memory:");
    const router = createRouter();
    server = serve({
      port: 0,
      hostname: "127.0.0.1",
      idleTimeout: 0,
      fetch: router.fetch,
      websocket: router.websocket,
    });

    await expect(calculateTool.execute({ expression: "1+1" })).resolves.toEqual({ result: 2 });

    const started = Date.now();
    const rejected = expect(calculateTool.execute({ expression: "range(0, 1e9)" })).rejects.toThrow(
      /10,000/,
    );
    const health = await bunNativeFetch(`http://127.0.0.1:${server.port}/health`);
    expect(health.status).toBe(200);
    expect(await health.text()).toBe("OK");
    await rejected;
    expect(Date.now() - started).toBeLessThan(1_000);

    const after = await bunNativeFetch(`http://127.0.0.1:${server.port}/health`);
    expect(after.status).toBe(200);
  }, 30_000);
});
