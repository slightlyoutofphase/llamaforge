/**
 * @packageDocumentation
 * Tests for token overflow detection and truncation behavior.
 */

import { afterEach, describe, expect, it, mock } from "bun:test";
import type { ChatMessage } from "@shared/types";
import { getTokens, truncateMessages } from "../../src/server/overflow";

const originalFetch = globalThis.fetch;

describe("overflow logic", () => {
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

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

  it("computes attachment token estimates with default image/audio budgets", async () => {
    const msgs = [
      {
        ...mockMsg("user", "Hello"),
        attachments: [{ mimeType: "image/png" }, { mimeType: "audio/wav" }],
      },
    ];

    const tokens = await getTokens(msgs);
    // Base heuristic strings ~ 2.
    // Audio baseline = 256
    // Image baseline = 560
    // Total should be around 818
    expect(tokens).toBeGreaterThan(810);
    expect(tokens).toBeLessThan(830);
  });

  it("tokenizes the serialized prompt payload once and reuses the cached count", async () => {
    const msgs = [mockMsg("system", "SYS"), mockMsg("user", "One"), mockMsg("assistant", "Two")];
    const fetchMock = mock().mockImplementation(async (_input: RequestInfo, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body ?? "{}")) as { content?: string };
      const tokenCount = Math.max(1, Math.ceil((body.content?.length ?? 0) / 4));
      return new Response(JSON.stringify({ tokens: new Array(tokenCount).fill(1) }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    });
    globalThis.fetch = fetchMock;

    const first = await getTokens(msgs, 8080);
    const second = await getTokens(msgs, 8080);

    expect(first).toBe(second);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("truncates based on tool and schema overhead in the assembled request payload", async () => {
    const msgs = [
      mockMsg("system", "SYS".repeat(20)),
      mockMsg("assistant", "OLD ".repeat(120)),
      mockMsg("user", "LATEST QUESTION".repeat(8)),
    ];

    const result = await truncateMessages([...msgs], "RollingWindow", 1024, 512, undefined, true, {
      buildPromptText: async (messages) =>
        JSON.stringify({
          messages: messages.map((message) => ({ role: message.role, content: message.content })),
          tools: [
            {
              type: "function",
              function: {
                name: "tool",
                description: "T".repeat(1400),
                parameters: {
                  type: "object",
                  properties: { value: { type: "string" } },
                },
              },
            },
          ],
          response_format: {
            type: "json_schema",
            json_schema: {
              type: "object",
              properties: {
                result: { type: "string", description: "S".repeat(200) },
              },
            },
          },
        }),
    });

    expect(result).toHaveLength(2);
    expect(result[0].role).toBe("system");
    expect(result[1].role).toBe("user");
    expect(result[1].content).toContain("LATEST QUESTION");
  });
});
