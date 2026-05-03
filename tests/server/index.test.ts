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
  llamaPortRangeMin: 12000,
  llamaPortRangeMax: 13000,
  requestTimeoutSeconds: 60,
  logLevel: "info",
  showConsoleOnStartup: false,
};

describe("server index startup", () => {
  let originalNodeEnv: string | undefined;

  beforeEach(() => {
    originalNodeEnv = process.env.NODE_ENV;
    process.env.NODE_ENV = "production";
  });

  afterEach(() => {
    process.env.NODE_ENV = originalNodeEnv;
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
});
