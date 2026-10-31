/**
 * @packageDocumentation
 * Tests for logger argument formatting.
 */

import { describe, expect, it } from "bun:test";
import { formatLogArgument } from "../../src/shared/logFormat";

describe("formatLogArgument", () => {
  it("keeps an error message and stack", () => {
    const error = new Error("disk full");
    const formatted = formatLogArgument(error);
    expect(formatted).toContain("disk full");
    expect(formatted).toContain("Error");
  });

  it("marks circular objects instead of throwing", () => {
    const box: { self?: unknown } = {};
    box.self = box;
    expect(formatLogArgument(box)).toContain("[Circular]");
  });
});
