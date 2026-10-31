/**
 * @packageDocumentation
 * Tests for tool schema generation and response parsing utilities.
 */

import { afterAll, afterEach, beforeAll, describe, expect, it } from "bun:test";
import calculateTool, {
  __armCalculateWorkerDelay,
  resolveCalculateWorkerUrl,
  shutdownCalculateWorker,
} from "../../src/server/builtinTools/calculate";
import { generateGrammarFromSchema } from "../../src/server/tools";

describe("tools", () => {
  afterEach(() => {
    const {
      __setToolApprovalTimeoutMs,
      cancelPendingApprovals,
    } = require("../../src/server/tools");
    __setToolApprovalTimeoutMs(120000);
    cancelPendingApprovals();
  });

  it("generates a valid gbnf string for simple types", () => {
    const schema = {
      type: "object",
      properties: {
        location: { type: "string" },
      },
      required: ["location"],
    };
    const gbnf = generateGrammarFromSchema(schema);
    expect(typeof gbnf).toBe("string");
    expect(gbnf.length).toBeGreaterThan(0);
    expect(gbnf).toContain("root ::= ");
  });

  const { executeTool } = require("../../src/server/tools");

  beforeAll(async () => {
    const result = await executeTool("calculate", JSON.stringify({ expression: "1+1" }));
    expect(JSON.parse(result).result).toBe(2);
  }, 30_000);

  afterAll(() => {
    shutdownCalculateWorker();
  });

  it("executes get_datetime tool", async () => {
    const result = await executeTool("get_datetime", "{}");
    const parsed = JSON.parse(result);
    expect(parsed.result).toBeDefined();
    expect(new Date(parsed.result).getTime()).not.toBeNaN();
  });

  it("executes calculate tool", async () => {
    const result = await executeTool("calculate", JSON.stringify({ expression: "10 + 20 * 2" }));
    const parsed = JSON.parse(result);
    expect(parsed.result).toBe(50);
  });

  it("handles calculate tool errors", async () => {
    const result = await executeTool(
      "calculate",
      JSON.stringify({ expression: "invalid + syntax" }),
    );
    const parsed = JSON.parse(result);
    expect(parsed.error).toBeDefined();
  });

  it("returns a tool error for malformed JSON arguments instead of throwing", async () => {
    const result = await executeTool("calculate", "{not json");
    const parsed = JSON.parse(result);
    expect(parsed.error).toContain("invalid JSON");
  });

  it("returns a tool error for non-object JSON arguments", async () => {
    const result = await executeTool("calculate", "[]");
    const parsed = JSON.parse(result);
    expect(parsed.error).toContain("JSON object");
  });

  it("returns a tool error when calculate is missing an expression", async () => {
    const result = await executeTool("calculate", "{}");
    const parsed = JSON.parse(result);
    expect(parsed.error).toContain("expression");
  });

  it("resolves the calculate worker next to source and under the server bundle", () => {
    const fromSource = resolveCalculateWorkerUrl();
    expect(fromSource.pathname.replaceAll("\\", "/")).toEndWith("/builtinTools/calculateWorker.ts");

    const fromBundle = resolveCalculateWorkerUrl("file:///D:/app/dist/server/index.js");
    expect(fromBundle.pathname.replaceAll("\\", "/")).toEndWith(
      "/dist/server/builtinTools/calculateWorker.js",
    );
  });

  it("evaluates 1+1 through the calculate worker", async () => {
    await expect(calculateTool.execute({ expression: "1+1" })).resolves.toEqual({ result: 2 });
  });

  it("keeps booleans and formats matrices, complex numbers, and units", async () => {
    const comparison = JSON.parse(
      await executeTool("calculate", JSON.stringify({ expression: "1 < 2" })),
    );
    expect(comparison.result).toBe(true);

    const matrix = JSON.parse(
      await executeTool("calculate", JSON.stringify({ expression: "[[1, 2], [3, 4]]" })),
    );
    expect(typeof matrix.result).toBe("string");
    expect(matrix.result).toContain("1");
    expect(matrix.result).toContain("4");

    const complex = JSON.parse(
      await executeTool("calculate", JSON.stringify({ expression: "sqrt(-1)" })),
    );
    expect(typeof complex.result).toBe("string");
    expect(complex.error).toBeUndefined();

    const unit = JSON.parse(
      await executeTool("calculate", JSON.stringify({ expression: "2 cm + 3 cm" })),
    );
    expect(typeof unit.result).toBe("string");
    expect(unit.result.toLowerCase()).toContain("cm");
  });

  it("rejects oversized calculate expressions and allocations without blocking", async () => {
    const tooLong = JSON.parse(
      await executeTool("calculate", JSON.stringify({ expression: `1${"0".repeat(1000)}` })),
    );
    expect(tooLong.error).toContain("1,000");

    const started = Date.now();
    const hugeRange = JSON.parse(
      await executeTool("calculate", JSON.stringify({ expression: "range(0, 1e9)" })),
    );
    expect(hugeRange.error).toContain("10,000");
    expect(Date.now() - started).toBeLessThan(1_000);

    const colonRange = JSON.parse(
      await executeTool("calculate", JSON.stringify({ expression: "0:1e9" })),
    );
    expect(colonRange.error).toContain("10,000");

    const hugeZeros = JSON.parse(
      await executeTool("calculate", JSON.stringify({ expression: "zeros(1e5, 1e5)" })),
    );
    expect(hugeZeros.error).toContain("10,000");

    const recovered = JSON.parse(
      await executeTool("calculate", JSON.stringify({ expression: "1+1" })),
    );
    expect(recovered.result).toBe(2);
  });

  it("times out a stalled calculation and still evaluates the next one", async () => {
    await __armCalculateWorkerDelay(10_000);
    const started = Date.now();
    let ticks = 0;
    const timer = setInterval(() => {
      ticks += 1;
    }, 50);
    try {
      const stalled = JSON.parse(
        await executeTool("calculate", JSON.stringify({ expression: "1+1" })),
      );
      expect(stalled.error).toBe("Calculation timed out.");
      expect(Date.now() - started).toBeLessThan(4_000);
      expect(ticks).toBeGreaterThan(5);
    } finally {
      clearInterval(timer);
    }

    const recovered = JSON.parse(
      await executeTool("calculate", JSON.stringify({ expression: "1+1" })),
    );
    expect(recovered.result).toBe(2);
  }, 30_000);

  it("executes the in-repo echo_text user tool", async () => {
    const result = await executeTool("echo_text", JSON.stringify({ text: "hello from bun" }));
    const parsed = JSON.parse(result);
    expect(parsed.result).toBe("hello from bun");
  });

  it("returns a tool error for unknown tool names", async () => {
    const result = await executeTool("not_a_real_tool", "{}");
    const parsed = JSON.parse(result);
    expect(parsed.error).toContain("not found");
  });

  it("surfaces thrown errors from user tools as JSON instead of rejecting", async () => {
    const result = await executeTool("echo_text", JSON.stringify({ text: 12 }));
    const parsed = JSON.parse(result);
    expect(parsed.error).toContain("string text");
  });

  const {
    __setToolApprovalTimeoutMs,
    waitForToolApproval,
    resolveToolApproval,
    cancelPendingApprovals,
  } = require("../../src/server/tools");

  it("handles tool approval routing securely", async () => {
    const approvalPromise = waitForToolApproval("chat-123", "call-456");

    // Unrelated cancel should not affect it
    cancelPendingApprovals("chat-999");

    // Proper resolution
    resolveToolApproval("call-456", true, '{"edited":true}');

    const result = await approvalPromise;
    expect(result.approved).toBe(true);
    expect(result.editedArguments).toBe('{"edited":true}');
  });

  it("handles pending tool cancellations by chat ID", async () => {
    const approvalPromise = waitForToolApproval("chat-111", "call-888");
    cancelPendingApprovals("chat-111");

    const result = await approvalPromise;
    expect(result.approved).toBe(false);
    expect(result.editedArguments).toBeUndefined();
  });

  it("handles global pending tool cancellations", async () => {
    const p1 = waitForToolApproval("c1", "t1");
    const p2 = waitForToolApproval("c2", "t2");

    cancelPendingApprovals(); // No ID = clear all

    const r1 = await p1;
    const r2 = await p2;
    expect(r1.approved).toBe(false);
    expect(r2.approved).toBe(false);
  });

  it("times out delayed tool approvals", async () => {
    __setToolApprovalTimeoutMs(20);

    const result = await waitForToolApproval("chat-timeout", "tool-timeout");
    expect(result.approved).toBe(false);
    expect(result.reason).toBe("timeout");
  });

  it("surfaces rejected tool approvals explicitly", async () => {
    const approvalPromise = waitForToolApproval("chat-reject", "tool-reject");
    resolveToolApproval("tool-reject", false);

    const result = await approvalPromise;
    expect(result.approved).toBe(false);
    expect(result.reason).toBe("rejected");
  });

  it("clears pending approvals when the client disconnects", async () => {
    const approvalPromise = waitForToolApproval("chat-disconnect", "tool-disconnect");
    cancelPendingApprovals(undefined, "disconnected");

    const result = await approvalPromise;
    expect(result.approved).toBe(false);
    expect(result.reason).toBe("disconnected");
  });

  it("clears pending approvals when the model unloads", async () => {
    const approvalPromise = waitForToolApproval("chat-unload", "tool-unload");
    cancelPendingApprovals(undefined, "unloaded");

    const result = await approvalPromise;
    expect(result.approved).toBe(false);
    expect(result.reason).toBe("unloaded");
  });
});
