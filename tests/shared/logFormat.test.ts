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

  it("prints a repeated sibling reference in full", () => {
    const shared = { n: 1 };
    const formatted = formatLogArgument({ a: shared, b: shared });
    expect(formatted).not.toContain("[Circular]");
    const parsed = JSON.parse(formatted) as { a: { n: number }; b: { n: number } };
    expect(parsed.a).toEqual({ n: 1 });
    expect(parsed.b).toEqual({ n: 1 });
  });
});
