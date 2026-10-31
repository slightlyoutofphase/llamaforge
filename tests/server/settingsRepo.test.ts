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
    expect(s.autoloadLastModel).toBe(false);
    expect(s.includeVideoAudio).toBe(false);
  });

  it("persists and retrieves settings round-trip", async () => {
    await saveSettings({ serverPort: 12345 });
    const s = await loadSettings();
    expect(s.serverPort).toBe(12345);
  });

  it("persists includeVideoAudio independently of other defaults", async () => {
    await saveSettings({ includeVideoAudio: true });
    const s = await loadSettings();
    expect(s.includeVideoAudio).toBe(true);
  });

  it("rejects NaN numeric settings", async () => {
    await expect(saveSettings({ serverPort: Number.NaN })).rejects.toThrow("serverPort");
  });

  it("rejects negative request timeout values", async () => {
    await expect(saveSettings({ requestTimeoutSeconds: -1 })).rejects.toThrow(
      "requestTimeoutSeconds",
    );
  });

  it("persists a disabled generation inactivity timeout", async () => {
    await saveSettings({ requestTimeoutSeconds: 0 });
    const saved = await loadSettings();
    expect(saved.requestTimeoutSeconds).toBe(0);
  });

  it("rejects inverted llama port ranges", async () => {
    await expect(
      saveSettings({
        llamaPortRangeMin: 14000,
        llamaPortRangeMax: 13000,
      }),
    ).rejects.toThrow("llamaPortRangeMin");
  });
});
