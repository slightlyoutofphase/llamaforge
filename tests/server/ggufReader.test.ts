/**
 * @packageDocumentation
 * Tests for GGUF metadata parsing and edge case handling.
 */

import { describe, expect, it, mock } from "bun:test";
import { gguf as readGgufFile } from "@huggingface/gguf";

const readRealGguf = readGgufFile;

// Fixture paths stay synthetic. Any other path, including a real projector
// opened by another file in this process, uses the library's own parser.
mock.module("@huggingface/gguf", () => {
  return {
    gguf: async (filePath: string, options?: { allowLocalFile?: boolean }) => {
      if (filePath === "fail.gguf") throw new Error("Parse failed");
      if (filePath === "mmproj-flags.gguf") {
        return {
          metadata: {
            "general.architecture": "clip",
            "clip.has_vision_encoder": true,
            "clip.has_audio_encoder": 1,
          },
        };
      }
      if (filePath === "audio-only-mmproj.gguf") {
        return {
          metadata: {
            "general.architecture": "clip",
            "clip.has_vision_encoder": false,
            "clip.has_audio_encoder": true,
            "clip.projector_type": "audio",
          },
        };
      }
      if (filePath === "clip-projector.gguf") {
        return {
          metadata: {
            "general.architecture": "clip",
            "clip.projector_type": "gemma4",
          },
        };
      }
      if (filePath === "temp_new.gguf") {
        return {
          metadata: {
            "general.architecture": "llama",
            "general.sampling.temp": 0.8,
          },
        };
      }
      if (filePath === "tools-template.gguf") {
        return {
          metadata: {
            "general.architecture": "gemma4",
            "general.name": "Tool Model",
            "tokenizer.chat_template":
              "{%- if tools %}{% for tool in tools %}{{ tool.function.name }}{% endfor %}{% endif %}{% for message in messages %}{% if message.tool_calls %}{{ message.tool_calls }}{% endif %}{{ message.content }}{% endfor %}",
          },
        };
      }
      if (filePath === "test.gguf") {
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
      }
      return readRealGguf(filePath, options);
    },
  };
});

import { describeGgufQuantization, parseGgufMetadata } from "../../src/server/ggufReader";

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

  it("keeps an explicit clip.has_vision_encoder false even when the architecture is clip", async () => {
    const meta = await parseGgufMetadata("audio-only-mmproj.gguf");
    expect(meta.hasVisionEncoder).toBe(false);
    expect(meta.hasAudioEncoder).toBe(true);
  });

  it("falls back to architecture and projector type only when encoder flags are absent", async () => {
    const meta = await parseGgufMetadata("clip-projector.gguf");
    expect(meta.hasVisionEncoder).toBe(true);
    expect(meta.hasAudioEncoder).toBe(false);
  });

  it("uses llama.cpp file-type names for the corrected quantization ids", () => {
    expect(describeGgufQuantization(7)).toBe("Q8_0");
    expect(describeGgufQuantization(8)).toBe("Q5_0");
    expect(describeGgufQuantization(9)).toBe("Q5_1");
    expect(describeGgufQuantization(27)).toBe("IQ3_M");
    expect(describeGgufQuantization(28)).toBe("IQ2_S");
    expect(describeGgufQuantization(30)).toBe("IQ4_XS");
    expect(describeGgufQuantization(32)).toBe("BF16");
    expect(describeGgufQuantization(6)).toBe("TYPE_6");
  });

  it("throws on failure", async () => {
    await expect(parseGgufMetadata("fail.gguf")).rejects.toThrow("Parse failed");
  });
});
