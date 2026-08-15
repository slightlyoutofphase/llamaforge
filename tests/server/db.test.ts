/**
 * @packageDocumentation
 * Tests for database initialization and schema layout.
 */

import path from "node:path";
import { beforeEach, describe, expect, it } from "bun:test";
import { getAppDataDir, getDb, initDb } from "../../src/server/persistence/db";

describe("db configuration", () => {
  beforeEach(async () => {
    await initDb(":memory:");
  });

  it("creates all tables", () => {
    const db = getDb(":memory:");
    const tables = db
      .query<{ name: string }, []>("SELECT name FROM sqlite_master WHERE type='table'")
      .all();
    const tableNames = tables.map((t) => t.name);

    expect(tableNames).toContain("chats");
    expect(tableNames).toContain("messages");
    expect(tableNames).toContain("attachments");
    expect(tableNames).toContain("load_presets");
    expect(tableNames).toContain("inference_presets");
    expect(tableNames).toContain("system_presets");
    expect(tableNames).toContain("model_cache");
    expect(tableNames).toContain("settings");

    const messageColumns = db
      .query<{ name: string }, []>("PRAGMA table_info(messages)")
      .all()
      .map((column) => column.name);
    expect(messageColumns).toContain("metrics_json");
  });

  it("seeds the default load preset with canonical flashAttn config", () => {
    const db = getDb(":memory:");
    const row = db
      .query<{ config_json: string }, []>("SELECT config_json FROM load_presets LIMIT 1")
      .get();

    expect(row).toBeDefined();
    const parsed = JSON.parse(row?.config_json ?? "{}");
    expect(parsed.config?.flashAttn).toBe("auto");
    expect(parsed.config?.flashAttention).toBeUndefined();
  });

  it("resolves the effective app data dir inside tests/data", () => {
    expect(getAppDataDir()).toBe(path.resolve(import.meta.dir, "../data/.llamaforge"));
  });
});
