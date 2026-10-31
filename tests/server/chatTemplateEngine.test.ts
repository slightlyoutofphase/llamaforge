/**
 * @packageDocumentation
 * Tests for the chat template engine and thinking tag parsing.
 */

import { describe, expect, it } from "bun:test";
import {
  applyAssistantStreamDelta,
  detectThinkingConfig,
  finalizeAssistantStreamState,
  inferNativeReasoningReuse,
  parseThinkTags,
  parseThinkTagsWithFallback,
  reconstructPreservedAssistantContent,
  shouldReconstructPreservedAssistantContent,
  shouldSendAssistantReasoningContent,
} from "../../src/server/chatTemplateEngine";
import { GEMMA4_THINKING_CONFIG } from "../../src/shared/thinkingTags";

describe("chatTemplateEngine", () => {
  describe("detectThinkingConfig", () => {
    it("detects thinking config for gemma4 architecture", () => {
      const config = detectThinkingConfig("gemma4");
      expect(config.openTag).toBe("<|channel>thought");
      expect(config.closeTag).toBe("<channel|>");
    });

    it("detects thinking config for hyphen and underscore Gemma 4 variants", () => {
      expect(detectThinkingConfig("gemma-4").openTag).toBe("<|channel>thought");
      expect(detectThinkingConfig("gemma_4").closeTag).toBe("<channel|>");
    });

    it("defaults to plain <think> tags for standard models", () => {
      const config = detectThinkingConfig();
      expect(config.openTag).toBe("<think>");
      expect(config.closeTag).toBe("</think>");
    });

    it("fills missing override fields from architecture defaults", () => {
      const config = detectThinkingConfig("gemma4", {
        openTag: "<custom>",
        closeTag: "",
        enableToken: undefined,
      });
      expect(config.openTag).toBe("<custom>");
      expect(config.closeTag).toBe("<channel|>");
      expect(config.enableToken).toBe("<|think|>");
    });

    it("keeps a complete user override on a non-Gemma architecture", () => {
      const config = detectThinkingConfig("llama", {
        openTag: "<a>",
        closeTag: "</a>",
        enableToken: "<tok>",
      });
      expect(config).toEqual({
        openTag: "<a>",
        closeTag: "</a>",
        enableToken: "<tok>",
      });
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
      expect(
        parseThinkTags(
          "before <|c",
          GEMMA4_THINKING_CONFIG.openTag,
          GEMMA4_THINKING_CONFIG.closeTag,
        ),
      ).toEqual({
        content: "before ",
        thinking: "",
        isThinking: false,
      });
    });

    it("keeps a trailing tag prefix once the reply is finished", () => {
      expect(parseThinkTags("before <", "<think>", "</think>", { final: true })).toEqual({
        content: "before <",
        thinking: "",
        isThinking: false,
      });
      expect(
        parseThinkTags(
          "before <|c",
          GEMMA4_THINKING_CONFIG.openTag,
          GEMMA4_THINKING_CONFIG.closeTag,
          { final: true },
        ),
      ).toEqual({
        content: "before <|c",
        thinking: "",
        isThinking: false,
      });
      expect(
        parseThinkTags("before <think>running though...</", "<think>", "</think>", {
          final: true,
        }),
      ).toEqual({
        content: "before ",
        thinking: "running though...</",
        isThinking: true,
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

    it("parses Gemma 4 thought tags that open with a space instead of a newline", () => {
      expect(
        parseThinkTags(
          "<|channel>thought plan<channel|>answer",
          GEMMA4_THINKING_CONFIG.openTag,
          GEMMA4_THINKING_CONFIG.closeTag,
        ),
      ).toEqual({
        content: "answer",
        thinking: "plan",
        isThinking: false,
      });
    });

    it("does not treat thoughtful as a Gemma thought open tag", () => {
      expect(
        parseThinkTags(
          "be thoughtful please",
          GEMMA4_THINKING_CONFIG.openTag,
          GEMMA4_THINKING_CONFIG.closeTag,
        ),
      ).toEqual({
        content: "be thoughtful please",
        thinking: "",
        isThinking: false,
      });
    });
  });

  describe("parseThinkTagsWithFallback", () => {
    it("extracts Gemma channel tags when the configured delimiters are <think>", () => {
      expect(
        parseThinkTagsWithFallback(
          "<|channel>thought\nplan<channel|>answer",
          "<think>",
          "</think>",
        ),
      ).toEqual({
        content: "answer",
        thinking: "plan",
        isThinking: false,
      });
    });
  });

  describe("applyAssistantStreamDelta", () => {
    it("extracts thinking from in-content tags using the provided delimiters", () => {
      const state = {
        fullRawContent: "",
        prevContent: "",
        prevThinking: "",
        usedNativeReasoning: false,
      };
      applyAssistantStreamDelta(state, "<think>plan</think>done", "", "<think>", "</think>");
      expect(state.prevContent).toBe("done");
      expect(state.prevThinking).toBe("plan");
      expect(state.usedNativeReasoning).toBe(false);
    });

    it("reports isThinking until the close tag, then streams later content as the answer", () => {
      const state = {
        fullRawContent: "",
        prevContent: "",
        prevThinking: "",
        usedNativeReasoning: false,
      };
      expect(
        applyAssistantStreamDelta(state, "<think>plan", "", "<think>", "</think>").isThinking,
      ).toBe(true);
      expect(state.prevContent).toBe("");
      expect(applyAssistantStreamDelta(state, "</think>answer", "", "<think>", "</think>")).toEqual(
        {
          contentDelta: "answer",
          thinkingDelta: "",
          isThinking: false,
        },
      );
      expect(state.prevContent).toBe("answer");
    });

    it("honors user-overridden thinking delimiters", () => {
      const state = {
        fullRawContent: "",
        prevContent: "",
        prevThinking: "",
        usedNativeReasoning: false,
      };
      applyAssistantStreamDelta(
        state,
        "<|channel>thought\nplan<channel|>answer",
        "",
        "<|channel>thought\n",
        "<channel|>",
      );
      expect(state.prevContent).toBe("answer");
      expect(state.prevThinking).toBe("plan");
    });

    it("falls back to Gemma channel tags when configured for <think>", () => {
      const state = {
        fullRawContent: "",
        prevContent: "",
        prevThinking: "",
        usedNativeReasoning: false,
      };
      applyAssistantStreamDelta(
        state,
        "<|channel>thought plan<channel|>answer",
        "",
        "<think>",
        "</think>",
      );
      expect(state.prevContent).toBe("answer");
      expect(state.prevThinking).toBe("plan");
    });

    it("uses reasoning_content as the thinking trace without tag-scanning later content", () => {
      const state = {
        fullRawContent: "",
        prevContent: "",
        prevThinking: "",
        usedNativeReasoning: false,
      };
      applyAssistantStreamDelta(state, "", "plan", "<think>", "</think>");
      applyAssistantStreamDelta(
        state,
        "<think>not a tag parse</think>answer",
        "",
        "<think>",
        "</think>",
      );
      expect(state.usedNativeReasoning).toBe(true);
      expect(state.prevThinking).toBe("plan");
      expect(state.prevContent).toBe("<think>not a tag parse</think>answer");
    });
  });

  describe("finalizeAssistantStreamState", () => {
    it("writes a held-back suffix into the visible reply", () => {
      const state = {
        fullRawContent: "answer <",
        prevContent: "answer ",
        prevThinking: "",
        usedNativeReasoning: false,
      };
      finalizeAssistantStreamState(state, "<think>", "</think>");
      expect(state.prevContent).toBe("answer <");
      expect(state.prevThinking).toBe("");
    });

    it("leaves a native reasoning stream unchanged", () => {
      const state = {
        fullRawContent: "<think>secret</think>answer",
        prevContent: "<think>secret</think>answer",
        prevThinking: "plan",
        usedNativeReasoning: true,
      };
      finalizeAssistantStreamState(state, "<think>", "</think>");
      expect(state.prevContent).toBe("<think>secret</think>answer");
      expect(state.prevThinking).toBe("plan");
    });
  });

  describe("inferNativeReasoningReuse", () => {
    it("trusts a persisted native thinking source even when the answer contains an open tag", () => {
      expect(
        inferNativeReasoningReuse(
          "plan",
          "use <think> as an example",
          "<think>",
          "</think>",
          "native",
        ),
      ).toBe(true);
    });

    it("keeps tag parsing when the saved raw text still contains a thinking block", () => {
      expect(
        inferNativeReasoningReuse("plan", "<think>plan</think>answer", "<think>", "</think>"),
      ).toBe(false);
    });
  });

  describe("shouldSendAssistantReasoningContent", () => {
    it("sends reasoning_content only after the last user (continue)", () => {
      expect(
        shouldSendAssistantReasoningContent({
          messageIndex: 2,
          lastUserIndex: 1,
          preserveThinking: false,
          hasToolCalls: false,
        }),
      ).toBe(true);
    });

    it("does not send reasoning_content on ordinary historical assistants even when preserving", () => {
      expect(
        shouldSendAssistantReasoningContent({
          messageIndex: 1,
          lastUserIndex: 2,
          preserveThinking: true,
          hasToolCalls: false,
        }),
      ).toBe(false);
    });

    it("sends reasoning_content on preserved historical tool-call assistants", () => {
      expect(
        shouldSendAssistantReasoningContent({
          messageIndex: 1,
          lastUserIndex: 2,
          preserveThinking: true,
          hasToolCalls: true,
        }),
      ).toBe(true);
    });
  });

  describe("shouldReconstructPreservedAssistantContent", () => {
    it("reconstructs Qwen-style think tags for preserved historical assistants", () => {
      expect(
        shouldReconstructPreservedAssistantContent({
          preserveThinking: true,
          sendReasoningContent: false,
          openTag: "<think>",
        }),
      ).toBe(true);
    });

    it("does not reconstruct Gemma channel tags that strip_thinking would drop", () => {
      expect(
        shouldReconstructPreservedAssistantContent({
          preserveThinking: true,
          sendReasoningContent: false,
          openTag: "<|channel>thought",
        }),
      ).toBe(false);
    });
  });

  describe("reconstructPreservedAssistantContent", () => {
    it("reuses rawContent when it already contains the open tag", () => {
      expect(
        reconstructPreservedAssistantContent(
          {
            content: "answer",
            rawContent: "<think>plan</think>answer",
            thinkingContent: "plan",
          },
          { openTag: "<think>", closeTag: "</think>" },
        ),
      ).toBe("<think>plan</think>answer");
    });

    it("wraps a native thinking trace when rawContent has no tags", () => {
      expect(
        reconstructPreservedAssistantContent(
          {
            content: "answer",
            rawContent: "answer",
            thinkingContent: "plan",
          },
          { openTag: "<think>", closeTag: "</think>" },
        ),
      ).toBe("<think>\nplan\n</think>\nanswer");
    });

    it("wraps Gemma channel tags when rawContent has no thought block", () => {
      expect(
        reconstructPreservedAssistantContent(
          {
            content: "answer",
            rawContent: "answer",
            thinkingContent: "plan",
          },
          GEMMA4_THINKING_CONFIG,
        ),
      ).toBe("<|channel>thought\nplan\n<channel|>\nanswer");
    });
  });
});
