/**
 * @packageDocumentation
 * Llama server lifecycle management — spawn, unload, and switch model processes.
 */

import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { LlamaServerStatus, ModelLoadConfig } from "@shared/types.js";
import { type Subprocess, spawn } from "bun";
import { findFreePort } from "./utils/network";
import { broadcastLog, broadcastStatus } from "./wsHub";

let proc: Subprocess<"ignore", "pipe", "pipe"> | null = null;
let activePort: number | null = null;
let currentConfig: ModelLoadConfig | null = null;
let currentStatus: LlamaServerStatus = "idle";
let loadingLock = false;
// M2 fix: ring buffer for boot logs to prevent O(n) shift operations during long loads
const BOOT_LOG_CAPACITY = 1000;
let bootLogBuffer: string[] = [];
let bootLogWriteIndex = 0;

function pushBootLog(line: string): void {
  if (bootLogBuffer.length < BOOT_LOG_CAPACITY) {
    bootLogBuffer.push(line);
  } else {
    bootLogBuffer[bootLogWriteIndex] = line;
  }
  bootLogWriteIndex = (bootLogWriteIndex + 1) % BOOT_LOG_CAPACITY;
}

function getBootLogs(): string[] {
  if (bootLogBuffer.length < BOOT_LOG_CAPACITY) {
    return bootLogBuffer.slice();
  }
  // Ring buffer is full: read from writeIndex (oldest) to end, then start to writeIndex
  return [...bootLogBuffer.slice(bootLogWriteIndex), ...bootLogBuffer.slice(0, bootLogWriteIndex)];
}

function clearBootLogs(): void {
  bootLogBuffer = [];
  bootLogWriteIndex = 0;
}
// S9 fix: track active stream readers for cancellation on unload
const activeReaders: Set<ReadableStreamDefaultReader<Uint8Array>> = new Set();

/**
 * Retrieves the raw Bun subprocess instance.
 *
 * @returns The current {@link Subprocess} or null if no model is loaded.
 */
export function getProc() {
  return proc;
}

/**
 * Updates the internal server status and broadcasts it to all connected clients.
 *
 * @param status - The new status to set.
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
    args.push("--image-min-tokens", "70");
    args.push("--image-max-tokens", String(config.imageMaxTokens));
  }

  if (config.kvUnified !== undefined) {
    args.push(config.kvUnified ? "--kv-unified" : "--no-kv-unified");
  }

  // Pass --media-path to allow local file URLs for multimodal requests
  const APP_ROOT = path.join(os.homedir(), ".llamaforge");
  args.push("--media-path", APP_ROOT);

  return args;
}

/**
 * Spawns llama-server with the given load configuration.
 *
 * @param config - Full model load configuration including all CLI flags.
 * @param llamaServerBin - Absolute path to the llama-server binary.
 * @param minPort - Minimum port range for searching free ports.
 * @param maxPort - Maximum port range for searching free ports.
 * @returns The port number on which the spawned server is listening.
 * @throws {Error} If the server fails to become ready within the timeout period.
 */
async function validateBinary(absolutePath: string): Promise<void> {
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
 * @returns The port number where the newly spawned server is listening.
 * @throws {Error} If the server binary cannot be validated, if the model fails to load,
 *         or if the server does not become ready within the configured timeout.
 */
export async function loadModel(
  config: ModelLoadConfig,
  llamaServerBin: string,
  minPort: number,
  maxPort: number,
): Promise<number> {
  if (loadingLock) {
    throw new Error("Model loading in progress. Please wait.");
  }
  loadingLock = true;
  clearBootLogs();

  try {
    await validateBinary(llamaServerBin);

    if (proc) {
      await unloadModel();
    }

    setStatus("loading");
    const port = await findFreePort(minPort, maxPort);

    // Temporary file handling for custom Jinja templates
    if (config.chatTemplateFile !== undefined) {
      const tempPath = path.join(os.tmpdir(), `llamaforge-chat-template-${Date.now()}.jinja`);
      await Bun.write(tempPath, config.chatTemplateFile);
      config = { ...config, chatTemplateFile: tempPath };
    }

    currentConfig = config;
    const args = buildArgs(config, port);

    proc = spawn({
      cmd: [llamaServerBin, ...args],
      stdout: "pipe",
      stderr: "pipe",
      stdin: "ignore",
    });

    activePort = port;

    consumeLogs(proc.stderr, "server");
    consumeLogs(proc.stdout, "server");

    const isReady = await waitForHealthCheck(port);
    if (!isReady) {
      const lastError = getBootLogs().slice(-10).join("\n");
      await unloadModel();
      throw new Error(`llama-server failed to become ready. Last logs:\n${lastError}`);
    }

    setStatus("running");

    const { saveSettings } = await import("./persistence/settingsRepo");
    await saveSettings({ lastLoadConfig: config });

    return port;
  } finally {
    loadingLock = false;
  }
}

async function waitForHealthCheck(port: number): Promise<boolean> {
  const maxAttempts = 480; // 120s at 250ms
  for (let i = 0; i < maxAttempts; i++) {
    if (proc && proc.exitCode !== null) {
      return false; // Process died, no need to keep polling
    }
    try {
      const res = await fetch(`http://127.0.0.1:${port}/health`, {
        signal: AbortSignal.timeout(1000),
      });
      if (res.ok) {
        return true;
      }
    } catch {
      // Ignore network errors while booting
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  return false;
}

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
              broadcastLog(
                level as "info" | "warn" | "error" | "debug" | "server",
                parsed.msg || line,
              );
            } else {
              broadcastLog(defaultLevel, parsed.msg || line);
            }
          } catch {
            broadcastLog(defaultLevel, line);
          }
        } else {
          broadcastLog(defaultLevel, line);
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
  if (!proc) {
    activePort = null;
    currentConfig = null;
    setStatus("idle");
    return;
  }

  setStatus("loading");
  const target = proc;

  // S9 fix: cancel all active log readers before killing the process
  for (const reader of activeReaders) {
    try {
      reader.cancel();
    } catch (_e) {
      // Ignore — reader may already be closed
    }
  }
  activeReaders.clear();

  try {
    try {
      target.kill(15); // SIGTERM
    } catch (_e) {
      // Ignore error if process is already dead
    }

    // Wait up to 15s for graceful shutdown
    for (let i = 0; i < 60; i++) {
      if (target.exitCode !== null) break;
      await new Promise((r) => setTimeout(r, 250));
    }
    if (target.exitCode === null) {
      try {
        target.kill(9); // SIGKILL
      } catch (_e) {
        // Ignore
      }
    }
  } finally {
    if (currentConfig?.chatTemplateFile) {
      fs.unlink(currentConfig.chatTemplateFile).catch(() => {});
    }
    proc = null;
    activePort = null;
    currentConfig = null;
    setStatus("idle");
  }
}

/**
 * Switches the model by unloading the current one and loading a new one.
 *
 * @param config - Full model load configuration for the new model.
 * @param llamaServerBin - Absolute path to the llama-server binary.
 * @param minPort - Minimum port range for searching free ports.
 * @param maxPort - Maximum port range for searching free ports.
 * @returns The port number on which the new server is listening.
 * @throws {Error} If loading the new model fails.
 */
export async function switchModel(
  config: ModelLoadConfig,
  llamaServerBin: string,
  minPort: number,
  maxPort: number,
): Promise<number> {
  await unloadModel();
  return loadModel(config, llamaServerBin, minPort, maxPort);
}
