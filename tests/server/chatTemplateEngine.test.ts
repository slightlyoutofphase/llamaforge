/**
 * @packageDocumentation
 * Tests for the chat template engine and thinking tag parsing.
 */

import { describe, expect, it } from "bun:test";
import {
  detectThinkingConfig,
  parseThinkTags,
  prepareHistoryForRender,
} from "../../src/server/chatTemplateEngine";

describe("chatTemplateEngine", () => {
  describe("detectThinkingConfig", () => {
    it("detects thinking config for gemma4 architecture", () => {
      const config = detectThinkingConfig("gemma4");
      expect(config.openTag).toBe("<|channel>thought\n");
      expect(config.closeTag).toBe("<channel|>");
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

  describe("prepareHistoryForRender", () => {
    it("formats history properly without thinking tags for assistant", () => {
      const history = prepareHistoryForRender(
        [
          {
            id: "1",
            chatId: "2",
            role: "assistant",
            content: "Final",
            rawContent: "<think>\nhmm</think>\nFinal",
            thinkingContent: "hmm",
            position: 0,
            createdAt: 0,
          },
        ],
        {
          openTag: "<think>\n",
          closeTag: "</think>\n",
          enableToken: undefined,
        },
      );

      // Fallback parser strips think
      expect(history[0].content).toBe("Final");
    });

    it("handles multiple thinking blocks and half-open tags in history rendering", () => {
      const history = prepareHistoryForRender(
        [
          {
            id: "1",
            chatId: "2",
            role: "assistant",
            content: "Part 1 Part 2 Half",
            rawContent: "<think>\n1</think>\nPart 1 <think>\n2</think>\nPart 2 <think>\nhalf... ",
            position: 0,
            createdAt: 0,
          },
        ],
        {
          openTag: "<think>\n",
          closeTag: "</think>\n",
          enableToken: undefined,
        },
      );

      expect(history[0].content).toBe("Part 1 Part 2");
    });
  });
});
