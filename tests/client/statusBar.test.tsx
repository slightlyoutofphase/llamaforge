/**
 * @packageDocumentation
 * Tests for status-bar context occupancy display across chat and generation states.
 */

import { describe, expect, it } from "bun:test";
import { resolveContextDisplay } from "../../src/client/components/StatusBar";
import { createDefaultLoadConfig } from "../../src/shared/defaults";
import type { ModelLoadConfig } from "../../src/shared/types";

const loaded: ModelLoadConfig = { ...createDefaultLoadConfig("/m.gguf"), contextSize: 8192 };

describe("resolveContextDisplay", () => {
  it("uses the selected conversation occupancy when idle", () => {
    const result = resolveContextDisplay(
      { usedTokens: 321, contextSize: 4096 },
      null,
      loaded,
      false,
    );
    expect(result.used).toBe(321);
    expect(result.total).toBe(8192);
  });

  it("tracks live generation tokens instead of the previous chat snapshot", () => {
    const result = resolveContextDisplay(
      { usedTokens: 10, contextSize: 8192 },
      { promptTokens: 400, totalPredicted: 25, contextSize: 8192 },
      loaded,
      true,
    );
    expect(result.used).toBe(425);
    expect(result.total).toBe(8192);
  });

  it("clears to zero used when no chat is measured", () => {
    const result = resolveContextDisplay(null, null, null, false);
    expect(result.used).toBe(0);
    expect(result.total).toBeNull();
  });
});
