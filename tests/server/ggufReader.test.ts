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
      if (path === "mmproj-flags.gguf") {
        return {
          metadata: {
            "general.architecture": "clip",
            "clip.has_vision_encoder": true,
            "clip.has_audio_encoder": 1,
          },
        };
      }
      if (path === "temp_new.gguf") {
        return {
          metadata: {
            "general.architecture": "llama",
            "general.sampling.temp": 0.8,
          },
        };
      }
      if (path === "tools-template.gguf") {
        return {
          metadata: {
            "general.architecture": "gemma4",
            "general.name": "Tool Model",
            "tokenizer.chat_template":
              "{%- if tools %}{% for tool in tools %}{{ tool.function.name }}{% endfor %}{% endif %}{% for message in messages %}{% if message.tool_calls %}{{ message.tool_calls }}{% endif %}{{ message.content }}{% endfor %}",
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
    expect(meta.hasToolCalling).toBe(false);
  });

  it("sets hasToolCalling from a Jinja template that describes tools and tool_calls", async () => {
    const meta = await parseGgufMetadata("tools-template.gguf");
    expect(meta.hasToolCalling).toBe(true);
  });

  it("successfully parses general.sampling.temp fallback", async () => {
    const meta = await parseGgufMetadata("temp_new.gguf");
    expect(meta.defaultTemperature).toBe(0.8);
  });

  it("reads clip.has_vision_encoder and clip.has_audio_encoder from companion mmproj headers", async () => {
    const meta = await parseGgufMetadata("mmproj-flags.gguf");
    expect(meta.hasVisionEncoder).toBe(true);
    expect(meta.hasAudioEncoder).toBe(true);
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
