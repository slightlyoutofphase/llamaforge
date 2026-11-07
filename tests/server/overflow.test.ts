/**
 * @packageDocumentation
 * Tests for token overflow detection and truncation behavior.
 */

import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import type { Attachment, ChatMessage } from "@shared/types";
import {
  ContextOverflowError,
  getTokenizerEpoch,
  getTokens,
  resetTokenCountCache,
  truncateMessages,
} from "../../src/server/overflow";
import { asFetch } from "../fixtures";

const originalFetch = globalThis.fetch;

describe("overflow logic", () => {
  beforeEach(() => {
    resetTokenCountCache();
    globalThis.fetch = asFetch(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const body = JSON.parse(String(init?.body ?? "{}")) as {
        content?: string;
        messages?: unknown;
      };
      if (url.includes("/apply-template")) {
        return new Response(JSON.stringify({ prompt: JSON.stringify(body) }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      const content = body.content ?? "";
      const tokenCount = Math.max(1, Math.ceil(content.length / 3.5));
      return new Response(JSON.stringify({ tokens: new Array(tokenCount).fill(1) }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    });
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    resetTokenCountCache();
  });

  const mockMsg = (role: ChatMessage["role"], content: string): ChatMessage => ({
    id: Math.random().toString(),
    chatId: "1",
    role,
    content,
    rawContent: content,
    position: 0,
    createdAt: Date.now(),
  });

  const mockAttachment = (mimeType: string): Attachment => ({
    id: `att-${mimeType}`,
    messageId: "1",
    mimeType,
    filePath: `attachments/${mimeType.replace("/", "-")}`,
    fileName: "file",
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
    const result = await truncateMessages([...msgs], "TruncateMiddle", 1024, 512, 8080);

    expect(result.length).toBe(3);
    expect(result[0]?.role).toBe("system");
    expect(result[1]?.role).toBe("user");
    expect(result[1]?.content).toContain("FIRST USER");
    expect(result[2]?.role).toBe("user");
    expect(result[2]?.content).toBe("LATEST QUERY");
  });

  it("RollingWindow removes oldest until fit (excluding system)", async () => {
    const msgs = [
      mockMsg("system", "SYS"),
      mockMsg("user", "OLD 1 ".repeat(400)),
      mockMsg("assistant", "OLD 2"),
      mockMsg("user", "LATEST"),
    ];

    // maxPrompt 512.
    // msgs total ~ 1 + 342 + 342 + 1 = 686. Needs to remove OLD 1.
    const result = await truncateMessages([...msgs], "RollingWindow", 1024, 512, 8080);

    expect(result.length).toBe(3);
    expect(result[0]?.role).toBe("system");
    expect(result[1]?.content).toContain("OLD 2");
    expect(result[2]?.content).toBe("LATEST");
  });

  it("throws when the only message still exceeds the window", async () => {
    const msgs = [mockMsg("user", "A".repeat(10000))];
    await expect(
      truncateMessages([...msgs], "RollingWindow", 1024, 512, 8080),
    ).rejects.toBeInstanceOf(ContextOverflowError);
  });

  it("adds stored virBudget values to the tokenized template string", async () => {
    const msgs = [
      {
        ...mockMsg("user", "Hello"),
        attachments: [
          { ...mockAttachment("image/png"), virBudget: 560 },
          { ...mockAttachment("audio/wav"), virBudget: 256 },
        ],
      },
    ];

    const tokens = await getTokens(msgs, 8080);
    const applied = JSON.stringify({
      messages: [{ role: "user", content: "Hello", tool_call_id: undefined }].map((message) => ({
        role: message.role,
        content: message.content,
        ...(message.tool_call_id ? { tool_call_id: message.tool_call_id } : {}),
      })),
    });
    // The mock tokenizes JSON.stringify of the apply-template body.
    const textTokens = Math.max(
      1,
      Math.ceil(
        JSON.stringify({
          messages: [{ role: "user", content: "Hello" }],
        }).length / 3.5,
      ),
    );
    expect(tokens).toBe(textTokens + 560 + 256);
    expect(applied.length).toBeGreaterThan(0);
  });

  it("tokenizes the serialized prompt payload once and reuses the cached count", async () => {
    const msgs = [mockMsg("system", "SYS"), mockMsg("user", "One"), mockMsg("assistant", "Two")];
    const fetchMock = mock().mockImplementation(
      async (input: RequestInfo | URL, init?: RequestInit) => {
        const body = JSON.parse(String(init?.body ?? "{}")) as { content?: string };
        if (String(input).includes("/apply-template")) {
          return new Response(JSON.stringify({ prompt: JSON.stringify(body) }), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          });
        }
        const tokenCount = Math.max(1, Math.ceil((body.content?.length ?? 0) / 4));
        return new Response(JSON.stringify({ tokens: new Array(tokenCount).fill(1) }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      },
    );
    globalThis.fetch = asFetch(fetchMock);

    const first = await getTokens(msgs, 8080);
    const second = await getTokens(msgs, 8080);

    expect(first).toBe(second);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("tokenizes again after the token-count cache is reset", async () => {
    const msgs = [mockMsg("user", "reset me")];
    const fetchMock = mock().mockImplementation(async (input: RequestInfo | URL) => {
      if (String(input).includes("/apply-template")) {
        return new Response(JSON.stringify({ prompt: "reset me" }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      return new Response(JSON.stringify({ tokens: [1, 1, 1] }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    });
    globalThis.fetch = asFetch(fetchMock);
    const epoch = getTokenizerEpoch();

    const first = await getTokens(msgs, 8080);
    resetTokenCountCache();
    const second = await getTokens(msgs, 8080);

    expect(first).toBe(second);
    expect(fetchMock).toHaveBeenCalledTimes(4);
    expect(getTokenizerEpoch()).toBe(epoch + 1);
  });

  it("truncates based on tool and schema overhead in the assembled request payload", async () => {
    const msgs = [
      mockMsg("system", "SYS".repeat(20)),
      mockMsg("assistant", "OLD ".repeat(2500)),
      mockMsg("user", "LATEST QUESTION".repeat(8)),
    ];

    const result = await truncateMessages([...msgs], "RollingWindow", 1024, 512, 8080, true, {
      tools: [
        {
          type: "function",
          function: {
            name: "tool",
            description: "T".repeat(80),
            parameters: {
              type: "object",
              properties: { value: { type: "string" } },
            },
          },
        },
      ],
      responseFormat: {
        type: "json_schema",
        schema: {
          type: "object",
          properties: {
            result: { type: "string", description: "S".repeat(40) },
          },
        },
      },
    });

    expect(result).toHaveLength(2);
    expect(result[0]?.role).toBe("system");
    expect(result[1]?.role).toBe("user");
    expect(result[1]?.content).toContain("LATEST QUESTION");
  });

  it("drops another group when the character estimate still exceeds the exact token count", async () => {
    const msgs = [
      mockMsg("system", "SYS"),
      mockMsg("user", "A".repeat(400)),
      mockMsg("assistant", "B".repeat(400)),
      mockMsg("user", "LATEST"),
    ];
    const fetchMock = mock().mockImplementation(
      async (input: RequestInfo | URL, init?: RequestInit) => {
        const body = JSON.parse(String(init?.body ?? "{}")) as { content?: string };
        if (String(input).includes("/apply-template")) {
          return new Response(JSON.stringify({ prompt: JSON.stringify(body) }), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          });
        }
        const tokenCount = Math.max(1, (body.content?.length ?? 0) * 2);
        return new Response(JSON.stringify({ tokens: new Array(tokenCount).fill(1) }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      },
    );
    globalThis.fetch = asFetch(fetchMock);
    resetTokenCountCache();

    const result = await truncateMessages([...msgs], "RollingWindow", 1024, 512, 8080);

    expect(result.map((message) => message.role)).toEqual(["system", "user"]);
    expect(result.at(-1)?.content).toBe("LATEST");
    expect(fetchMock.mock.calls.length).toBeGreaterThan(0);
    expect(fetchMock.mock.calls.length).toBeLessThanOrEqual(12);
  });

  it("TruncateMiddle removes assistant tool-call groups atomically", async () => {
    const toolCallsJson = JSON.stringify([
      {
        id: "call_1",
        type: "function",
        function: { name: "calculate", arguments: '{"expression":"2+2"}' },
      },
    ]);
    const msgs: ChatMessage[] = [
      mockMsg("system", "SYS ".repeat(100)),
      mockMsg("user", "FIRST USER ".repeat(100)),
      {
        ...mockMsg("assistant", "CALL ".repeat(1000)),
        toolCallsJson,
      },
      { ...mockMsg("tool", "RESULT ".repeat(200)), toolCallId: "call_1" },
      mockMsg("user", "LATEST QUERY"),
    ];

    const result = await truncateMessages([...msgs], "TruncateMiddle", 1024, 512, 8080);
    const roles = result.map((message) => message.role);
    const toolIndex = roles.indexOf("tool");
    if (toolIndex !== -1) {
      expect(roles[toolIndex - 1]).toBe("assistant");
      expect(result[toolIndex - 1]?.toolCallsJson).toBeTruthy();
    }
    expect(result.some((message) => message.role === "tool" && !roles.includes("assistant"))).toBe(
      false,
    );
    expect(result.at(-1)?.content).toBe("LATEST QUERY");
    expect(result.find((message) => message.toolCallsJson)).toBeUndefined();
    expect(result.find((message) => message.role === "tool")).toBeUndefined();
  });

  it("StopAtLimit throws before returning an oversized history", async () => {
    const msgs = [
      mockMsg("system", "SYS ".repeat(100)),
      mockMsg("user", "FIRST USER ".repeat(100)),
      mockMsg("assistant", "MIDDLE ".repeat(1000)),
      mockMsg("user", "LATEST QUERY"),
    ];
    await expect(
      truncateMessages([...msgs], "StopAtLimit", 1024, 512, 8080),
    ).rejects.toBeInstanceOf(ContextOverflowError);
  });
});
