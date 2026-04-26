/**
 * @packageDocumentation
 * Tests for GGUF metadata parsing and edge case handling.
 */

import { describe, expect, it, mock } from "bun:test";

// Mock @huggingface/gguf
mock.module("@huggingface/gguf", () => {
  return {
    gguf: async (path: string) => {
      if (path === "fail.gguf") throw new Error("Parse failed");
      if (path === "temp_new.gguf") {
        return {
          metadata: {
            "general.architecture": "llama",
            "general.sampling.temp": 0.8,
          },
        };
      }
      return {
        metadata: {
          "general.architecture": "llama",
          "general.name": "Test Model",
          "general.file_type": 1,
          "general.sampling.temperature": 0.7,
          "llama.context_length": 4096,
          "llama.block_count": 24,
          "tokenizer.chat_template":
            "{% for message in messages %}{{ message.role }}: {{ message.content }}{% endfor %}",
        },
      };
    },
  };
});

import { parseGgufMetadata } from "../../src/server/ggufReader";

describe("ggufReader", () => {
  it("successfully parses mock metadata", async () => {
    const meta = await parseGgufMetadata("test.gguf");
    expect(meta.architecture).toBe("llama");
    expect(meta.name).toBe("Test Model");
    expect(meta.contextLength).toBe(4096);
    expect(meta.blockCount).toBe(24);
    expect(meta.defaultTemperature).toBe(0.7);
    expect(meta.chatTemplate).toContain("message.role");
  });

  it("successfully parses general.sampling.temp fallback", async () => {
    const meta = await parseGgufMetadata("temp_new.gguf");
    expect(meta.defaultTemperature).toBe(0.8);
  });

  it("throws on failure", async () => {
    try {
      await parseGgufMetadata("fail.gguf");
      expect(true).toBe(false); // should not reach
    } catch (e: any) {
      expect(e.message).toBe("Parse failed");
    }
  });
});
