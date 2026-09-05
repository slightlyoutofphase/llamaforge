/**
 * @packageDocumentation
 * Tests for backend startup behavior.
 */

import { afterEach, beforeEach, describe, expect, it, mock, spyOn } from "bun:test";
import { startServer } from "../../src/server/index";
import type { AppSettings } from "../../src/shared/types";
import type { ModelEntry } from "../../src/shared/types";
import * as cleanupModule from "../../src/server/persistence/cleanup";
import * as dbModule from "../../src/server/persistence/db";
import * as llamaServerModule from "../../src/server/llamaServer";
import * as loggerModule from "../../src/server/logger";
import * as modelScannerModule from "../../src/server/modelScanner";
import * as presetRepoModule from "../../src/server/persistence/presetRepo";
import * as settingsRepoModule from "../../src/server/persistence/settingsRepo";

const productionSettings: AppSettings = {
  serverPort: 14001,
  modelsPath: "/models",
  theme: "system",
  accentColor: "#ffffff",
  fontSize: 14,
  chatBubbleStyle: "bubble",
  autonameEnabled: true,
  autoloadLastModel: false,
  includeVideoAudio: false,
  llamaPortRangeMin: 12000,
  llamaPortRangeMax: 13000,
  requestTimeoutSeconds: 60,
  logLevel: "info",
  showConsoleOnStartup: false,
};

describe("server index startup", () => {
  let originalNodeEnv: string | undefined;

  beforeEach(() => {
    originalNodeEnv = Bun.env.NODE_ENV;
    Bun.env.NODE_ENV = "production";
  });

  afterEach(() => {
    Bun.env.NODE_ENV = originalNodeEnv;
    mock.restore();
  });

  it("uses the configured Bun server port during production startup", async () => {
    spyOn(dbModule, "initDb").mockResolvedValue();
    spyOn(settingsRepoModule, "loadSettings").mockResolvedValue(productionSettings);
    spyOn(modelScannerModule, "scanModels").mockResolvedValue([]);
    spyOn(modelScannerModule, "populateMetadata").mockImplementation(
      async (model: ModelEntry) => model,
    );
    spyOn(presetRepoModule, "ensureModelDefaultPresets").mockResolvedValue();
    spyOn(cleanupModule, "cleanupOrphanedAttachments").mockResolvedValue();
    spyOn(llamaServerModule, "loadModel").mockResolvedValue(12000);
    spyOn(loggerModule, "logError").mockImplementation(() => {});
    spyOn(loggerModule, "logInfo").mockImplementation(() => {});

    const server = await startServer({ scheduleRecurringCleanup: false });

    expect(server.port).toBe(14001);
    server.stop();
  });

  it("canonicalizes autoload mmProjPath from the scanned model entry", async () => {
    const autoloadSettings: AppSettings = {
      ...productionSettings,
      autoloadLastModel: true,
      llamaServerPath: "/usr/bin/llama-server",
      lastLoadConfig: {
        modelPath: "/models/multimodal.gguf",
        mmProjPath: "/models/stale.mmproj.gguf",
        contextSize: 4096,
        contextShift: false,
        gpuLayers: 0,
        threads: 4,
        batchSize: 512,
        microBatchSize: 128,
        ropeScaling: "none",
        ropeFreqBase: 10000,
        ropeFreqScale: 1,
        kvCacheTypeK: "f16",
        kvCacheTypeV: "f16",
        mlock: false,
        noMmap: false,
        contBatching: true,
        flashAttn: "off",
        swaFull: false,
        noKvOffload: false,
        cacheReuse: 0,
      },
    };

    spyOn(dbModule, "initDb").mockResolvedValue();
    spyOn(settingsRepoModule, "loadSettings").mockResolvedValue(autoloadSettings);
    spyOn(modelScannerModule, "scanModels").mockResolvedValue([
      {
        publisher: "Test Publisher",
        modelName: "Multimodal Model",
        primaryPath: "/models/multimodal.gguf",
        mmProjPath: "/models/multimodal.mmproj.gguf",
      },
    ]);
    spyOn(modelScannerModule, "populateMetadata").mockImplementation(
      async (model: ModelEntry) => model,
    );
    spyOn(presetRepoModule, "ensureModelDefaultPresets").mockResolvedValue();
    spyOn(cleanupModule, "cleanupOrphanedAttachments").mockResolvedValue();
    const loadSpy = spyOn(llamaServerModule, "loadModel").mockResolvedValue(12000);
    spyOn(loggerModule, "logError").mockImplementation(() => {});
    spyOn(loggerModule, "logInfo").mockImplementation(() => {});

    const server = await startServer({ scheduleRecurringCleanup: false });

    expect(loadSpy).toHaveBeenCalledTimes(1);
    expect(loadSpy.mock.calls[0]?.[0]).toEqual(
      expect.objectContaining({
        modelPath: "/models/multimodal.gguf",
        mmProjPath: "/models/multimodal.mmproj.gguf",
      }),
    );
    server.stop();
  });

  it("survives a fatal scanModels error and still starts the server", async () => {
    spyOn(dbModule, "initDb").mockResolvedValue();
    spyOn(settingsRepoModule, "loadSettings").mockResolvedValue(productionSettings);
    const scanSpy = spyOn(modelScannerModule, "scanModels").mockImplementation(async () => {
      throw new Error("mprotect failed: 487");
    });
    spyOn(presetRepoModule, "ensureModelDefaultPresets").mockResolvedValue();
    spyOn(cleanupModule, "cleanupOrphanedAttachments").mockResolvedValue();
    spyOn(llamaServerModule, "loadModel").mockResolvedValue(12000);
    const logErrorSpy = spyOn(loggerModule, "logError").mockImplementation(() => {});
    spyOn(loggerModule, "logInfo").mockImplementation(() => {});

    const server = await startServer({ scheduleRecurringCleanup: false });

    expect(scanSpy).toHaveBeenCalledTimes(1);
    expect(logErrorSpy).toHaveBeenCalled();
    expect(server.port).toBe(14001);
    server.stop();
  });
});
