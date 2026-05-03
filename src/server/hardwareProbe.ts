/**
 * @packageDocumentation
 * Probes the system for hardware capabilities (CPU, RAM, GPU, VRAM).
 * Uses platform-specific system calls (nvidia-smi, sysctl, system_profiler) to determine resources.
 */

import fs from "node:fs/promises";
import os from "node:os";
import type { GpuInfo, HardwareInfo } from "../shared/types";
import { spawn } from "bun";
import { loadSettings } from "./persistence/settingsRepo";

/**
 * Parses Windows WMI video controller output into descriptive-only GPU entries.
 *
 * WMI fallback data does not confirm CUDA/ROCm support, so these devices must not be
 * treated as accelerator-capable backends by downstream optimizers.
 *
 * @param rawJson - JSON returned from `Get-CimInstance Win32_VideoController | ConvertTo-Json`.
 * @returns Parsed GPU descriptions using the `unknown` backend.
 * @internal
 */
export function __parseWindowsWmiVideoControllers(rawJson: string): GpuInfo[] {
  const parsed = JSON.parse(rawJson);
  const controllers = Array.isArray(parsed) ? parsed : [parsed];
  const gpus: GpuInfo[] = [];

  for (const controller of controllers) {
    const name = controller?.Name;
    const adapterRam = Number(controller?.AdapterRAM || 0);
    if (typeof name === "string" && name.length > 0) {
      gpus.push({
        name,
        vramBytes: adapterRam > 0 ? adapterRam : 0,
        backend: "unknown",
      });
    }
  }

  return gpus;
}

/**
 * The minimum supported version constant for the external llama-server executable.
 */
export const LLAMA_SERVER_MIN_VERSION = "0.0.0" as const;

/**
 * Executes system calls to gather detailed hardware information.
 *
 * @returns A promise resolving to a {@link HardwareInfo} object containing RAM, CPU, and GPU details.
 */
export async function getHardwareInfo(): Promise<HardwareInfo> {
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
      const meminfo = await fs.readFile("/proc/meminfo", "utf-8");
      const match = meminfo.match(/MemTotal:\s+(\d+)\s+kB/);
      if (match?.[1]) {
        totalRamBytes = parseInt(match[1], 10) * 1024;
      }
    } else if (process.platform === "darwin") {
      const hwmem = await execPromise([commandPaths.sysctl, "-n", "hw.memsize"]);
      totalRamBytes = parseInt(hwmem.trim(), 10);
    } else if (process.platform === "win32") {
      const output = await execPromise([
        commandPaths.powershell,
        "-NoProfile",
        "-Command",
        "(Get-CimInstance Win32_ComputerSystem).TotalPhysicalMemory",
      ]);
      const parsed = parseInt(output.trim(), 10);
      if (!Number.isNaN(parsed)) {
        totalRamBytes = parsed;
      }
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
          "Get-CimInstance Win32_VideoController | Select-Object Name,AdapterRAM | ConvertTo-Json",
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

async function execPromise(command: string[]): Promise<string> {
  try {
    const proc = spawn(command, { stdout: "pipe", stderr: "pipe" });
    const stdout = await new Response(proc.stdout).text();
    const stderr = await new Response(proc.stderr).text();
    const exitCode = await proc.exited;

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
