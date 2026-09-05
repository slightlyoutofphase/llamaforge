/**
 * @packageDocumentation
 * Tests for shared tool-module name validation and persistable copies.
 */

import { describe, expect, it } from "bun:test";
import { isValidToolName, toStoredToolDefinition } from "../../src/shared/toolModule";

describe("toolModule", () => {
  it("accepts OpenAI-style function names", () => {
    expect(isValidToolName("get_datetime")).toBe(true);
    expect(isValidToolName("echo_text")).toBe(true);
    expect(isValidToolName("Calculate")).toBe(true);
  });

  it("rejects empty, spaced, and overly long names", () => {
    expect(isValidToolName("")).toBe(false);
    expect(isValidToolName("echo-text")).toBe(false);
    expect(isValidToolName("1echo")).toBe(false);
    expect(isValidToolName("a".repeat(65))).toBe(false);
  });

  it("strips non-schema fields when storing a tool on a preset", () => {
    const stored = toStoredToolDefinition({
      name: "echo_text",
      description: "Echo",
      parameters: { type: "object", properties: {} },
      source: "user",
      fileName: "echo_text.ts",
    } as unknown as { name: string; description: string; parameters: Record<string, unknown> });
    expect(stored).toEqual({
      name: "echo_text",
      description: "Echo",
      parameters: { type: "object", properties: {} },
    });
    expect("source" in stored).toBe(false);
  });
});
