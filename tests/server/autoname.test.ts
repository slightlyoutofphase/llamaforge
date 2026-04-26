/**
 * @packageDocumentation
 * Tests for automatic chat naming behavior.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { triggerAutoname } from "../../src/server/autoname";
import { initDb, resetDb } from "../../src/server/persistence/db";

describe("autoname", () => {
  beforeEach(async () => {
    await initDb(":memory:");
  });

  afterEach(() => {
    resetDb();
  });

  it("ignores invalid or short chats", async () => {
    // If we call triggerAutoname with a nonexistent ID, it should gracefully return without throwing
    await expect(triggerAutoname("nonexistent_id")).resolves.toBeUndefined();
  });
});
