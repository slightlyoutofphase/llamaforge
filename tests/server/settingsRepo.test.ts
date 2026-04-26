/**
 * @packageDocumentation
 * Tests for application settings persistence and defaults behavior.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { initDb, resetDb } from "../../src/server/persistence/db";
import { loadSettings, saveSettings } from "../../src/server/persistence/settingsRepo";

describe("settingsRepo", () => {
  beforeEach(async () => {
    await initDb(":memory:");
  });

  afterEach(() => {
    resetDb();
  });

  it("returns default settings when none saved", async () => {
    const s = await loadSettings();
    expect(s.serverPort).toBe(11435);
    expect(s.modelsPath).toBeDefined();
  });

  it("persists and retrieves settings round-trip", async () => {
    await saveSettings({ serverPort: 12345 });
    const s = await loadSettings();
    expect(s.serverPort).toBe(12345);
  });
});
