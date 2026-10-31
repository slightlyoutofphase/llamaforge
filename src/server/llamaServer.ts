/**
 * @packageDocumentation
 * Llama server lifecycle management — spawn, unload, and switch model processes.
 */

import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { type Subprocess, spawn } from "bun";
import { clampVideoFps, DEFAULT_VIDEO_FPS } from "../shared/defaults";
import { ensureGemma4GenerationOpensThought } from "../shared/gemma4ChatTemplate";
import { applyImageTokenBatchFloor, resolveImageMinTokens } from "../shared/imageTokens";
import { isGemma4Architecture } from "../shared/thinkingTags";
import type { LlamaServerStatus, ModelLoadConfig, ThinkingTagConfig } from "../shared/types";
import { parseGgufMetadata } from "./ggufReader";
import { logDebug, logError, logInfo, logWarn, shouldEmitLog } from "./logger";
import { attachChildProcessToParentLifetime } from "./windowsLifetime";
import { getAppDataDir } from "./persistence/db";
import { findFreePort } from "./utils/network";
import { broadcastLoadProgress, broadcastLog, broadcastStatus } from "./wsHub";

let proc: Subprocess<"ignore", "pipe", "pipe"> | null = null;
/** PID of the spawned llama-server, kept until the process tree is confirmed dead. */
let activeServerPid: number | null = null;
let activePort: number | null = null;
let currentConfig: ModelLoadConfig | null = null;
let currentThinkingTagOverride: ThinkingTagConfig | undefined;
let activeTempJinjaPath: string | undefined;
let currentStatus: LlamaServerStatus = "idle";
let loadingLock = false;
let unloadPromise: Promise<void> | null = null;
// M2 fix: ring buffer for boot logs to prevent O(n) shift operations during long loads
const BOOT_LOG_CAPACITY = 1000;
let bootLogBuffer: string[] = [];
let bootLogWriteIndex = 0;

// Load-progress tracking state
let currentLoadPhase: "spawning" | "loading_weights" | "offloading" | "initializing" | "ready" =
  "spawning";
let currentLoadProgress = 0;
const loadPhaseLogCounts: Record<string, number> = {};

/**
 * Resets the load-progress tracker to its initial state.
 *
 * @returns No return value.
 */
function resetLoadProgress(): void {
  currentLoadPhase = "spawning";
  currentLoadProgress = 0;
  for (const key of Object.keys(loadPhaseLogCounts)) {
    delete loadPhaseLogCounts[key];
  }
}

/**
 * Derives a loading-phase update from a raw llama-server log line and broadcasts it.
 *
 * @param line - Log line emitted while llama-server is starting.
 * @returns No return value.
 */
function trackLoadProgressFromLog(line: string): void {
  if (currentStatus !== "loading") return;

  const lower = line.toLowerCase();
  let didChange = false;

  let candidatePhase: typeof currentLoadPhase | null = null;
  let candidateProgress = currentLoadProgress;
  if (
    lower.includes("load") &&
    (lower.includes("model") || lower.includes("tensor") || lower.includes("gguf"))
  ) {
    candidatePhase = "loading_weights";
    loadPhaseLogCounts["loading_weights"] = (loadPhaseLogCounts["loading_weights"] || 0) + 1;
    candidateProgress = Math.min(15 + loadPhaseLogCounts["loading_weights"] * 3, 50);
  } else if (
    lower.includes("offload") ||
    lower.includes("cuda") ||
    lower.includes("gpu") ||
    lower.includes("vulkan") ||
    lower.includes("metal")
  ) {
    candidatePhase = "offloading";
    loadPhaseLogCounts["offloading"] = (loadPhaseLogCounts["offloading"] || 0) + 1;
    candidateProgress = Math.min(50 + loadPhaseLogCounts["offloading"] * 3, 80);
  } else if (
    lower.includes("srv") ||
    lower.includes("http") ||
    lower.includes("server") ||
    lower.includes("listening") ||
    lower.includes("health")
  ) {
    candidatePhase = "initializing";
    loadPhaseLogCounts["initializing"] = (loadPhaseLogCounts["initializing"] || 0) + 1;
    candidateProgress = Math.min(80 + loadPhaseLogCounts["initializing"] * 3, 98);
  }

  if (candidatePhase) {
    const phaseRank = {
      spawning: 0,
      loading_weights: 1,
      offloading: 2,
      initializing: 3,
      ready: 4,
    } as const;
    const nextProgress = Math.max(currentLoadProgress, candidateProgress);
    const nextPhase =
      phaseRank[candidatePhase] >= phaseRank[currentLoadPhase] ? candidatePhase : currentLoadPhase;
    if (nextProgress !== currentLoadProgress || nextPhase !== currentLoadPhase) {
      currentLoadPhase = nextPhase;
      currentLoadProgress = nextProgress;
      didChange = true;
    }
  }

  if (didChange) {
    broadcastLoadProgress(currentLoadPhase, currentLoadProgress, line.slice(0, 200));
  }
}

/**
 * Appends a line to the in-memory boot log ring buffer.
 *
 * @param line - Log line emitted while llama-server is starting.
 * @returns No return value.
 */
function pushBootLog(line: string): void {
  if (bootLogBuffer.length < BOOT_LOG_CAPACITY) {
    bootLogBuffer.push(line);
  } else {
    bootLogBuffer[bootLogWriteIndex] = line;
  }
  bootLogWriteIndex = (bootLogWriteIndex + 1) % BOOT_LOG_CAPACITY;
}

/**
 * Returns the current boot log buffer in chronological order.
 *
 * @returns Boot log lines ordered from oldest to newest.
 */
function getBootLogs(): string[] {
  if (bootLogBuffer.length < BOOT_LOG_CAPACITY) {
    return bootLogBuffer.slice();
  }
  // Ring buffer is full: read from writeIndex (oldest) to end, then start to writeIndex
  return [...bootLogBuffer.slice(bootLogWriteIndex), ...bootLogBuffer.slice(0, bootLogWriteIndex)];
}

/**
 * Clears the buffered boot logs captured during model startup.
 *
 * @returns No return value.
 */
function clearBootLogs(): void {
  bootLogBuffer = [];
  bootLogWriteIndex = 0;
}

type ActiveReader = {
  read: () => Promise<{ done: boolean; value?: Uint8Array | undefined }>;
  cancel: () => Promise<void> | void;
};

// S9 fix: track active stream readers for cancellation on unload
const activeReaders = new Set<ActiveReader>();

/**
 * Resets the currently loaded model state back to the idle server baseline.
 *
 * @returns Snapshot of the configuration that was active before the reset.
 */
function resetLoadedModelState(): ModelLoadConfig | null {
  const configSnapshot = currentConfig;
  proc = null;
  activePort = null;
  currentConfig = null;
  currentThinkingTagOverride = undefined;
  setStatus("idle");
  return configSnapshot;
}

/**
 * Cancels any active stdout and stderr readers attached to the llama-server process.
 *
 * @returns No return value.
 */
function cancelActiveLogReaders(): void {
  for (const reader of activeReaders) {
    try {
      reader.cancel();
    } catch (_e) {
      // Ignore — reader may already be closed
    }
  }
  activeReaders.clear();
}

/**
 * Terminates a llama-server PID and its child processes.
 * Windows does not honor POSIX signals on `llama-server.exe`, so the process
 * tree is killed with `taskkill`.
 *
 * @param pid - OS process id of the spawned llama-server, or `null` when unknown.
 * @param force - When true, use SIGKILL / `taskkill /F`.
 * @returns No return value.
 */
function killProcessTree(pid: number | null, force: boolean): void {
  if (pid === null) {
    return;
  }
  if (process.platform === "win32") {
    const cmd = force
      ? ["taskkill", "/PID", String(pid), "/T", "/F"]
      : ["taskkill", "/PID", String(pid), "/T"];
    Bun.spawnSync({
      cmd,
      stdout: "ignore",
      stderr: "ignore",
      windowsHide: true,
    });
    return;
  }
  try {
    process.kill(pid, force ? "SIGKILL" : "SIGTERM");
  } catch {
    // Process already exited.
  }
}

/**
 * Synchronously kills any still-tracked llama-server process tree.
 * Used from process-exit hooks where async unload cannot run.
 *
 * @returns No return value.
 */
function killSpawnedServerSync(): void {
  if (activeServerPid === null) {
    return;
  }
  killProcessTree(activeServerPid, true);
  activeServerPid = null;
}

/**
 * Synchronously kills the tracked llama-server process tree.
 *
 * Console-close and `exit` hooks cannot wait on the async unload path.
 *
 * @returns No return value.
 */
export function killActiveModelProcessSync(): void {
  killSpawnedServerSync();
}

let exitHooksInstalled = false;

/**
 * Registers process-exit hooks so a crashed or interrupted test run cannot leave
 * llama-server.exe (or its children) listening on a local port.
 *
 * @returns No return value.
 */
function installProcessExitHooks(): void {
  if (exitHooksInstalled) {
    return;
  }
  exitHooksInstalled = true;
  process.on("exit", () => {
    killSpawnedServerSync();
  });
}

installProcessExitHooks();

/**
 * Retrieves the raw Bun subprocess instance.
 *
 * @returns The current {@link Subprocess} or null if no model is loaded.
 */
export function getProc() {
  return proc;
}

/**
 * Returns the OS PID of the active llama-server process.
 *
 * Prefers the live Bun subprocess PID and falls back to the PID retained until
 * the process tree is confirmed dead, so memory sampling still works if the
 * Subprocess handle has already been cleared.
 *
 * @returns llama-server PID, or `null` when no model process is tracked.
 */
export function getActiveServerPid(): number | null {
  return proc?.pid ?? activeServerPid;
}

/**
 * Returns the most recent llama-server log lines captured from stdout/stderr.
 * Useful when an inference request drops the transport before an HTTP response is produced.
 *
 * @param limit - Maximum number of log lines to return.
 * @returns Recent server log lines ordered from oldest to newest.
 */
export function getRecentServerLogs(limit: number = 20): string[] {
  const normalizedLimit = Number.isFinite(limit) ? Math.max(0, Math.floor(limit)) : 20;
  if (normalizedLimit === 0) {
    return [];
  }
  return getBootLogs().slice(-normalizedLimit);
}

/**
 * Updates the internal server status and broadcasts it to all connected clients.
 *
 * @param status - The new status to set.
 * @returns No return value.
 */
function setStatus(status: LlamaServerStatus): void {
  currentStatus = status;
  broadcastStatus(status);
}

/**
 * Retrieves the current status, port, and configuration of the model server.
 *
 * @returns An object containing the current status string, active port, and current model configuration.
 */
export function getServerStatus() {
  return { status: currentStatus, port: activePort, config: currentConfig };
}

/**
 * Returns the thinking tag override associated with the currently loaded model preset.
 *
 * @returns The active thinking tag override, if one was supplied at model load time.
 */
export function getActiveThinkingTagOverride(): ThinkingTagConfig | undefined {
  return currentThinkingTagOverride;
}

/**
 * Maps the load-preset GPU layer count onto llama-server's `--n-gpu-layers` value.
 *
 * The documented non-numeric values are the strings `auto` and `all`. A negative
 * slider value means every layer, so it is sent as `all` rather than `-1`.
 *
 * @param gpuLayers - Layer count from the load preset. Negative means all layers.
 * @returns The CLI argument text.
 */
function gpuLayersArgument(gpuLayers: number): string {
  if (!Number.isFinite(gpuLayers)) return "0";
  if (gpuLayers < 0) return "all";
  return String(Math.trunc(gpuLayers));
}

/**
 * Builds the CLI argument array for llama-server from a ModelLoadConfig.
 * Flags are emitted from documented llama-server options.
 * `--image-min-tokens` is always emitted alongside `--image-max-tokens` (default 70).
 * `--video-fps` is always emitted (default 4).
 * Gemma 4 receives an `n_ubatch >= n_tokens` floor; other architectures keep the
 * configured `--ubatch-size`. Gemma 4 also gets `--reasoning on` because this
 * process never passes `--reasoning`, and llama-server's implicit default is
 * `auto`. `--parallel 1` and `--no-webui` are hardcoded: this
 * app is a single-slot CLI wrapper and never serves llama-server's built-in Web UI.
 *
 * @param config - The load configuration.
 * @param port - The port to bind to.
 * @param architecture - GGUF architecture used to apply the Gemma 4 ubatch floor.
 * @returns Ordered array of CLI arguments.
 * @example
 * ```typescript
 * const args = buildArgs({ modelPath: "/path/to/model", contextSize: 2048 }, 8080);
 * ```
 */
export function buildArgs(
  config: ModelLoadConfig,
  port: number,
  architecture?: string,
): readonly string[] {
  const appRoot = getAppDataDir();
  const { batchSize, microBatchSize } = applyImageTokenBatchFloor(
    config.batchSize,
    config.microBatchSize,
    config.imageMaxTokens,
    architecture,
  );
  const args: string[] = [
    "--model",
    config.modelPath,
    "--port",
    String(port),
    "--host",
    "127.0.0.1",
    "--parallel",
    "1",
    "--no-webui",
    ...(isGemma4Architecture(architecture) ? (["--reasoning", "on"] as const) : []),
    "--ctx-size",
    String(config.contextSize),
    ...(config.contextShift ? ["--context-shift"] : ["--no-context-shift"]),
    "--n-gpu-layers",
    gpuLayersArgument(config.gpuLayers),
    "--threads",
    String(config.threads),
    ...(config.threadsBatch !== undefined ? ["--threads-batch", String(config.threadsBatch)] : []),
    "--batch-size",
    String(batchSize),
    "--ubatch-size",
    String(microBatchSize),
    ...(config.ropeScaling !== "none" ? ["--rope-scaling", config.ropeScaling] : []),
    ...(config.ropeFreqBase > 0 ? ["--rope-freq-base", String(config.ropeFreqBase)] : []),
    ...(config.ropeFreqScale > 0 ? ["--rope-freq-scale", String(config.ropeFreqScale)] : []),
    "--cache-type-k",
    config.kvCacheTypeK,
    "--cache-type-v",
    config.kvCacheTypeV,
  ];

  if (config.contBatching) {
    args.push("--cont-batching");
  } else {
    args.push("--no-cont-batching");
  }

  if (config.flashAttn) {
    args.push("--flash-attn", config.flashAttn);
  }

  if (config.swaFull) {
    args.push("--swa-full");
  }

  if (config.noKvOffload) {
    args.push("--no-kv-offload");
  } else {
    args.push("--kv-offload");
  }

  args.push("--cache-reuse", String(config.cacheReuse ?? 0));
  args.push("--ctx-checkpoints", String(config.contextCheckpoints ?? 32));

  if (config.mmProjPath) {
    args.push("--mmproj", config.mmProjPath);
  }
  if (config.mainGpu !== undefined) {
    args.push("--main-gpu", String(config.mainGpu));
  }
  if (config.tensorSplit && config.tensorSplit.length > 0) {
    args.push("--tensor-split", config.tensorSplit.join(","));
  }
  if (config.mlock && config.noMmap) {
    args.push("--load-mode", "mlock");
  } else if (config.mlock) {
    args.push("--load-mode", "mmap+mlock");
  } else if (config.noMmap) {
    args.push("--load-mode", "none");
  }
  if (config.numa !== undefined) {
    args.push("--numa", config.numa);
  }
  if (config.logLevel !== undefined) {
    args.push("--log-verbosity", String(config.logLevel));
  }
  if (config.seedOverride !== undefined) {
    args.push("--seed", String(config.seedOverride));
  }

  if (config.imageMaxTokens !== undefined) {
    args.push(
      "--image-min-tokens",
      String(resolveImageMinTokens(config.imageMaxTokens, config.imageMinTokens)),
    );
    args.push("--image-max-tokens", String(config.imageMaxTokens));
  }

  args.push("--video-fps", String(clampVideoFps(config.videoFps ?? DEFAULT_VIDEO_FPS)));

  if (config.kvUnified !== undefined) {
    args.push(config.kvUnified ? "--kv-unified" : "--no-kv-unified");
  }

  // Speculative decoding flags
  if (config.specType && config.specType !== "off") {
    args.push("--spec-type", config.specType);
    if (config.specDraftModelPath) {
      args.push("--spec-draft-model", config.specDraftModelPath);
    }
    if (config.specDraftNMax !== undefined) {
      args.push("--spec-draft-n-max", String(config.specDraftNMax));
    }
    if (config.specDraftNMin !== undefined) {
      args.push("--spec-draft-n-min", String(config.specDraftNMin));
    }
    if (config.specDraftPMin !== undefined) {
      args.push("--spec-draft-p-min", String(config.specDraftPMin));
    }
  }

  // Pass --media-path to allow local file URLs for multimodal requests
  args.push("--media-path", appRoot);

  return args;
}

/**
 * Reads `general.architecture` from a GGUF header without failing the load sequence.
 *
 * @param modelPath - Absolute path to the model being spawned.
 * @returns Architecture string when the header is readable, otherwise `undefined`.
 */
async function readModelArchitecture(modelPath: string): Promise<string | undefined> {
  try {
    const metadata = await parseGgufMetadata(modelPath);
    return metadata.architecture;
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    logDebug("Could not read GGUF architecture before spawn", { modelPath, message });
    return undefined;
  }
}

/**
 * Resolves the Jinja body written to `--chat-template-file` for this spawn.
 *
 * Load-preset overrides win. Gemma 4 also reads the GGUF template when no
 * override is set so {@link ensureGemma4GenerationOpensThought} can open a
 * thought channel on follow-up turns.
 *
 * @param config - Load configuration for this spawn.
 * @param architecture - GGUF `general.architecture`, when readable.
 * @returns Template source to write, or `undefined` to use llama-server's GGUF default.
 */
export async function resolveChatTemplateForSpawn(
  config: ModelLoadConfig,
  architecture?: string,
): Promise<string | undefined> {
  let template = config.chatTemplateContent;
  if (template === undefined && isGemma4Architecture(architecture)) {
    try {
      template = (await parseGgufMetadata(config.modelPath)).chatTemplate;
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      logWarn("Could not read Gemma 4 GGUF chat template for follow-up thinking patch", {
        modelPath: config.modelPath,
        message,
      });
    }
  }
  if (template === undefined) return undefined;
  if (isGemma4Architecture(architecture)) {
    return ensureGemma4GenerationOpensThought(template);
  }
  return template;
}

/**
 * Validates that the configured llama-server binary exists and is executable.
 *
 * @param absolutePath - Absolute path to the llama-server executable.
 * @returns A promise that resolves when the binary passes validation.
 * @throws {Error} If the target path is missing, not a file, or not executable.
 */
async function validateBinary(absolutePath: string): Promise<void> {
  logDebug("Validating binary", { path: absolutePath });
  try {
    const stats = await fs.stat(absolutePath);
    if (!stats.isFile()) {
      throw new Error(`llama-server binary path is not a file: ${absolutePath}`);
    }
    if (process.platform !== "win32" && (stats.mode & 0o111) === 0) {
      throw new Error(`llama-server binary is not executable: ${absolutePath}`);
    }
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    logError("Binary validation failed", { message });
    throw new Error(`Cannot validate llama-server binary: ${message}`);
  }
}

/**
 * Loads a model by spawning `llama-server` and waiting for the service to become healthy.
 *
 * @param config - Full model load configuration including CLI flags and options.
 * @param llamaServerBin - Absolute path to the `llama-server` executable.
 * @param minPort - Minimum port to consider when selecting a free server port.
 * @param maxPort - Maximum port to consider when selecting a free server port.
 * @param thinkingTagOverride - Optional thinking-tag override associated with the selected load preset.
 * @returns The port number where the newly spawned server is listening.
 * @throws {Error} If the server binary cannot be validated, if the model fails to load,
 *         or if the process exits or stops making progress before it is healthy.
 */
export async function loadModel(
  config: ModelLoadConfig,
  llamaServerBin: string,
  minPort: number,
  maxPort: number,
  thinkingTagOverride?: ThinkingTagConfig,
): Promise<number> {
  if (!Number.isInteger(minPort) || !Number.isInteger(maxPort) || minPort <= 0 || maxPort <= 0) {
    throw new Error("Configured llama-server port range must use positive integer values.");
  }
  if (minPort > maxPort) {
    throw new Error("Configured llama-server port range is invalid: minimum exceeds maximum.");
  }

  if (loadingLock) {
    throw new Error("Model loading in progress. Please wait.");
  }
  loadingLock = true;
  clearBootLogs();
  resetLoadProgress();
  broadcastLoadProgress("spawning", 5, "Starting model load sequence…");

  let tempJinjaPath: string | undefined;
  try {
    if (unloadPromise) {
      await unloadPromise;
    }

    logInfo("Hardware initialization", {
      arch: os.arch(),
      platform: os.platform(),
      cpus: os.cpus().length,
      totalMem: os.totalmem(),
    });
    await validateBinary(llamaServerBin);

    if (proc) {
      await unloadModel();
    }

    setStatus("loading");
    logInfo("Starting model load sequence", {
      model: config.modelPath,
      contextSize: config.contextSize,
    });
    const port = await findFreePort(minPort, maxPort);
    logDebug("Selected free port", port);

    const persistedConfig: ModelLoadConfig = { ...config };

    currentConfig = persistedConfig;
    currentThinkingTagOverride = thinkingTagOverride;
    const architecture = await readModelArchitecture(persistedConfig.modelPath);
    const args = [...buildArgs(persistedConfig, port, architecture)];
    const templateToLoad = await resolveChatTemplateForSpawn(persistedConfig, architecture);
    if (templateToLoad !== undefined) {
      tempJinjaPath = path.join(os.tmpdir(), `llamaforge-chat-template-${Date.now()}.jinja`);
      await Bun.write(tempJinjaPath, templateToLoad);
      args.push("--chat-template-file", tempJinjaPath);
    }
    activeTempJinjaPath = tempJinjaPath;
    logInfo("Spawning llama-server", { command: llamaServerBin });

    const fullCmd = [llamaServerBin, ...args];
    logInfo("Executing llama-server", { command: fullCmd.join(" ") });

    proc = spawn({
      cmd: fullCmd,
      stdout: "pipe",
      stderr: "pipe",
      stdin: "ignore",
    });
    const targetProc = proc;
    void targetProc.exited.then((exitCode) => {
      void handleUnexpectedServerExit(targetProc, exitCode);
    });
    activeServerPid = targetProc.pid ?? null;
    if (activeServerPid !== null) {
      attachChildProcessToParentLifetime(activeServerPid);
    }

    activePort = port;

    consumeLogs(targetProc.stderr, "server");
    consumeLogs(targetProc.stdout, "server");

    const isReady = await waitForHealthCheck(targetProc, port);
    if (!isReady) {
      const lastError = getBootLogs().slice(-10).join("\n");
      logError("Server failed to reach ready state");
      await unloadModel();
      throw new Error(`llama-server failed to become ready. Last logs:\n${lastError}`);
    }

    broadcastLoadProgress("ready", 100, "Model server ready");
    setStatus("running");
    logInfo("Model server running", { port, model: config.modelPath });

    const { saveSettings } = await import("./persistence/settingsRepo");
    await saveSettings({
      lastLoadConfig: persistedConfig,
      ...(thinkingTagOverride ? { lastLoadThinkingTagOverride: thinkingTagOverride } : {}),
    });

    return port;
  } catch (err) {
    if (tempJinjaPath) {
      activeTempJinjaPath = undefined;
      try {
        await fs.unlink(tempJinjaPath);
      } catch {
        // Temp file may already be gone.
      }
    }
    if (currentStatus !== "running") {
      if (proc) {
        await unloadModel();
      } else {
        resetLoadedModelState();
      }
    }
    throw err;
  } finally {
    loadingLock = false;
  }
}

/**
 * Polls the llama-server health endpoint until the spawned process becomes ready.
 *
 * @param target - Process instance that should still own the active server state.
 * @param port - Port exposed by the candidate llama-server instance.
 * @returns `true` when the health endpoint responds successfully before timeout.
 */
async function waitForHealthCheck(
  target: Subprocess<"ignore", "pipe", "pipe">,
  port: number,
): Promise<boolean> {
  // A large model on a slow disk can stay healthy-but-not-ready well past a minute.
  // Keep polling while the process is alive and its log is still moving. A dead
  // process fails immediately. A quiet process fails after a few minutes. The
  // ceiling stops a load that logs forever without ever opening the port.
  const READY_CEILING_MS = 10 * 60 * 1000;
  const QUIET_FAIL_MS = 3 * 60 * 1000;
  const startedAt = Date.now();
  let lastLogCount = getBootLogs().length;
  let lastProgressAt = startedAt;
  let attempt = 0;

  while (Date.now() - startedAt < READY_CEILING_MS) {
    if (proc !== target || target.exitCode !== null) {
      return false;
    }
    try {
      if (await probeHealthEndpoint(port)) {
        return true;
      }
    } catch {
      // Ignore network errors while booting
    }

    const logCount = getBootLogs().length;
    if (logCount !== lastLogCount) {
      lastLogCount = logCount;
      lastProgressAt = Date.now();
    } else if (Date.now() - startedAt > 60_000 && Date.now() - lastProgressAt > QUIET_FAIL_MS) {
      logWarn("llama-server stopped reporting load progress before it became ready", { port });
      return false;
    }

    const delay = attempt < 50 ? 100 : attempt < 130 ? 250 : 500;
    attempt += 1;
    await new Promise((resolve) => setTimeout(resolve, delay));
  }

  logWarn("llama-server was still loading when the readiness ceiling elapsed", { port });
  return false;
}

/**
 * Reports whether an exited process is still the active llama-server.
 *
 * Unload and a newer spawn clear `proc` or return to `idle` before the old
 * process's exit promise resolves. Those exits must not reset a live server.
 *
 * @param target - Process whose exit is being handled.
 * @returns `true` when this exit still belongs to the loaded server.
 */
function unexpectedExitStillApplies(target: Subprocess<"ignore", "pipe", "pipe">): boolean {
  return proc === target && currentStatus !== "idle";
}

/**
 * Clears loaded-model state when llama-server exits on its own.
 *
 * Unload already nulls `proc` before the process dies, so this handler ignores
 * that exit. A crash after `loading` or `running` aborts generations and
 * broadcasts `idle`.
 *
 * @param target - Process that exited.
 * @param exitCode - Exit code reported by Bun.
 * @returns No return value.
 */
async function handleUnexpectedServerExit(
  target: Subprocess<"ignore", "pipe", "pipe">,
  exitCode: number,
): Promise<void> {
  if (!unexpectedExitStillApplies(target)) return;

  const recentLogs = getBootLogs().slice(-10).join("\n");
  logError("llama-server exited unexpectedly", { exitCode, recentLogs });

  if (!unexpectedExitStillApplies(target)) return;

  try {
    const { abortAllGenerations } = await import("./streamProxy");
    abortAllGenerations("unloaded");
  } catch (err) {
    logError("Failed to abort generations after llama-server exit:", err);
  }
  try {
    const { cancelPendingApprovals } = await import("./tools");
    cancelPendingApprovals(undefined, "unloaded");
  } catch (err) {
    logError("Failed to cancel tool approvals after llama-server exit:", err);
  }

  if (!unexpectedExitStillApplies(target)) return;

  activeServerPid = null;
  cancelActiveLogReaders();
  const tempPath = activeTempJinjaPath;
  activeTempJinjaPath = undefined;
  resetLoadedModelState();
  if (tempPath) {
    Bun.file(tempPath)
      .delete()
      .catch(() => {});
  }
}

/**
 * Performs a quiet HTTP health probe over a raw TCP socket so expected startup
 * connection refusals and 503 responses do not leak noisy console output and so
 * the probe cannot be intercepted by tests that replace `globalThis.fetch`.
 *
 * @param port - Localhost port exposed by the candidate llama-server process.
 * @returns `true` when the health endpoint responds with a 2xx status.
 */
function probeHealthEndpoint(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (ok: boolean) => {
      if (settled) {
        return;
      }
      settled = true;
      resolve(ok);
    };

    let received = "";
    const request = `GET /health HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nConnection: close\r\n\r\n`;
    const timeout = setTimeout(() => {
      finish(false);
    }, 1000);

    void Bun.connect({
      hostname: "127.0.0.1",
      port,
      socket: {
        open(socket) {
          socket.write(request);
        },
        data(_socket, data) {
          received += new TextDecoder().decode(data);
        },
        end() {
          clearTimeout(timeout);
          finish(httpStatusIsSuccess(received));
        },
        close() {
          clearTimeout(timeout);
          finish(httpStatusIsSuccess(received));
        },
        error() {
          clearTimeout(timeout);
          finish(false);
        },
        connectError() {
          clearTimeout(timeout);
          finish(false);
        },
        timeout() {
          clearTimeout(timeout);
          finish(false);
        },
      },
    }).catch(() => {
      clearTimeout(timeout);
      finish(false);
    });
  });
}

/**
 * Reads the HTTP status code from a raw response buffer and reports success.
 *
 * @param raw - Bytes received from llama-server as UTF-8 text.
 * @returns `true` when the status is in the 2xx range.
 */
function httpStatusIsSuccess(raw: string): boolean {
  const statusLine = raw.split("\r\n")[0] ?? "";
  const match = /HTTP\/\d(?:\.\d)?\s+(\d{3})/.exec(statusLine);
  if (!match) {
    return false;
  }
  const code = Number(match[1]);
  return code >= 200 && code < 300;
}

/**
 * Streams llama-server log output into the WebSocket log broadcast channel.
 *
 * @param stream - Process output stream to consume.
 * @param defaultLevel - Log level used when the stream line does not contain structured metadata.
 * @returns A promise that settles once the stream is fully consumed or cancelled.
 */
async function consumeLogs(
  stream: ReadableStream<Uint8Array> | null,
  defaultLevel: "server" | "info" | "warn" | "error" | "debug",
) {
  if (!stream) return;
  const reader = stream.getReader();
  // S9 fix: track the reader for cancellation
  activeReaders.add(reader);
  const decoder = new TextDecoder();
  let buffer = "";

  try {
    while (true) {
      let done = false;
      let value: Uint8Array | undefined;
      try {
        const res = await reader.read();
        done = res.done;
        value = res.value;
      } catch {
        break;
      }
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const line of lines) {
        if (!line.trim()) continue;

        // Rolling buffer for boot error reporting
        pushBootLog(line);

        // Derive load-progress from structured or unstructured boot logs
        trackLoadProgressFromLog(line);

        if (line.startsWith("{") && line.endsWith("}")) {
          try {
            const parsed = JSON.parse(line);
            const level = parsed.level?.toLowerCase() || defaultLevel;

            if (["info", "warn", "error", "debug", "server"].includes(level)) {
              const normalizedLevel = level as "info" | "warn" | "error" | "debug" | "server";
              if (shouldEmitLog(normalizedLevel)) {
                broadcastLog(normalizedLevel, parsed.msg || line);
              }
            } else {
              if (shouldEmitLog(defaultLevel)) {
                broadcastLog(defaultLevel, parsed.msg || line);
              }
            }
          } catch {
            if (shouldEmitLog(defaultLevel)) {
              broadcastLog(defaultLevel, line);
            }
          }
        } else {
          if (shouldEmitLog(defaultLevel)) {
            broadcastLog(defaultLevel, line);
          }
        }
      }
    }
  } catch {
    // Ignore stream closed errors
  } finally {
    // S9 fix: remove reader from tracking set
    activeReaders.delete(reader);
  }
}

/**
 * Terminates the currently running llama-server process.
 *
 * @returns A promise that resolves when the process has been terminated.
 */
export async function unloadModel(): Promise<void> {
  await requestUnloadModel();
}

/**
 * Requests model unload while coalescing concurrent unload attempts into a single promise.
 *
 * @returns A promise that resolves when the active process has been stopped and cleanup is complete.
 */
export function requestUnloadModel(): Promise<void> {
  if (unloadPromise) {
    return unloadPromise;
  }

  unloadPromise = (async () => {
    logInfo("Unloading model...");
    try {
      const { abortAllGenerations } = await import("./streamProxy");
      abortAllGenerations("unloaded");
    } catch (err) {
      logError("Failed to abort active generations before unload:", err);
    }
    const { cancelPendingApprovals } = await import("./tools");
    cancelPendingApprovals(undefined, "unloaded");
    if (!proc) {
      resetLoadedModelState();
      const tempPath = activeTempJinjaPath;
      activeTempJinjaPath = undefined;
      if (tempPath) {
        Bun.file(tempPath)
          .delete()
          .catch(() => {});
      }
      return;
    }

    const target = proc;
    const pid = activeServerPid ?? target.pid ?? null;
    resetLoadedModelState();
    cancelActiveLogReaders();

    try {
      if (process.platform === "win32") {
        killProcessTree(pid, true);
        for (let i = 0; i < 40 && target.exitCode === null; i++) {
          await new Promise((resolve) => setTimeout(resolve, 50));
        }
      } else {
        killProcessTree(pid, false);
        for (let i = 0; i < 60; i++) {
          if (target.exitCode !== null) break;
          await new Promise((resolve) => setTimeout(resolve, 250));
        }
        if (target.exitCode === null) {
          logWarn("Forcing server termination");
          killProcessTree(pid, true);
        }
      }
    } finally {
      activeServerPid = null;
      const tempPath = activeTempJinjaPath;
      activeTempJinjaPath = undefined;
      if (tempPath) {
        Bun.file(tempPath)
          .delete()
          .catch(() => {});
      }
    }
  })().finally(() => {
    unloadPromise = null;
  });

  return unloadPromise;
}

/**
 * Switches the model by unloading the current one and loading a new one.
 *
 * @param config - Full model load configuration for the new model.
 * @param llamaServerBin - Absolute path to the llama-server binary.
 * @param minPort - Minimum port range for searching free ports.
 * @param maxPort - Maximum port range for searching free ports.
 * @param thinkingTagOverride - Optional thinking-tag override associated with the selected load preset.
 * @returns The port number on which the new server is listening.
 * @throws {Error} If loading the new model fails.
 */
export async function switchModel(
  config: ModelLoadConfig,
  llamaServerBin: string,
  minPort: number,
  maxPort: number,
  thinkingTagOverride?: ThinkingTagConfig,
): Promise<number> {
  await unloadModel();
  return loadModel(config, llamaServerBin, minPort, maxPort, thinkingTagOverride);
}
