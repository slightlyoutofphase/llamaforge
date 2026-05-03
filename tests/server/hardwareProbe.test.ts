/**
 * @packageDocumentation
 * Tests for hardware probing and system capability detection.
 */

import { describe, expect, it } from "bun:test";
import { __parseWindowsWmiVideoControllers, getHardwareInfo } from "../../src/server/hardwareProbe";

describe("hardwareProbe", () => {
  it("returns initialized hardware structure with valid numbers", async () => {
    const hw = await getHardwareInfo();

    expect(hw.totalRamBytes).toBeGreaterThan(0);
    expect(hw.cpuThreads).toBeGreaterThan(0);

    expect(Array.isArray(hw.gpus)).toBe(true);
    for (const gpu of hw.gpus) {
      expect(typeof gpu.name).toBe("string");
      expect(gpu.vramBytes).toBeGreaterThan(0);
      expect(["cuda", "metal", "rocm", "vulkan", "cpu", "unknown"]).toContain(gpu.backend);
    }
  });

  it("classifies WMI video controller fallback entries as unknown backends", () => {
    const gpus = __parseWindowsWmiVideoControllers(
      JSON.stringify([
        { Name: "NVIDIA GeForce RTX 4080", AdapterRAM: 17163091968 },
        { Name: "Microsoft Basic Display Adapter", AdapterRAM: 0 },
      ]),
    );

    expect(gpus).toHaveLength(2);
    expect(gpus[0]?.backend).toBe("unknown");
    expect(gpus[0]?.vramBytes).toBe(17163091968);
    expect(gpus[1]?.backend).toBe("unknown");
  });
});
