/**
 * @packageDocumentation
 * Entry point for the LlamaForge Bun backend server.
 *
 * Initialises the SQLite database, scans the model directory,
 * and starts the HTTP + WebSocket server.
 */
import { serve } from "bun";
import { getProc, loadModel } from "./llamaServer";
import { scanModels } from "./modelScanner";
import { initDb } from "./persistence/db";
import { loadSettings } from "./persistence/settingsRepo";
import { createRouter } from "./router";

async function main() {
  await initDb();
  const settings = await loadSettings();

  // Scans locally at startup and returns raw model entries quickly.
  const rawModels = await scanModels(settings.modelsPath);

  // Populate metadata and generate any missing default presets in the background.
  void (async () => {
    try {
      const { populateMetadata } = await import("./modelScanner");
      const metadataModels = await Promise.all(rawModels.map((m) => populateMetadata(m)));
      const { ensureModelDefaultPresets } = await import("./persistence/presetRepo");
      await ensureModelDefaultPresets(metadataModels);
      console.log("Background model metadata population complete.");
    } catch (e) {
      console.error("Background model metadata population failed:", e);
    }
  })();

  // Cleanup orphaned files once at startup and periodically thereafter.
  const { cleanupOrphanedAttachments } = await import("./persistence/cleanup");
  const scheduleCleanup = async () => {
    try {
      await cleanupOrphanedAttachments();
    } catch (e) {
      console.error("Cleanup failed:", e);
    }
  };
  void scheduleCleanup();
  setInterval(scheduleCleanup, 24 * 60 * 60 * 1000);

  // Autoload last model if enabled
  if (settings.autoloadLastModel && settings.lastLoadConfig && settings.llamaServerPath) {
    try {
      console.log(`Autoloading last model: ${settings.lastLoadConfig.modelPath}`);
      await loadModel(
        settings.lastLoadConfig,
        settings.llamaServerPath,
        settings.llamaPortRangeMin,
        settings.llamaPortRangeMax,
      );
      console.log("Autoload completed successfully.");
    } catch (err) {
      console.error(
        "Autoload failed. The model server could not be started.",
        err instanceof Error ? err.message : String(err),
      );
    }
  }

  const isProd = process.env.NODE_ENV === "production";
  // In dev, Vite is on 3000 and proxies to us on 11435.
  // In prod, WE are on 3000 and serve static files.
  const port = isProd ? 3000 : (settings.serverPort ?? 11435);
  const hostname = "127.0.0.1";

  console.log(`Starting LlamaForge Server on ${hostname}:${port} (Prod: ${isProd})`);

  const router = createRouter(settings);

  const server = serve({
    port,
    hostname,
    fetch: router.fetch,
    websocket: router.websocket,
  });

  let shutdownInProgress = false;
  const cleanup = () => {
    if (shutdownInProgress) return;
    shutdownInProgress = true;
    console.log("Shutting down LlamaForge Server...");
    try {
      const proc = getProc();
      if (proc) {
        proc.kill(9); // Send SIGKILL immediately to ensure it dies before we exit
      }
    } catch (_e) {}
    server.stop();
    process.exit(0);
  };

  process.on("SIGINT", cleanup);
  process.on("SIGTERM", cleanup);
  process.on("SIGHUP", cleanup);
}

main().catch((err) => {
  console.error("Server startup failed:", err);
  process.exit(1);
});
