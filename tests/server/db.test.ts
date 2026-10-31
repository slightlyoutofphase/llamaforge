/**
 * @packageDocumentation
 * Tests for database initialization and schema layout.
 */

import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Database } from "bun:sqlite";
import { beforeEach, describe, expect, it } from "bun:test";
import { getAppDataDir, getDb, initDb, resetDb } from "../../src/server/persistence/db";

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
    expect(parsed.config?.threads).toBe(3);
    expect(parsed.config?.threadsBatch).toBe(-1);
    expect(parsed.config?.kvUnified).toBe(true);
  });

  it("seeds the default inference preset with the same sampling the UI shows", () => {
    const db = getDb(":memory:");
    const row = db
      .query<{ config_json: string }, []>("SELECT config_json FROM inference_presets LIMIT 1")
      .get();
    const parsed = JSON.parse(row?.config_json ?? "{}");
    expect(parsed.temperature).toBe(0.8);
    expect(parsed.topK).toBe(40);
    expect(parsed.topP).toBe(0.95);
    expect(parsed.minP).toBe(0.05);
    expect(parsed.repeatPenalty).toBe(1.1);
    expect(parsed.contextOverflowPolicy).toBe("TruncateMiddle");
    expect(parsed.thinkingEnabled).toBe(true);
  });

  it("resolves the effective app data dir inside tests/data", () => {
    expect(getAppDataDir()).toBe(path.resolve(import.meta.dir, "../data/.llamaforge"));
  });

  it("turns foreign keys back on when the chats parent migration fails", async () => {
    const file = path.join(os.tmpdir(), `llamaforge-fk-${Date.now()}.db`);
    const setup = new Database(file);
    setup.exec(`
      CREATE TABLE chats (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL DEFAULT 'New Chat',
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        parent_id TEXT REFERENCES chats(id),
        is_branch INTEGER NOT NULL DEFAULT 0,
        model_path TEXT,
        system_preset_id TEXT,
        inference_preset_id TEXT
      );
    `);
    setup.exec("PRAGMA user_version = 3;");
    setup.close();

    const originalExec = Database.prototype.exec;
    Database.prototype.exec = function (sql: string) {
      if (sql.includes("INSERT INTO chats_new")) {
        throw new Error("forced migration failure");
      }
      return originalExec.call(this, sql);
    };

    try {
      resetDb();
      expect(() => getDb(file)).toThrow("forced migration failure");
      const foreignKeys = getDb().query<{ foreign_keys: number }, []>("PRAGMA foreign_keys").get();
      expect(foreignKeys?.foreign_keys).toBe(1);
    } finally {
      Database.prototype.exec = originalExec;
      resetDb();
      await fs.rm(file, { force: true });
      await fs.rm(`${file}-wal`, { force: true });
      await fs.rm(`${file}-shm`, { force: true });
      await initDb(":memory:");
    }
  });

  it("enables incremental auto_vacuum once for an existing database", async () => {
    const file = path.join(os.tmpdir(), `llamaforge-vacuum-${Date.now()}.db`);
    const setup = new Database(file);
    setup.exec("CREATE TABLE legacy (id INTEGER PRIMARY KEY);");
    setup.exec("PRAGMA user_version = 4;");
    const before = setup.query<{ auto_vacuum: number }, []>("PRAGMA auto_vacuum").get();
    expect(before?.auto_vacuum).toBe(0);
    setup.close();

    try {
      resetDb();
      const migrated = getDb(file);
      expect(
        migrated.query<{ auto_vacuum: number }, []>("PRAGMA auto_vacuum").get()?.auto_vacuum,
      ).toBe(2);
      expect(
        migrated.query<{ user_version: number }, []>("PRAGMA user_version").get()?.user_version,
      ).toBe(5);
      resetDb();
      const reopened = getDb(file);
      expect(
        reopened.query<{ auto_vacuum: number }, []>("PRAGMA auto_vacuum").get()?.auto_vacuum,
      ).toBe(2);
      expect(
        reopened.query<{ user_version: number }, []>("PRAGMA user_version").get()?.user_version,
      ).toBe(5);
    } finally {
      resetDb();
      await fs.rm(file, { force: true });
      await fs.rm(`${file}-wal`, { force: true });
      await fs.rm(`${file}-shm`, { force: true });
      await initDb(":memory:");
    }
  });
});
