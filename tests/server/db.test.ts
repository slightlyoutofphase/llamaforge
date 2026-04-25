import { beforeEach, describe, expect, it } from "bun:test";
import { getDb, initDb } from "../../src/server/persistence/db";

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
  });
});
