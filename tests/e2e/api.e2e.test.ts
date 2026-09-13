/**
 * @packageDocumentation
 * HTTP-level end-to-end tests against the real Bun router (no llama-server required).
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { addMessage, createChat } from "../../src/server/persistence/chatRepo";
import { initDb, resetDb } from "../../src/server/persistence/db";
import { loadSettings } from "../../src/server/persistence/settingsRepo";
import { createRouter } from "../../src/server/router";
import { DEFAULT_APP_SETTINGS } from "../../src/shared/defaults";
import { noUpgradeServer } from "../fixtures";

describe("E2E API router", () => {
  beforeEach(async () => {
    await initDb(":memory:");
  });

  afterEach(() => {
    resetDb();
  });

  it("serves health, default settings, runtime usage, and per-chat context occupancy", async () => {
    const router = createRouter();

    const health = await router.fetch(new Request("http://localhost/health"), noUpgradeServer);
    expect(health?.status).toBe(200);
    expect(await health?.text()).toBe("OK");

    const settingsRes = await router.fetch(
      new Request("http://localhost/api/settings"),
      noUpgradeServer,
    );
    const settings = (await settingsRes?.json()) as {
      autoloadLastModel?: boolean;
      fontSize?: number;
    };
    expect(settings.autoloadLastModel).toBe(DEFAULT_APP_SETTINGS.autoloadLastModel);
    expect(settings.fontSize).toBe(DEFAULT_APP_SETTINGS.fontSize);

    const persisted = await loadSettings();
    expect(persisted.autoloadLastModel).toBe(false);
    expect(persisted.includeVideoAudio).toBe(false);

    const usageRes = await router.fetch(
      new Request("http://localhost/api/runtime/usage"),
      noUpgradeServer,
    );
    const usage = (await usageRes?.json()) as { ramBytes?: number; vramBytes?: number };
    expect(usage.ramBytes).toBeGreaterThan(0);
    expect(usage.vramBytes).toBeGreaterThanOrEqual(0);

    const chat = await createChat("E2E occupancy");
    await addMessage({
      id: Bun.randomUUIDv7(),
      chatId: chat.id,
      role: "user",
      content: "end to end context occupancy",
      rawContent: "end to end context occupancy",
      position: 0,
      createdAt: Date.now(),
    });
    const empty = await createChat("E2E empty");

    const occupied = await router.fetch(
      new Request(`http://localhost/api/chats/${chat.id}/context-usage`),
      noUpgradeServer,
    );
    const vacant = await router.fetch(
      new Request(`http://localhost/api/chats/${empty.id}/context-usage`),
      noUpgradeServer,
    );
    const occupiedBody = (await occupied?.json()) as { usedTokens?: number };
    const vacantBody = (await vacant?.json()) as { usedTokens?: number };
    expect(occupiedBody.usedTokens).toBeGreaterThan(vacantBody.usedTokens ?? 0);
    expect(vacantBody.usedTokens).toBe(0);
  });
});
