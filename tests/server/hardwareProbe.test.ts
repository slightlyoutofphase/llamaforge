/**
 * @packageDocumentation
 * Tests for hardware probing and system capability detection.
 */

import { describe, expect, it } from "bun:test";
import { getHardwareInfo } from "../../src/server/hardwareProbe";

describe("hardwareProbe", () => {
  it("returns initialized hardware structure with valid numbers", async () => {
    const hw = await getHardwareInfo();

    expect(hw.totalRamBytes).toBeGreaterThan(0);
    expect(hw.cpuThreads).toBeGreaterThan(0);

    expect(Array.isArray(hw.gpus)).toBe(true);
    for (const gpu of hw.gpus) {
      expect(typeof gpu.name).toBe("string");
      expect(gpu.vramBytes).toBeGreaterThan(0);
      expect(["cuda", "metal", "rocm", "vulkan", "cpu"]).toContain(gpu.backend);
    }
  });
});
