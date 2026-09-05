/**
 * @packageDocumentation
 * Tests for tool schema generation and response parsing utilities.
 */

import { afterEach, describe, expect, it } from "bun:test";
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
