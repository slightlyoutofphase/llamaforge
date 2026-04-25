import { describe, expect, it } from "bun:test";
import type { ChatMessage } from "@shared/types";
import { truncateMessages } from "../../src/server/overflow";

describe("overflow logic", () => {
  const mockMsg = (role: any, content: string): ChatMessage => ({
    id: Math.random().toString(),
    chatId: "1",
    role,
    content,
    rawContent: content,
    position: 0,
    createdAt: Date.now(),
  });

  it("TruncateMiddle protects system and first user message", async () => {
    const msgs = [
      mockMsg("system", "SYS ".repeat(100)), // ~ 400 chars -> 114 tokens
      mockMsg("user", "FIRST USER ".repeat(100)), // ~ 1100 chars -> 314 tokens
      mockMsg("assistant", "MIDDLE ".repeat(1000)), // ~ 7000 chars -> 2000 tokens
      mockMsg("user", "LATEST QUERY"),
    ];

    // ctxSize 1024, maxTokens 512 -> maxPrompt 512 tokens.
    // msgs total ~ 114 + 314 + 2000 + 3 = 2431 tokens.
    // TruncateMiddle should remove the MIDDLE message.
    const result = await truncateMessages([...msgs], "TruncateMiddle", 1024, 512);

    expect(result.length).toBe(3);
    expect(result[0].role).toBe("system");
    expect(result[1].role).toBe("user");
    expect(result[1].content).toContain("FIRST USER");
    expect(result[2].role).toBe("user");
    expect(result[2].content).toBe("LATEST QUERY");
  });

  it("RollingWindow removes oldest until fit (excluding system)", async () => {
    const msgs = [
      mockMsg("system", "SYS"),
      mockMsg("user", "OLD 1 ".repeat(200)), // ~ 1200 chars -> 342 tokens
      mockMsg("assistant", "OLD 2 ".repeat(200)), // ~ 1200 chars -> 342 tokens
      mockMsg("user", "LATEST"),
    ];

    // maxPrompt 512.
    // msgs total ~ 1 + 342 + 342 + 1 = 686. Needs to remove OLD 1.
    const result = await truncateMessages([...msgs], "RollingWindow", 1024, 512);

    expect(result.length).toBe(3);
    expect(result[0].role).toBe("system");
    expect(result[1].content).toContain("OLD 2");
    expect(result[2].content).toBe("LATEST");
  });

  it("Hard fallback truncates the query if it's too giant", async () => {
    const msgs = [
      mockMsg("user", "A".repeat(10000)), // ~ 2800 tokens
    ];
    // maxPrompt 512. Max chars ~ 512 * 3 = 1536.
    const result = await truncateMessages([...msgs], "RollingWindow", 1024, 512);
    expect(result[0].content).toContain("[TRUNCATED]");
    expect(result[0].content.length).toBeLessThan(2000);
  });

  const { getTokens } = require("../../src/server/overflow");
  it("computes attachment vir budgets accurately into token totals", async () => {
    const msgs = [
      {
        ...mockMsg("user", "Hello"), // small text: 5 chars / 3.5 = ~2 tokens + 1 = 3 padding
        attachments: [{ mimeType: "image/png", virBudget: 750 }, { mimeType: "audio/wav" }],
      },
    ];

    const tokens = await getTokens(msgs);
    // Base heuristic strings ~ 2.
    // Audio baseline = 256
    // Image base via virBudget = 750
    // Total should be around 1008
    expect(tokens).toBeGreaterThan(1000);
    expect(tokens).toBeLessThan(1020);
  });
});
