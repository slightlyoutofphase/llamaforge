/**
 * @packageDocumentation
 * Llama server lifecycle management — spawn, unload, and switch model processes.
 */

import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { LlamaServerStatus, ModelLoadConfig, ThinkingTagConfig } from "../shared/types";
import { type Subprocess, spawn } from "bun";
import { logDebug, logError, logInfo, logWarn, shouldEmitLog } from "./logger";
import { getAppDataDir } from "./persistence/db";
import { findFreePort } from "./utils/network";
import { broadcastLog, broadcastStatus } from "./wsHub";

let proc: Subprocess<"ignore", "pipe", "pipe"> | null = null;
let activePort: number | null = null;
let currentConfig: ModelLoadConfig | null = null;
let currentThinkingTagOverride: ThinkingTagConfig | undefined;
let currentStatus: LlamaServerStatus = "idle";
let loadingLock = false;
let unloadPromise: Promise<void> | null = null;
// M2 fix: ring buffer for boot logs to prevent O(n) shift operations during long loads
const BOOT_LOG_CAPACITY = 1000;
let bootLogBuffer: string[] = [];
let bootLogWriteIndex = 0;

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
 * Retrieves the raw Bun subprocess instance.
 *
 * @returns The current {@link Subprocess} or null if no model is loaded.
 */
export function getProc() {
  return proc;
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
 * Builds the CLI argument array for llama-server from a ModelLoadConfig.
 * Every field in ModelLoadConfig maps 1:1 to a documented llama-server flag.
 *
 * @param config - The load configuration.
 * @param port - The port to bind to.
 * @returns Ordered array of CLI arguments.
 * @example
 * ```typescript
 * const args = buildArgs({ modelPath: "/path/to/model", contextSize: 2048 }, 8080);
 * ```
 */
export function buildArgs(config: ModelLoadConfig, port: number): readonly string[] {
  const appRoot = getAppDataDir();
  const args: string[] = [
    "--model",
    config.modelPath,
    "--port",
    String(port),
    "--host",
    "127.0.0.1",
    "--ctx-size",
    String(config.contextSize),
    ...(config.contextShift ? ["--context-shift"] : ["--no-context-shift"]),
    "--n-gpu-layers",
    String(config.gpuLayers),
    "--threads",
    String(config.threads),
    ...(config.threadsBatch !== undefined ? ["--threads-batch", String(config.threadsBatch)] : []),
    "--batch-size",
    String(config.batchSize),
    "--ubatch-size",
    String(config.microBatchSize),
    ...(config.ropeScaling !== "none" ? ["--rope-scaling", config.ropeScaling] : []),
    ...(config.ropeFreqBase > 0 ? ["--rope-freq-base", String(config.ropeFreqBase)] : []),
    ...(config.ropeFreqScale > 0 ? ["--rope-freq-scale", String(config.ropeFreqScale)] : []),
    "--cache-type-k",
    config.kvCacheTypeK,
    "--cache-type-v",
    config.kvCacheTypeV,
    "--image-min-tokens",
    "70",
    "--parallel",
    "1",
    "--jinja",
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

  if (config.mmProjPath) {
    args.push("--mmproj", config.mmProjPath);
  }
  if (config.mainGpu !== undefined) {
    args.push("--main-gpu", String(config.mainGpu));
  }
  if (config.tensorSplit && config.tensorSplit.length > 0) {
    args.push("--tensor-split", config.tensorSplit.join(","));
  }
  if (config.mlock) {
    args.push("--mlock");
  }
  if (config.noMmap) {
    args.push("--no-mmap");
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
  if (config.chatTemplateFile) {
    args.push("--chat-template-file", config.chatTemplateFile);
  }

  if (config.imageMaxTokens !== undefined) {
    args.push("--image-max-tokens", String(config.imageMaxTokens));
  }

  if (config.kvUnified !== undefined) {
    args.push(config.kvUnified ? "--kv-unified" : "--no-kv-unified");
  }

  // Pass --media-path to allow local file URLs for multimodal requests
  args.push("--media-path", appRoot);

  return args;
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
 *         or if the server does not become ready within the configured timeout.
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

    // Temporary file handling for custom Jinja templates
    if (config.chatTemplateFile !== undefined) {
      const tempPath = path.join(os.tmpdir(), `llamaforge-chat-template-${Date.now()}.jinja`);
      await Bun.write(tempPath, config.chatTemplateFile);
      config = { ...config, chatTemplateFile: tempPath };
    }

    currentConfig = config;
    currentThinkingTagOverride = thinkingTagOverride;
    const args = buildArgs(config, port);
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

    setStatus("running");
    logInfo("Model server running", { port, model: config.modelPath });

    const { saveSettings } = await import("./persistence/settingsRepo");
    await saveSettings({
      lastLoadConfig: persistedConfig,
      ...(thinkingTagOverride ? { lastLoadThinkingTagOverride: thinkingTagOverride } : {}),
    });

    return port;
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
  const maxAttempts = 480; // 120s at 250ms
  for (let i = 0; i < maxAttempts; i++) {
    if (proc !== target || target.exitCode !== null) {
      return false; // Process died, no need to keep polling
    }
    try {
      if (await probeHealthEndpoint(port)) {
        return true;
      }
    } catch {
      // Ignore network errors while booting
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  return false;
}

/**
 * Performs a quiet HTTP health probe without using fetch so expected startup
 * connection refusals and 503 responses do not leak noisy console output.
 *
 * @param port - Localhost port exposed by the candidate llama-server process.
 * @returns `true` when the health endpoint responds with a 2xx status.
 */
function probeHealthEndpoint(port: number): Promise<boolean> {
  return fetch(`http://127.0.0.1:${port}/health`, {
    signal: AbortSignal.timeout(1000),
    keepalive: false,
    headers: {
      Connection: "close",
    },
  })
    .then((response) => {
      void response.body?.cancel();
      return response.ok;
    })
    .catch(() => false);
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
    const { cancelPendingApprovals } = await import("./tools");
    cancelPendingApprovals(undefined, "unloaded");
    if (!proc) {
      resetLoadedModelState();
      return;
    }

    const target = proc;
    const configSnapshot = resetLoadedModelState();
    cancelActiveLogReaders();

    try {
      try {
        target.kill(15); // SIGTERM
      } catch (_e) {
        // Ignore error if process is already dead
      }

      // Wait up to 15s for graceful shutdown
      for (let i = 0; i < 60; i++) {
        if (target.exitCode !== null) break;
        await new Promise((resolve) => setTimeout(resolve, 250));
      }
      if (target.exitCode === null) {
        logWarn("Forcing server termination (SIGKILL)");
        try {
          target.kill(9); // SIGKILL
        } catch (_e) {
          // Ignore
        }
      }
    } finally {
      if (configSnapshot?.chatTemplateFile) {
        Bun.file(configSnapshot.chatTemplateFile)
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
