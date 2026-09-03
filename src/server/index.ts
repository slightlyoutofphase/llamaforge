/**
 * @packageDocumentation
 * Entry point for the LlamaForge Bun backend server.
 *
 * Initialises the SQLite database, scans the model directory,
 * and starts the HTTP + WebSocket server.
 */
import { serve } from "bun";
import { loadModel, unloadModel } from "./llamaServer";
import { logError, logInfo } from "./logger";
import { scanModels } from "./modelScanner";
import { initDb, resetDb } from "./persistence/db";
import { loadSettings } from "./persistence/settingsRepo";
import { createRouter } from "./router";

/**
 * Resolves the Bun server listen port from persisted settings.
 *
 * @param settings - Persisted application settings loaded from the database.
 * @returns The configured Bun server port, or the default LlamaForge port when unset.
 */
function resolveServerPort(settings: Awaited<ReturnType<typeof loadSettings>>): number {
  return settings.serverPort ?? 11435;
}

/**
 * Maps Bun listen failures to user-facing startup errors.
 *
 * @param port - Port the Bun server attempted to bind.
 * @param err - Raw error thrown by Bun while binding the HTTP server.
 * @returns A normalized error suitable for surfacing in logs or startup failures.
 */
function describeBindFailure(port: number, err: unknown): Error {
  const message = err instanceof Error ? err.message : String(err);
  if (message.includes("EADDRINUSE") || /address.+in use/i.test(message)) {
    return new Error(
      `Configured Bun server port ${port} is already in use. Choose a different Bun Server Port in Settings and restart LlamaForge.`,
    );
  }
  return err instanceof Error ? err : new Error(message);
}

/**
 * Starts the Bun HTTP and WebSocket server for the LlamaForge backend.
 *
 * @param options - Startup options controlling optional recurring maintenance tasks.
 * @returns The active Bun server instance.
 * @throws {Error} If the database initialization, router setup, or server bind fails.
 * @example
 * ```ts
 * const server = await startServer({ scheduleRecurringCleanup: false });
 * console.log(server.port);
 * ```
 */
export async function startServer(options: { scheduleRecurringCleanup?: boolean } = {}) {
  await initDb();
  const settings = await loadSettings();

  // Scans locally at startup and returns raw model entries quickly.
  let rawModels: Awaited<ReturnType<typeof scanModels>> = [];
  try {
    rawModels = await scanModels(settings.modelsPath);
  } catch (e) {
    logError("Model directory scan failed:", e);
  }

  // Cleanup orphaned files once at startup and periodically thereafter.
  const { cleanupOrphanedAttachments } = await import("./persistence/cleanup");
  /**
   * Runs attachment cleanup once and logs any non-fatal cleanup failure.
   *
   * @returns A promise that resolves once the cleanup attempt finishes.
   */
  const scheduleCleanup = async () => {
    try {
      await cleanupOrphanedAttachments();
    } catch (e) {
      logError("Cleanup failed:", e);
    }
  };
  void scheduleCleanup();
  if (options.scheduleRecurringCleanup ?? true) {
    const cleanupInterval = setInterval(scheduleCleanup, 24 * 60 * 60 * 1000);
    cleanupInterval.unref?.();
  }

  const isProd = process.env.NODE_ENV === "production" || Bun.argv[1]?.includes("dist");
  const port = resolveServerPort(settings);
  const hostname = "127.0.0.1";

  logInfo(`Starting LlamaForge Server on http://${hostname}:${port} (Prod: ${isProd})`);

  const router = createRouter();

  let server: ReturnType<typeof serve>;
  try {
    server = serve({
      port,
      hostname,
      fetch: router.fetch,
      websocket: router.websocket,
    });
  } catch (err) {
    throw describeBindFailure(port, err);
  }

  // Populate metadata after the HTTP port is bound so the UI can connect immediately.
  try {
    const { populateMetadata } = await import("./modelScanner");
    const metadataModels = await Promise.all(rawModels.map((m) => populateMetadata(m)));
    const { ensureModelDefaultPresets } = await import("./persistence/presetRepo");
    await ensureModelDefaultPresets(metadataModels);
    logInfo("Synchronous model metadata population complete.");
  } catch (e) {
    logError("Synchronous model metadata population failed:", e);
  }

  // Autoload last model if enabled
  if (settings.autoloadLastModel && settings.lastLoadConfig && settings.llamaServerPath) {
    try {
      const autoloadConfig = { ...settings.lastLoadConfig };
      const selectedModel = rawModels.find(
        (model) => model.primaryPath === settings.lastLoadConfig?.modelPath,
      );
      if (selectedModel?.mmProjPath) {
        autoloadConfig.mmProjPath = selectedModel.mmProjPath;
      }

      logInfo(`Autoloading last model: ${autoloadConfig.modelPath}`);
      await loadModel(
        autoloadConfig,
        settings.llamaServerPath,
        settings.llamaPortRangeMin,
        settings.llamaPortRangeMax,
        settings.lastLoadThinkingTagOverride,
      );
      logInfo("Autoload completed successfully.");
    } catch (err) {
      logError(
        "Autoload failed. The model server could not be started.",
        err instanceof Error ? err.message : String(err),
      );
    }
  }

  let shutdownInProgress = false;
  /**
   * Shuts down the Bun server, active llama-server process, and database cleanly.
   *
   * @returns No return value.
   */
  const cleanup = () => {
    if (shutdownInProgress) return;
    shutdownInProgress = true;
    logInfo("Shutting down LlamaForge Server...");
    void (async () => {
      try {
        await unloadModel();
      } catch (e) {
        logError("Failed to unload model during shutdown:", e);
      }
      try {
        resetDb();
      } catch (e) {
        logError("Failed to close database during shutdown:", e);
      }
      server.stop();
      process.exit(0);
    })();
  };

  process.on("SIGINT", cleanup);
  process.on("SIGTERM", cleanup);
  process.on("SIGHUP", cleanup);

  return server;
}

if (import.meta.main) {
  startServer().catch((err) => {
    logError("Server startup failed:", err);
    process.exit(1);
  });
}
