/**
 * @packageDocumentation
 * Measures RAM and VRAM consumed by LlamaForge's own processes.
 *
 * System-wide GPU or RAM occupancy from unrelated applications is ignored; only
 * the Bun backend PID and the llama-server process tree are counted.
 */

import path from "node:path";
import { spawn } from "bun";
import type { AppProcessUsage } from "../shared/types";
import { getActiveGenerations } from "./generationRegistry";
import { getActiveServerPid } from "./llamaServer";
import { loadSettings } from "./persistence/settingsRepo";

/** Process-name tokens that identify llama-server in nvidia-smi / tasklist output. */
const LLAMA_SERVER_NAME_PATTERN = /llama[-_]?server/i;

/**
 * A GPU-compute process reported by nvidia-smi or Windows GPU counters.
 */
export interface GpuProcessUsage {
  /** Operating-system process identifier. */
  pid: number;
  /** Executable name when the source included one. */
  processName?: string;
  /** Used GPU memory in bytes, or `null` when the source reported `[N/A]`. */
  memoryBytes: number | null;
}

/**
 * Parses a `tasklist /FO CSV /NH` line into a working-set size in bytes.
 *
 * @param csvLine - One CSV row emitted by Windows `tasklist`.
 * @returns Working-set bytes, or `null` when the row cannot be parsed.
 */
export function parseTasklistWorkingSetBytes(csvLine: string): number | null {
  return parseTasklistRow(csvLine)?.workingSetBytes ?? null;
}

/**
 * Parses a Windows `tasklist /FO CSV /NH` row into image name, PID, and working set.
 *
 * @param csvLine - One CSV row emitted by Windows `tasklist`.
 * @returns Parsed process row, or `null` when the row cannot be parsed.
 */
export function parseTasklistRow(
  csvLine: string,
): { imageName: string; pid: number; workingSetBytes: number } | null {
  const trimmed = csvLine.trim();
  if (!trimmed) return null;
  const fields: string[] = [];
  let current = "";
  let inQuotes = false;
  for (const char of trimmed) {
    if (char === '"') {
      inQuotes = !inQuotes;
      continue;
    }
    if (char === "," && !inQuotes) {
      fields.push(current.trim());
      current = "";
      continue;
    }
    current += char;
  }
  fields.push(current.trim());
  if (fields.length < 2) return null;
  const imageName = fields[0] ?? "";
  const pid = Number.parseInt(fields[1] ?? "", 10);
  const memField = fields.at(-1);
  if (!memField || !Number.isInteger(pid) || pid <= 0) return null;
  const digits = memField.replace(/[^\d]/g, "");
  if (!digits) return null;
  const kilobytes = Number.parseInt(digits, 10);
  if (!Number.isFinite(kilobytes) || kilobytes < 0) return null;
  return { imageName, pid, workingSetBytes: kilobytes * 1024 };
}

/**
 * Parses `/proc/<pid>/status` `VmRSS` into bytes.
 *
 * @param statusText - Contents of a Linux `/proc/<pid>/status` file.
 * @returns RSS in bytes, or `null` when the field is missing.
 */
export function parseProcStatusRssBytes(statusText: string): number | null {
  const match = statusText.match(/^VmRSS:\s+(\d+)\s+kB/m);
  if (!match?.[1]) return null;
  const kilobytes = Number.parseInt(match[1], 10);
  if (!Number.isFinite(kilobytes) || kilobytes < 0) return null;
  return kilobytes * 1024;
}

/**
 * Parses a GPU-memory quantity that may include a unit suffix or `[N/A]`.
 *
 * @param raw - Memory field from nvidia-smi CSV or process table output.
 * @returns Memory in bytes, or `null` when the value is missing / not applicable.
 */
export function parseGpuMemoryBytes(raw: string): number | null {
  const trimmed = raw.trim();
  if (!trimmed || /^\[?\s*n\/a\s*\]?$/i.test(trimmed)) return null;
  const match = trimmed.match(/^([\d.,]+)\s*(GiB|MiB|KiB|GB|MB|KB)?$/i);
  if (!match?.[1]) return null;
  const amount = Number.parseFloat(match[1].replace(/,/g, ""));
  if (!Number.isFinite(amount) || amount < 0) return null;
  const unit = (match[2] ?? "MiB").toLowerCase();
  if (unit === "gib" || unit === "gb") return amount * 1024 * 1024 * 1024;
  if (unit === "kib" || unit === "kb") return amount * 1024;
  return amount * 1024 * 1024;
}

/**
 * Returns whether a process name belongs to llama-server.
 *
 * @param processName - Executable or command name.
 * @returns `true` when the name identifies llama-server.
 */
export function isLlamaServerProcessName(processName: string | undefined): boolean {
  if (!processName) return false;
  const base = path.basename(processName.replace(/\\/g, "/"));
  return LLAMA_SERVER_NAME_PATTERN.test(base);
}

/**
 * Parses `nvidia-smi --query-compute-apps=pid,used_gpu_memory` CSV into per-PID bytes.
 *
 * @param csv - Raw nvidia-smi CSV (noheader, optionally with units).
 * @returns Map of process ID to used GPU memory in bytes.
 */
export function parseNvidiaSmiComputeApps(csv: string): Map<number, number> {
  const usage = new Map<number, number>();
  for (const row of parseNvidiaSmiComputeAppRows(csv)) {
    if (row.memoryBytes === null) continue;
    usage.set(row.pid, (usage.get(row.pid) ?? 0) + row.memoryBytes);
  }
  return usage;
}

/**
 * Parses nvidia-smi compute-app CSV rows, including process names and `[N/A]` memory.
 *
 * Accepts both `pid,used_gpu_memory` and `pid,process_name,used_gpu_memory`.
 *
 * @param csv - Raw nvidia-smi CSV.
 * @returns Parsed compute-app rows.
 */
export function parseNvidiaSmiComputeAppRows(csv: string): GpuProcessUsage[] {
  const rows: GpuProcessUsage[] = [];
  for (const line of csv.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || /^pid\b/i.test(trimmed)) continue;
    const parts = trimmed.split(",").map((part) => part.trim());
    if (parts.length < 2) continue;
    const pid = Number.parseInt(parts[0] ?? "", 10);
    if (!Number.isInteger(pid) || pid <= 0) continue;
    if (parts.length >= 3) {
      const processName = parts[1];
      rows.push({
        pid,
        ...(processName !== undefined ? { processName } : {}),
        memoryBytes: parseGpuMemoryBytes(parts[parts.length - 1] ?? ""),
      });
      continue;
    }
    rows.push({
      pid,
      memoryBytes: parseGpuMemoryBytes(parts[1] ?? ""),
    });
  }
  return rows;
}

/**
 * Parses the `Processes` table from a default `nvidia-smi` text dump.
 *
 * WDDM drivers often report `[N/A]` from `--query-compute-apps` while still
 * printing a MiB value (or at least a PID) in the interactive table.
 *
 * @param text - Full `nvidia-smi` stdout.
 * @returns Parsed process rows.
 */
export function parseNvidiaSmiProcessTable(text: string): GpuProcessUsage[] {
  const rows: GpuProcessUsage[] = [];
  for (const line of text.split(/\r?\n/)) {
    if (!line.includes("|") || /GPU\s+Memory|Processes:|===/.test(line)) continue;
    const match = line.match(/\|\s*\S+\s+\S+\s+\S+\s+(\d+)\s+[CG]\s+(\S.*?)\s+([\d.,]+)\s*MiB/i);
    if (!match?.[1]) continue;
    const pid = Number.parseInt(match[1], 10);
    if (!Number.isInteger(pid) || pid <= 0) continue;
    const processName = match[2]?.trim();
    rows.push({
      pid,
      ...(processName ? { processName } : {}),
      memoryBytes: parseGpuMemoryBytes(`${match[3] ?? ""} MiB`),
    });
  }
  return rows;
}

/**
 * Parses `Get-Counter '\GPU Process Memory(*)\Local Usage'` samples formatted as
 * `pid_<id> <bytes>` lines.
 *
 * @param counterText - One process sample per line.
 * @returns Map of PID to GPU-local memory in bytes.
 */
export function parseWindowsGpuProcessMemory(counterText: string): Map<number, number> {
  const usage = new Map<number, number>();
  for (const line of counterText.split(/\r?\n/)) {
    const match = line.trim().match(/pid_(\d+)\S*\s+([\d.]+)/i);
    if (!match?.[1] || !match[2]) continue;
    const pid = Number.parseInt(match[1], 10);
    const bytes = Number.parseFloat(match[2]);
    if (!Number.isInteger(pid) || pid <= 0 || !Number.isFinite(bytes) || bytes < 0) continue;
    usage.set(pid, (usage.get(pid) ?? 0) + bytes);
  }
  return usage;
}

/**
 * Sums GPU memory for PIDs that belong to LlamaForge, including name-based matches.
 *
 * @param rows - GPU process samples.
 * @param ownedPids - Process identifiers in the LlamaForge tree.
 * @returns Attributed VRAM in bytes.
 */
export function attributeGpuMemoryBytes(rows: GpuProcessUsage[], ownedPids: Set<number>): number {
  let total = 0;
  const seen = new Set<number>();
  for (const row of rows) {
    if (seen.has(row.pid)) continue;
    const owned = ownedPids.has(row.pid) || isLlamaServerProcessName(row.processName);
    if (!owned || row.memoryBytes === null) continue;
    seen.add(row.pid);
    total += row.memoryBytes;
  }
  return total;
}

/**
 * Executes a command and returns stdout, treating launch failures as empty output.
 *
 * Stderr is drained in parallel so nvidia-smi cannot deadlock on a full pipe.
 * Non-zero exit codes still return stdout because nvidia-smi often prints a
 * usable table while exiting with a warning status.
 *
 * @param command - Executable path and arguments.
 * @param timeoutMs - Wall-clock limit before the process is killed.
 * @returns Captured standard output, or an empty string on failure.
 */
async function execQuiet(command: string[], timeoutMs = 8000): Promise<string> {
  try {
    const proc = spawn(command, {
      stdout: "pipe",
      stderr: "pipe",
      windowsHide: true,
    });
    const timeout = setTimeout(() => {
      try {
        proc.kill();
      } catch {
        // Process may have already exited.
      }
    }, timeoutMs);
    try {
      const [stdout] = await Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
        proc.exited,
      ]);
      return stdout;
    } finally {
      clearTimeout(timeout);
    }
  } catch {
    return "";
  }
}

/**
 * Reads the resident set size of a single process.
 *
 * @param pid - Target process identifier.
 * @returns RSS in bytes, or `0` when the process cannot be inspected.
 */
async function readProcessRssBytes(pid: number): Promise<number> {
  if (!Number.isInteger(pid) || pid <= 0) return 0;
  try {
    if (process.platform === "linux") {
      const status = await Bun.file(`/proc/${pid}/status`).text();
      return parseProcStatusRssBytes(status) ?? 0;
    }
    if (process.platform === "darwin") {
      const output = await execQuiet(["ps", "-o", "rss=", "-p", String(pid)]);
      const kilobytes = Number.parseInt(output.trim(), 10);
      return Number.isFinite(kilobytes) && kilobytes > 0 ? kilobytes * 1024 : 0;
    }
    const output = await execQuiet(["tasklist", "/FI", `PID eq ${pid}`, "/FO", "CSV", "/NH"]);
    for (const line of output.split(/\r?\n/)) {
      const parsed = parseTasklistRow(line);
      if (parsed !== null) return parsed.workingSetBytes;
    }
  } catch {
    // Process may have exited between sampling and inspection.
  }
  return 0;
}

/**
 * Lists direct child PIDs of a parent process.
 *
 * @param parentPid - Parent process identifier.
 * @param powershellPath - PowerShell executable used on Windows.
 * @returns Child process identifiers.
 */
async function listChildPids(parentPid: number, powershellPath: string): Promise<number[]> {
  if (process.platform === "linux") {
    try {
      const children = await Bun.file(`/proc/${parentPid}/task/${parentPid}/children`).text();
      return children
        .trim()
        .split(/\s+/)
        .map((value) => Number.parseInt(value, 10))
        .filter((pid) => Number.isInteger(pid) && pid > 0);
    } catch {
      return [];
    }
  }
  if (process.platform === "darwin") {
    const output = await execQuiet(["pgrep", "-P", String(parentPid)]);
    return output
      .split(/\s+/)
      .map((value) => Number.parseInt(value, 10))
      .filter((pid) => Number.isInteger(pid) && pid > 0);
  }

  const powershellOutput = await execQuiet([
    powershellPath,
    "-NoProfile",
    "-Command",
    `Get-CimInstance Win32_Process -Filter "ParentProcessId=${parentPid}" | Select-Object -ExpandProperty ProcessId`,
  ]);
  const fromPowershell = powershellOutput
    .split(/\s+/)
    .map((value) => Number.parseInt(value, 10))
    .filter((pid) => Number.isInteger(pid) && pid > 0);
  if (fromPowershell.length > 0) return fromPowershell;

  const output = await execQuiet([
    "wmic",
    "process",
    "where",
    `(ParentProcessId=${parentPid})`,
    "get",
    "ProcessId",
    "/VALUE",
  ]);
  const pids: number[] = [];
  for (const match of output.matchAll(/ProcessId=(\d+)/g)) {
    const pid = Number.parseInt(match[1] ?? "", 10);
    if (Number.isInteger(pid) && pid > 0) pids.push(pid);
  }
  return pids;
}

/**
 * Expands a root PID into itself plus discovered descendants.
 *
 * @param rootPid - Root process identifier.
 * @param powershellPath - PowerShell executable used on Windows.
 * @returns Unique PIDs in the process tree.
 */
async function collectProcessTree(rootPid: number, powershellPath: string): Promise<number[]> {
  const seen = new Set<number>();
  const queue = [rootPid];
  while (queue.length > 0) {
    const pid = queue.shift();
    if (pid === undefined || seen.has(pid)) continue;
    seen.add(pid);
    const children = await listChildPids(pid, powershellPath);
    for (const child of children) queue.push(child);
  }
  return [...seen];
}

/**
 * Discovers llama-server PIDs by image name so VRAM/RAM attribution does not
 * depend on a complete parent/child walk (wmic is often missing on Windows).
 *
 * @returns PIDs whose executable name matches llama-server, paired with RSS when known.
 */
async function findLlamaServerProcessesByName(): Promise<Map<number, number>> {
  const found = new Map<number, number>();
  if (process.platform === "win32") {
    const output = await execQuiet([
      "tasklist",
      "/FI",
      "IMAGENAME eq llama-server.exe",
      "/FO",
      "CSV",
      "/NH",
    ]);
    for (const line of output.split(/\r?\n/)) {
      const parsed = parseTasklistRow(line);
      if (parsed && isLlamaServerProcessName(parsed.imageName)) {
        found.set(parsed.pid, parsed.workingSetBytes);
      }
    }
    return found;
  }
  const output = await execQuiet(["pgrep", "-x", "llama-server"]);
  for (const token of output.split(/\s+/)) {
    const pid = Number.parseInt(token, 10);
    if (Number.isInteger(pid) && pid > 0) found.set(pid, 0);
  }
  return found;
}

/**
 * Queries nvidia-smi (and Windows GPU process counters) for per-process VRAM.
 *
 * @param nvidiaSmi - Path to nvidia-smi.
 * @param powershellPath - Path to PowerShell, used for WDDM GPU counters.
 * @returns GPU process samples.
 */
async function collectGpuProcessUsage(
  nvidiaSmi: string,
  powershellPath: string,
): Promise<GpuProcessUsage[]> {
  const rows: GpuProcessUsage[] = [];
  const computeCsv = await execQuiet([
    nvidiaSmi,
    "--query-compute-apps=pid,process_name,used_gpu_memory",
    "--format=csv,noheader",
  ]);
  if (computeCsv.trim()) {
    rows.push(...parseNvidiaSmiComputeAppRows(computeCsv));
  }

  const hasNumericMemory = rows.some((row) => row.memoryBytes !== null && row.memoryBytes > 0);
  if (!hasNumericMemory) {
    const table = await execQuiet([nvidiaSmi]);
    if (table.trim()) {
      rows.push(...parseNvidiaSmiProcessTable(table));
    }
  }

  if (process.platform === "win32" && !rows.some((row) => (row.memoryBytes ?? 0) > 0)) {
    const counterText = await execQuiet([
      powershellPath,
      "-NoProfile",
      "-Command",
      "$ErrorActionPreference='SilentlyContinue'; Get-Counter '\\GPU Process Memory(*)\\Local Usage' | Select-Object -ExpandProperty CounterSamples | ForEach-Object { '{0} {1}' -f $_.InstanceName, $_.CookedValue }",
    ]);
    for (const [pid, bytes] of parseWindowsGpuProcessMemory(counterText)) {
      rows.push({ pid, memoryBytes: bytes });
    }
  }

  return rows;
}

/** Cached RAM/VRAM sample reused while a generation is in flight. */
let lastProcessUsage: AppProcessUsage | null = null;
let processUsageInFlight: Promise<AppProcessUsage> | null = null;
let processUsageCachedAt = 0;
const PROCESS_USAGE_CACHE_MS = 5_000;

/**
 * Returns whether live RAM/VRAM sampling should be skipped during generation.
 *
 * nvidia-smi, tasklist, and process-tree walks contend with llama-server's
 * ffmpeg children while video is being encoded.
 *
 * @param activeGenerationCount - Number of in-flight completions.
 * @param hasSnapshot - Whether a previous sample can be reused.
 * @returns `true` when the caller should return the cached snapshot.
 */
export function shouldSkipLiveProcessSample(
  activeGenerationCount: number,
  hasSnapshot: boolean,
): boolean {
  return activeGenerationCount > 0 && hasSnapshot;
}

/**
 * Samples RAM and VRAM currently consumed by LlamaForge processes.
 *
 * @returns App-scoped process usage snapshot.
 */
export async function getAppProcessUsage(): Promise<AppProcessUsage> {
  if (
    lastProcessUsage &&
    (Date.now() - processUsageCachedAt < PROCESS_USAGE_CACHE_MS ||
      shouldSkipLiveProcessSample(getActiveGenerations().size, true))
  ) {
    return lastProcessUsage;
  }
  if (processUsageInFlight) return processUsageInFlight;
  processUsageInFlight = sampleAppProcessUsage().finally(() => {
    processUsageInFlight = null;
  });
  return processUsageInFlight;
}

/**
 * Collects a fresh process-usage sample and stores it for a few seconds.
 *
 * @returns App-scoped process usage snapshot.
 */
async function sampleAppProcessUsage(): Promise<AppProcessUsage> {
  const bunPid = process.pid;
  const llamaPid = getActiveServerPid();
  const namedLlama = await findLlamaServerProcessesByName();

  if (!llamaPid && namedLlama.size === 0) {
    lastProcessUsage = {
      ramBytes: process.memoryUsage().rss,
      vramBytes: 0,
      llamaServerPid: null,
    };
    processUsageCachedAt = Date.now();
    return lastProcessUsage;
  }

  const settings = await loadSettings();
  const powershellPath = settings.powershellPath || "powershell";
  const nvidiaSmi = settings.nvidiaSmiPath || "nvidia-smi";
  const llamaTree = llamaPid ? await collectProcessTree(llamaPid, powershellPath) : [];
  const ramPids = new Set<number>([bunPid, ...llamaTree, ...namedLlama.keys()]);
  const gpuRows = await collectGpuProcessUsage(nvidiaSmi, powershellPath);
  for (const row of gpuRows) {
    if (isLlamaServerProcessName(row.processName) || (llamaPid !== null && row.pid === llamaPid)) {
      ramPids.add(row.pid);
    }
  }

  let ramBytes = 0;
  const countedRam = new Set<number>();
  ramBytes += process.memoryUsage().rss;
  countedRam.add(bunPid);

  for (const [pid, workingSet] of namedLlama) {
    if (countedRam.has(pid)) continue;
    ramBytes += workingSet > 0 ? workingSet : await readProcessRssBytes(pid);
    countedRam.add(pid);
  }

  for (const pid of ramPids) {
    if (countedRam.has(pid)) continue;
    ramBytes += await readProcessRssBytes(pid);
    countedRam.add(pid);
  }

  const vramBytes = attributeGpuMemoryBytes(gpuRows, ramPids);

  lastProcessUsage = {
    ramBytes,
    vramBytes,
    llamaServerPid: llamaPid,
  };
  processUsageCachedAt = Date.now();
  return lastProcessUsage;
}

/**
 * Clears the cached process-usage snapshot. Intended for tests.
 *
 * @returns No return value.
 * @internal
 */
export function __resetProcessUsageCache(): void {
  lastProcessUsage = null;
  processUsageCachedAt = 0;
  processUsageInFlight = null;
}
