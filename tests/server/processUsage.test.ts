/**
 * @packageDocumentation
 * Tests for LlamaForge-scoped process memory parsers.
 */

import { describe, expect, it } from "bun:test";
import { initDb, resetDb } from "../../src/server/persistence/db";
import {
  __resetProcessUsageCache,
  __resetWindowsGpuCounterCache,
  __setProcessSpawnObserver,
  attributeGpuMemoryBytes,
  getAppProcessUsage,
  isLlamaServerProcessName,
  parseGpuMemoryBytes,
  parseNvidiaSmiComputeAppRows,
  parseNvidiaSmiComputeApps,
  parseNvidiaSmiProcessTable,
  parseProcStatusRssBytes,
  parseTasklistRow,
  parseTasklistWorkingSetBytes,
  parseWindowsGpuProcessMemory,
  parseWindowsProcessSnapshot,
  shouldSkipLiveProcessSample,
  summarizeWindowsProcessSnapshot,
} from "../../src/server/processUsage";

describe("processUsage parsers", () => {
  it("parses Windows tasklist working-set bytes", () => {
    const line = `"llama-server.exe","43210","Console","1","1,234,567 K"`;
    expect(parseTasklistWorkingSetBytes(line)).toBe(1234567 * 1024);
    expect(parseTasklistRow(line)).toEqual({
      imageName: "llama-server.exe",
      pid: 43210,
      workingSetBytes: 1234567 * 1024,
    });
  });

  it("parses Linux VmRSS from /proc status", () => {
    const status = [
      "Name: llama-server",
      "Pid: 99",
      "VmRSS:    204800 kB",
      "VmSize:  1000000 kB",
    ].join("\n");
    expect(parseProcStatusRssBytes(status)).toBe(204800 * 1024);
  });

  it("attributes nvidia-smi compute-app memory to matching PIDs only", () => {
    const csv = ["43210, 512", "99, 2048", "not-a-pid, 1"].join("\n");
    const usage = parseNvidiaSmiComputeApps(csv);
    expect(usage.get(43210)).toBe(512 * 1024 * 1024);
    expect(usage.get(99)).toBe(2048 * 1024 * 1024);
    expect(usage.has(NaN)).toBe(false);
  });

  it("parses compute-app rows with process names and N/A memory", () => {
    const csv = [
      "pid, process_name, used_gpu_memory",
      "43210, llama-server.exe, 8192 MiB",
      "99, chrome.exe, [N/A]",
    ].join("\n");
    const rows = parseNvidiaSmiComputeAppRows(csv);
    expect(rows[0]).toEqual({
      pid: 43210,
      processName: "llama-server.exe",
      memoryBytes: 8192 * 1024 * 1024,
    });
    expect(rows[1]?.memoryBytes).toBeNull();
  });

  it("parses nvidia-smi process table rows and Windows GPU counters", () => {
    const table = [
      "| NVIDIA-SMI 560.00 |",
      "| Processes:                                                              |",
      "|  GPU   GI   CI        PID   Type   Process name              GPU Memory |",
      "|=========================================================================|",
      "|    0   N/A  N/A      43210      C   llama-server.exe            4096MiB |",
    ].join("\n");
    const rows = parseNvidiaSmiProcessTable(table);
    expect(rows[0]?.pid).toBe(43210);
    expect(rows[0]?.memoryBytes).toBe(4096 * 1024 * 1024);
    expect(isLlamaServerProcessName(rows[0]?.processName)).toBe(true);

    const counters = parseWindowsGpuProcessMemory("pid_43210_luid_0x0 2147483648\npid_99 12");
    expect(counters.get(43210)).toBe(2147483648);
  });

  it("attributes VRAM by PID tree or llama-server process name", () => {
    const rows = [
      { pid: 11, processName: "chrome.exe", memoryBytes: 1024 * 1024 * 1024 },
      {
        pid: 22,
        processName: "C:\\\\bin\\\\llama-server.exe",
        memoryBytes: 8 * 1024 * 1024 * 1024,
      },
      { pid: 33, processName: "python.exe", memoryBytes: 2 * 1024 * 1024 * 1024 },
    ];
    expect(attributeGpuMemoryBytes(rows, new Set([33]))).toBe(10 * 1024 * 1024 * 1024);
    expect(parseGpuMemoryBytes("[N/A]")).toBeNull();
    expect(parseGpuMemoryBytes("1.5 GiB")).toBe(1.5 * 1024 * 1024 * 1024);
  });

  it("builds a Windows process tree and totals from one CIM snapshot", () => {
    const json = JSON.stringify([
      { ProcessId: 10, ParentProcessId: 1, Name: "bun.exe", WorkingSetSize: 1000 },
      { ProcessId: 20, ParentProcessId: 10, Name: "llama-server.exe", WorkingSetSize: 5000 },
      { ProcessId: 30, ParentProcessId: 20, Name: "ffmpeg.exe", WorkingSetSize: 2000 },
      { ProcessId: 40, ParentProcessId: 1, Name: "notepad.exe", WorkingSetSize: 9000 },
    ]);
    const records = parseWindowsProcessSnapshot(json);
    const summary = summarizeWindowsProcessSnapshot(records, 10);
    expect(summary.treePids).toEqual([10, 20, 30]);
    expect(summary.treeRssBytes).toBe(8000);
    expect(summary.llamaServer.get(20)).toBe(5000);
    expect(summary.llamaServer.has(40)).toBe(false);

    const single = parseWindowsProcessSnapshot(
      JSON.stringify({
        ProcessId: 7,
        ParentProcessId: 1,
        Name: "llama-server.exe",
        WorkingSetSize: 42,
      }),
    );
    expect(single).toEqual([
      { pid: 7, parentPid: 1, name: "llama-server.exe", workingSetBytes: 42 },
    ]);
  });

  it("samples Windows processes with one CIM query and no tasklist", async () => {
    if (process.platform !== "win32") return;
    await initDb(":memory:");
    __resetProcessUsageCache();
    __resetWindowsGpuCounterCache();
    const commands: string[][] = [];
    __setProcessSpawnObserver((command) => {
      commands.push([...command]);
    });
    try {
      const usage = await getAppProcessUsage();
      expect(usage.ramBytes).toBeGreaterThan(0);
      const joined = commands.map((command) => command.join(" "));
      const cim = joined.filter((command) => command.includes("Get-CimInstance Win32_Process"));
      const tasklist = commands.filter((command) =>
        (command[0] ?? "").toLowerCase().includes("tasklist"),
      );
      const wmic = commands.filter((command) => (command[0] ?? "").toLowerCase() === "wmic");
      expect(cim).toHaveLength(1);
      expect(tasklist).toHaveLength(0);
      expect(wmic).toHaveLength(0);
      const powershell = commands.filter((command) =>
        (command[0] ?? "").toLowerCase().includes("powershell"),
      );
      expect(powershell.length).toBeLessThanOrEqual(2);
    } finally {
      __setProcessSpawnObserver(null);
      __resetProcessUsageCache();
      resetDb();
    }
  }, 30_000);

  it("skips live sampling only when a generation is in flight and a snapshot exists", () => {
    expect(shouldSkipLiveProcessSample(0, true)).toBe(false);
    expect(shouldSkipLiveProcessSample(1, false)).toBe(false);
    expect(shouldSkipLiveProcessSample(1, true)).toBe(true);
  });
});
