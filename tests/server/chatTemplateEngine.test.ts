/**
 * @packageDocumentation
 * Tests for the chat template engine and thinking tag parsing.
 */

import { describe, expect, it } from "bun:test";
import { detectThinkingConfig, parseThinkTags } from "../../src/server/chatTemplateEngine";

describe("chatTemplateEngine", () => {
  describe("detectThinkingConfig", () => {
    it("detects thinking config for gemma4 architecture", () => {
      const config = detectThinkingConfig("gemma4");
      expect(config.openTag).toBe("<|channel>thought\n");
      expect(config.closeTag).toBe("<channel|>");
    });

    it("detects thinking config for hyphen and underscore Gemma 4 variants", () => {
      expect(detectThinkingConfig("gemma-4").openTag).toBe("<|channel>thought\n");
      expect(detectThinkingConfig("gemma_4").closeTag).toBe("<channel|>");
    });

    it("defaults to plain <think> tags for standard models", () => {
      const config = detectThinkingConfig();
      expect(config.openTag).toBe("<think>");
      expect(config.closeTag).toBe("</think>");
    });
  });

  describe("parseThinkTags", () => {
    it("parses empty string", () => {
      expect(parseThinkTags("", "<think>", "</think>")).toEqual({
        content: "",
        thinking: "",
        isThinking: false,
      });
    });

    it("parses text without tags", () => {
      expect(parseThinkTags("hello world", "<think>", "</think>")).toEqual({
        content: "hello world",
        thinking: "",
        isThinking: false,
      });
    });

    it("parses text with single thinking block completed", () => {
      expect(
        parseThinkTags("before <think>some thought</think> after", "<think>", "</think>"),
      ).toEqual({
        content: "before  after",
        thinking: "some thought",
        isThinking: false,
      });
    });

    it("parses text with multiple thinking blocks", () => {
      expect(
        parseThinkTags(
          "before <think>one</think> mid <think>two</think> after",
          "<think>",
          "</think>",
        ),
      ).toEqual({
        content: "before  mid  after",
        thinking: "onetwo",
        isThinking: false,
      });
    });

    it("handles partial open tags safely without emitting them to content", () => {
      expect(parseThinkTags("before <thi", "<think>", "</think>")).toEqual({
        content: "before ",
        thinking: "",
        isThinking: false,
      });
      expect(parseThinkTags("before <", "<think>", "</think>")).toEqual({
        content: "before ",
        thinking: "",
        isThinking: false,
      });
    });

    it("handles full open tag but unclosed block", () => {
      expect(parseThinkTags("before <think>running though...", "<think>", "</think>")).toEqual({
        content: "before ",
        thinking: "running though...",
        isThinking: true,
      });
    });

    it("handles partial close tags over thinking block safely", () => {
      expect(parseThinkTags("before <think>running though...</th", "<think>", "</think>")).toEqual({
        content: "before ",
        thinking: "running though...",
        isThinking: true,
      });
      expect(parseThinkTags("before <think>running though...</", "<think>", "</think>")).toEqual({
        content: "before ",
        thinking: "running though...",
        isThinking: true,
      });
    });

    it("ignores missing configs", () => {
      expect(parseThinkTags("before <think>test", "", "</think>")).toEqual({
        content: "before <think>test",
        thinking: "",
        isThinking: false,
      });
    });
  });
});
