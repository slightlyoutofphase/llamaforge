/**
 * @packageDocumentation
 * Probes the system for hardware capabilities (CPU, RAM, GPU, VRAM).
 * Uses platform-specific system calls (nvidia-smi, sysctl, system_profiler) to determine resources.
 */

import os from "node:os";
import type { GpuInfo, HardwareInfo } from "../shared/types";
import { spawn } from "bun";
import { loadSettings } from "./persistence/settingsRepo";

/**
 * Reads a WMI memory field, including values that wrapped through a signed 32-bit integer.
 *
 * @param value - Raw JSON number from `AdapterRAM` or `qwMemorySize`.
 * @returns A non-negative byte count.
 */
function readWmiMemoryBytes(value: unknown): number {
  const numeric = Number(value ?? 0);
  if (!Number.isFinite(numeric)) return 0;
  if (numeric < 0) return numeric + 4294967296;
  return numeric;
}

/**
 * Parses Windows WMI video controller output into descriptive-only GPU entries.
 *
 * `qwMemorySize` is the 64-bit registry value. It replaces `AdapterRAM` when it
 * is larger, because that WMI field is a 32-bit quantity and saturates at 4 GB.
 * WMI fallback data does not confirm CUDA/ROCm support, so these devices must not be
 * treated as accelerator-capable backends by downstream optimizers.
 *
 * @param rawJson - JSON returned from the video-controller probe.
 * @returns Parsed GPU descriptions using the `unknown` backend.
 * @internal
 */
export function __parseWindowsWmiVideoControllers(rawJson: string): GpuInfo[] {
  const parsed = JSON.parse(rawJson);
  const controllers = Array.isArray(parsed) ? parsed : [parsed];
  const gpus: GpuInfo[] = [];

  for (const controller of controllers) {
    const name = controller?.Name;
    const adapterRam = readWmiMemoryBytes(controller?.AdapterRAM);
    const qword = readWmiMemoryBytes(controller?.qwMemorySize);
    const vramBytes = Math.max(adapterRam, qword);
    if (typeof name === "string" && name.length > 0) {
      gpus.push({
        name,
        vramBytes,
        backend: "unknown",
      });
    }
  }

  return gpus;
}

let hardwareCache: { expiresAt: number; value: HardwareInfo } | null = null;
let hardwareInFlight: Promise<HardwareInfo> | null = null;
const HARDWARE_CACHE_MS = 60_000;

/**
 * Returns hardware details, reusing a recent probe and coalescing overlapping calls.
 *
 * @returns A promise resolving to a {@link HardwareInfo} object containing RAM, CPU, and GPU details.
 */
export async function getHardwareInfo(): Promise<HardwareInfo> {
  const now = Date.now();
  if (hardwareCache && hardwareCache.expiresAt > now) return hardwareCache.value;
  if (hardwareInFlight) return hardwareInFlight;
  hardwareInFlight = collectHardwareInfo()
    .then((value) => {
      hardwareCache = { expiresAt: Date.now() + HARDWARE_CACHE_MS, value };
      return value;
    })
    .finally(() => {
      hardwareInFlight = null;
    });
  return hardwareInFlight;
}

/**
 * Executes system calls to gather detailed hardware information.
 *
 * @returns A promise resolving to a {@link HardwareInfo} object containing RAM, CPU, and GPU details.
 */
async function collectHardwareInfo(): Promise<HardwareInfo> {
  const settings = await loadSettings();
  const commandPaths = {
    nvidiaSmi: settings.nvidiaSmiPath || "nvidia-smi",
    rocmSmi: settings.rocmSmiPath || "rocm-smi",
    sysctl: settings.sysctlPath || "sysctl",
    systemProfiler: settings.systemProfilerPath || "system_profiler",
    powershell: settings.powershellPath || "powershell",
  };

  let totalRamBytes = os.totalmem();
  try {
    if (process.platform === "linux") {
      const meminfo = await Bun.file("/proc/meminfo").text();
      const match = meminfo.match(/MemTotal:\s+(\d+)\s+kB/);
      if (match?.[1]) {
        totalRamBytes = parseInt(match[1], 10) * 1024;
      }
    } else if (process.platform === "darwin") {
      const hwmem = await execPromise([commandPaths.sysctl, "-n", "hw.memsize"]);
      totalRamBytes = parseInt(hwmem.trim(), 10);
    }
  } catch {
    // fallback to os.totalmem()
  }
  const cpuThreads = os.cpus()?.length || 4; // safe fallback

  const gpus: GpuInfo[] = [];

  if (process.platform === "win32" || process.platform === "linux") {
    // Try nvidia-smi
    let hasNvidia = false;
    try {
      const output = await execPromise([
        commandPaths.nvidiaSmi,
        "--query-gpu=memory.total,name",
        "--format=csv,noheader",
      ]);
      const lines = output.trim().split("\n");
      for (const line of lines) {
        if (!line.trim()) continue;
        const parts = line.split(",");
        if (parts.length >= 2) {
          let memStr = parts[0]?.trim();
          const name = parts[1]?.trim();
          if (memStr?.endsWith("MiB")) {
            memStr = memStr.replace(/MiB$/, "").trim();
          }
          if (memStr && name) {
            const vramMb = Number.parseFloat(memStr);
            if (!Number.isNaN(vramMb)) {
              gpus.push({
                name,
                vramBytes: vramMb * 1024 * 1024,
                backend: "cuda",
              });
              hasNvidia = true;
            }
          }
        }
      }
    } catch {
      // Ignore
    }

    if (!hasNvidia) {
      // Try rocm-smi
      try {
        const output = await execPromise([commandPaths.rocmSmi, "--showmeminfo", "vram", "--json"]);
        const parsed = JSON.parse(output);
        for (const key of Object.keys(parsed)) {
          if (key.startsWith("card")) {
            const card = parsed[key];
            const vramUsed = Number.parseFloat(card["VRAM Total Memory (B)"] || "0");
            if (vramUsed > 0) {
              gpus.push({
                name: `AMD Radeon (${key})`,
                vramBytes: vramUsed,
                backend: "rocm",
              });
            }
          }
        }
      } catch {
        // Ignore
      }
    }

    if (!hasNvidia && process.platform === "win32" && gpus.length === 0) {
      try {
        const psOutput = await execPromise([
          commandPaths.powershell,
          "-NoProfile",
          "-Command",
          "$controllers = Get-CimInstance Win32_VideoController; $results = foreach ($ctrl in $controllers) { $ram = 0L; if ($null -ne $ctrl.AdapterRAM) { $ram = [int64]$ctrl.AdapterRAM }; if ($ram -lt 0) { $ram = $ram + 4294967296 }; $qword = 0L; $classRoot = 'HKLM:\\SYSTEM\\CurrentControlSet\\Control\\Class\\{4d36e968-e325-11ce-bfc1-08002be10318}'; if (Test-Path -LiteralPath $classRoot) { foreach ($key in (Get-ChildItem -LiteralPath $classRoot -ErrorAction SilentlyContinue)) { $props = Get-ItemProperty -LiteralPath $key.PSPath -ErrorAction SilentlyContinue; if (-not $props) { continue }; if ([string]$props.DriverDesc -ne [string]$ctrl.Name) { continue }; $value = $props.'HardwareInformation.qwMemorySize'; if ($null -eq $value) { continue }; $parsed = 0L; if ($value -is [byte[]] -and $value.Length -ge 8) { $parsed = [int64]([BitConverter]::ToUInt64([byte[]]$value, 0)) } else { $parsed = [int64]$value }; if ($parsed -gt $qword) { $qword = $parsed } } }; if ($qword -gt $ram) { $ram = $qword }; [PSCustomObject]@{ Name = $ctrl.Name; AdapterRAM = $ram; qwMemorySize = $qword } }; $results | ConvertTo-Json -Compress",
        ]);
        gpus.push(...__parseWindowsWmiVideoControllers(psOutput));
      } catch {
        // Ignore Windows WMI fallback errors.
      }
    }
  } else if (process.platform === "darwin") {
    // Mac Metal unified memory
    try {
      const output = await execPromise([commandPaths.systemProfiler, "SPDisplaysDataType"]);
      const nameMatch = output.match(/Chipset Model:\s*(.+)/);
      const name = nameMatch?.[1]?.trim() || "Apple Metal GPU";
      // MacOS normally allocates ~75% of RAM for Metal unified memory
      gpus.push({
        name,
        vramBytes: Math.floor(totalRamBytes * 0.75),
        backend: "metal",
      });
    } catch {
      gpus.push({
        name: "Apple Metal GPU",
        vramBytes: Math.floor(totalRamBytes * 0.75),
        backend: "metal",
      });
    }
  }

  return {
    totalRamBytes,
    cpuThreads,
    gpus,
  };
}

/**
 * Executes a system command and returns its standard output as text.
 *
 * @param command - Executable path and arguments to launch.
 * @returns Captured standard output text.
 * @throws {Error} If the command exits non-zero or the executable cannot be found.
 */
async function execPromise(command: string[]): Promise<string> {
  try {
    const proc = spawn(command, { stdout: "pipe", stderr: "pipe" });
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);

    if (exitCode !== 0) {
      throw new Error(`Command ${command[0]} exited with code ${exitCode}. Stderr: ${stderr}`);
    }
    return stdout;
  } catch (e: unknown) {
    if (e instanceof Error && "code" in e && e.code === "ENOENT") {
      throw new Error(`Command not found: ${command[0]}`);
    }
    throw e;
  }
}
