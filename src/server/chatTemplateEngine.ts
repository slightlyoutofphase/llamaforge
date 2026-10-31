/**
 * @packageDocumentation
 * Thinking-tag parsing and template-capability re-exports used during streaming.
 */

import { DEFAULT_THINKING_CONFIG, GEMMA4_THINKING_CONFIG } from "../shared/thinkingTags";
import type { ThinkingTagConfig } from "../shared/types";

export { analyzeTemplateCapabilities } from "../shared/templateCapabilities";
export type { TemplateCapabilityInfo } from "../shared/templateCapabilities";
export {
  DEFAULT_THINKING_CONFIG,
  detectThinkingConfig,
  GEMMA4_THINKING_CONFIG,
} from "../shared/thinkingTags";

/**
 * Whether `endIndex` in `raw` is a valid end-of-open-tag boundary.
 * Rejects matches such as `<|channel>thoughtful` when the open tag is `<|channel>thought`.
 *
 * @param raw - Accumulated assistant text.
 * @param endIndex - Index immediately after a candidate open tag.
 * @param closeTag - Thinking close delimiter.
 * @returns `true` when the match is a real tag rather than a longer token.
 */
function isOpenTagBoundary(raw: string, endIndex: number, closeTag: string): boolean {
  if (endIndex >= raw.length) return true;
  if (closeTag && raw.startsWith(closeTag, endIndex)) return true;
  const next = raw[endIndex];
  if (next !== undefined && /\s/.test(next)) return true;
  const lastTagChar = raw[endIndex - 1];
  // Tags that end in punctuation (`<think>`) may be followed by content immediately.
  // Tags that end in a letter (`<|channel>thought`) must not match `thoughtful`.
  return lastTagChar !== undefined && /[^A-Za-z0-9]/.test(lastTagChar);
}

/**
 * Finds the next open-tag occurrence that is followed by whitespace, EOF, or the close tag.
 *
 * @param raw - Accumulated assistant text.
 * @param openTag - Thinking open delimiter.
 * @param closeTag - Thinking close delimiter.
 * @param fromIndex - Search start index.
 * @returns Index of a bounded open tag, or `-1` when none remain.
 */
function findBoundedOpenTag(
  raw: string,
  openTag: string,
  closeTag: string,
  fromIndex: number,
): number {
  let searchFrom = fromIndex;
  while (searchFrom < raw.length) {
    const openIdx = raw.indexOf(openTag, searchFrom);
    if (openIdx === -1) return -1;
    if (isOpenTagBoundary(raw, openIdx + openTag.length, closeTag)) return openIdx;
    searchFrom = openIdx + 1;
  }
  return -1;
}

/**
 * Options for {@link parseThinkTags}.
 */
export interface ParseThinkTagsOptions {
  /**
   * When true, a trailing prefix of the open or close tag is real text.
   * Streaming parses leave this unset so a partial tag does not flash.
   */
  final?: boolean;
}

/**
 * Robustly parses content into target final text and thinking trace without stateful chunks.
 * Safeguards against partial trailing tags to prevent flashing until the stream is finished.
 *
 * @param raw - Raw assistant output accumulated so far.
 * @param openTag - Opening delimiter for thinking content.
 * @param closeTag - Closing delimiter for thinking content.
 * @param options - Pass `{ final: true }` once no more tokens will arrive.
 * @returns Split content containing visible text, captured thinking text, and the active parsing state.
 */
export function parseThinkTags(
  raw: string,
  openTag: string,
  closeTag: string,
  options?: ParseThinkTagsOptions,
) {
  let content = "";
  let thinking = "";
  let isThinking = false;
  let curr = 0;
  const final = options?.final === true;

  if (!openTag || !closeTag) {
    return { content: raw, thinking: "", isThinking: false };
  }

  while (curr < raw.length) {
    if (!isThinking) {
      const openIdx = findBoundedOpenTag(raw, openTag, closeTag, curr);
      if (openIdx === -1) {
        let matchLen = 0;
        if (!final) {
          for (let i = openTag.length - 1; i >= 1; i--) {
            if (raw.endsWith(openTag.substring(0, i))) {
              matchLen = i;
              break;
            }
          }
        }
        content += raw.substring(curr, Math.max(curr, raw.length - matchLen));
        break;
      } else {
        content += raw.substring(curr, openIdx);
        isThinking = true;
        curr = openIdx + openTag.length;
        if (/[A-Za-z0-9]$/.test(openTag)) {
          while (curr < raw.length && /\s/.test(raw[curr] ?? "")) curr += 1;
        }
      }
    } else {
      const closeIdx = raw.indexOf(closeTag, curr);
      if (closeIdx === -1) {
        let matchLen = 0;
        if (!final) {
          for (let i = closeTag.length - 1; i >= 1; i--) {
            if (raw.endsWith(closeTag.substring(0, i))) {
              matchLen = i;
              break;
            }
          }
        }
        thinking += raw.substring(curr, Math.max(curr, raw.length - matchLen));
        break;
      } else {
        thinking += raw.substring(curr, closeIdx);
        isThinking = false;
        curr = closeIdx + closeTag.length;
      }
    }
  }
  return { content, thinking, isThinking };
}

/**
 * Parses thinking tags with the configured delimiters, then the other built-in
 * pair if those delimiters miss a trace that is actually present.
 *
 * Architecture detection and load-preset overrides can disagree with the tokens
 * llama-server actually emitted (Gemma channel tags vs `<think>`). A follow-up
 * generation must still extract the trace or the UI looks like thinking died.
 *
 * @param raw - Accumulated assistant text.
 * @param openTag - Preferred thinking open delimiter.
 * @param closeTag - Preferred thinking close delimiter.
 * @param options - Passed through to each delimiter attempt. `{ final: true }` keeps a trailing tag prefix.
 * @returns Split content using the first delimiter pair that captures a trace.
 */
export function parseThinkTagsWithFallback(
  raw: string,
  openTag: string,
  closeTag: string,
  options?: ParseThinkTagsOptions,
) {
  const primary = parseThinkTags(raw, openTag, closeTag, options);
  if (primary.thinking || primary.isThinking) return primary;

  for (const alt of [GEMMA4_THINKING_CONFIG, DEFAULT_THINKING_CONFIG]) {
    if (alt.openTag === openTag && alt.closeTag === closeTag) continue;
    if (!raw.includes(alt.openTag)) continue;
    const parsed = parseThinkTags(raw, alt.openTag, alt.closeTag, options);
    if (parsed.thinking || parsed.isThinking) return parsed;
  }
  return primary;
}

/**
 * Accumulated assistant text while a chat-completion SSE stream is in flight.
 */
export type AssistantStreamState = {
  /** Concatenated `delta.content` pieces received so far. */
  fullRawContent: string;
  /** Visible assistant text after thinking extraction. */
  prevContent: string;
  /** Thinking trace extracted so far. */
  prevThinking: string;
  /**
   * Once llama-server emits `reasoning_content`, later `content` pieces are the
   * visible answer and must not be tag-scanned (the server already split them).
   */
  usedNativeReasoning: boolean;
};

/**
 * Folds one SSE token delta into assistant stream state.
 *
 * llama-server `reasoning_content` (when present) is the thinking trace.
 * Otherwise {@link parseThinkTags} splits in-content delimiters so the visible
 * answer can stream as soon as the close tag arrives. Both are never applied
 * to the same tokens.
 *
 * @param state - Mutable accumulation for the current assistant message.
 * @param contentPiece - `choices[0].delta.content`, or an empty string.
 * @param reasoningPiece - `choices[0].delta.reasoning_content`, or an empty string.
 * @param openTag - Thinking open delimiter (model default or user override).
 * @param closeTag - Thinking close delimiter (model default or user override).
 * @returns Incremental visible/thinking text and whether a think block is still open.
 */
export function applyAssistantStreamDelta(
  state: AssistantStreamState,
  contentPiece: string,
  reasoningPiece: string,
  openTag: string,
  closeTag: string,
): { contentDelta: string; thinkingDelta: string; isThinking: boolean } {
  const contentBefore = state.prevContent;
  const thinkingBefore = state.prevThinking;
  let isThinking = false;

  if (reasoningPiece) {
    state.usedNativeReasoning = true;
    state.prevThinking += reasoningPiece;
    isThinking = true;
  }

  if (contentPiece) {
    state.fullRawContent += contentPiece;
    if (state.usedNativeReasoning) {
      state.prevContent += contentPiece;
      isThinking = false;
    } else {
      const parsed = parseThinkTagsWithFallback(state.fullRawContent, openTag, closeTag);
      state.prevContent = parsed.content;
      state.prevThinking = parsed.thinking;
      isThinking = parsed.isThinking;
    }
  }

  return {
    contentDelta: state.prevContent.substring(contentBefore.length),
    thinkingDelta: state.prevThinking.substring(thinkingBefore.length),
    isThinking,
  };
}

/**
 * Flushes a held-back tag suffix once the assistant stream has ended.
 *
 * Streaming parses hide a trailing prefix of the open or close tag so it does not
 * flash before the rest of the tag arrives. A finished reply has no further tokens,
 * so that suffix is visible text, or thinking text when a think block is still open.
 * Native `reasoning_content` streams are already split and are left unchanged.
 *
 * @param state - Mutable accumulation for the assistant message.
 * @param openTag - Thinking open delimiter.
 * @param closeTag - Thinking close delimiter.
 * @returns No return value. Updates `prevContent` and `prevThinking` when tags were scanned.
 */
export function finalizeAssistantStreamState(
  state: AssistantStreamState,
  openTag: string,
  closeTag: string,
): void {
  if (state.usedNativeReasoning) return;
  const parsed = parseThinkTagsWithFallback(state.fullRawContent, openTag, closeTag, {
    final: true,
  });
  state.prevContent = parsed.content;
  state.prevThinking = parsed.thinking;
}

/**
 * Decides whether a continued assistant row should keep using llama-server's
 * native `reasoning_content` split instead of scanning `rawContent` for tags.
 *
 * Persisted `thinkingSource` wins. Otherwise a saved thinking trace whose raw
 * text does not actually contain a thinking block is treated as native, so an
 * incidental open-tag string in the visible answer cannot wipe the trace.
 *
 * @param thinkingContent - Previously saved thinking trace, if any.
 * @param rawContent - Previously saved raw assistant text.
 * @param openTag - Thinking open delimiter (model default or user override).
 * @param closeTag - Thinking close delimiter (model default or user override).
 * @param storedSource - Persisted extraction source from the last generation.
 * @returns `true` when continue should treat later `content` as already split.
 */
export function inferNativeReasoningReuse(
  thinkingContent: string | undefined,
  rawContent: string,
  openTag: string,
  closeTag: string,
  storedSource?: "native" | "tags",
): boolean {
  if (storedSource === "native") return true;
  if (storedSource === "tags") return false;
  if (!thinkingContent) return false;
  return parseThinkTags(rawContent, openTag, closeTag).thinking.length === 0;
}

/**
 * Whether an assistant turn should carry OpenAI `reasoning_content` on the
 * llama-server request.
 *
 * llama.cpp treats that field as native reasoning already present on the slot.
 * Ordinary historical traces (before the last user) therefore must not use it:
 * sending them with `preserve_thinking` made Gemma skip follow-up thinking and
 * left Qwen stuck in a think-only parse with no visible answer. Continue
 * (assistant after the last user) still needs the field for prefill. Gemma 4
 * Jinja also replays traces on tool-call assistants when preserve is on.
 *
 * @param options.messageIndex - Index of this message in the outbound history.
 * @param options.lastUserIndex - Index of the last user message, or `-1`.
 * @param options.preserveThinking - Load-preset `preserve_thinking` kwarg.
 * @param options.hasToolCalls - Whether this assistant row has tool calls.
 * @returns `true` when `reasoning_content` should be attached.
 */
export function shouldSendAssistantReasoningContent(options: {
  messageIndex: number;
  lastUserIndex: number;
  preserveThinking: boolean;
  hasToolCalls: boolean;
}): boolean {
  if (options.messageIndex > options.lastUserIndex) return true;
  return options.preserveThinking && options.hasToolCalls;
}

/**
 * Whether historical thinking should be inlined as tagged `content`.
 *
 * Qwen-style templates split `<think>` out of `content` when preserve is on.
 * Gemma 4 always runs `strip_thinking` on historical model text and only
 * replays `reasoning_content` for continue/tool-calls, so channel tags in
 * `content` are stripped (or pollute the prompt if the wrong tags are used).
 *
 * @param options.preserveThinking - Load-preset `preserve_thinking` kwarg.
 * @param options.sendReasoningContent - Whether this row already uses `reasoning_content`.
 * @param options.openTag - Thinking open delimiter for the loaded model.
 * @returns `true` when tagged `content` should carry the trace.
 */
export function shouldReconstructPreservedAssistantContent(options: {
  preserveThinking: boolean;
  sendReasoningContent: boolean;
  openTag: string;
}): boolean {
  if (!options.preserveThinking || options.sendReasoningContent) return false;
  return options.openTag.includes("<think>");
}

/**
 * Rebuilds tagged assistant text so templates that extract thinking from
 * `content` (Qwen / froggeric) can replay traces when `preserve_thinking` is
 * on, without setting `reasoning_content` on historical turns.
 *
 * Prefers persisted `rawContent` when it already contains the open tag.
 * Otherwise wraps `thinkingContent` in the model's open/close tags.
 *
 * @param message - Persisted assistant fields used to rebuild the body.
 * @param thinkingConfig - Open/close tags for the loaded model.
 * @returns Tagged assistant text for the `content` field.
 */
export function reconstructPreservedAssistantContent(
  message: {
    content: string;
    rawContent: string;
    thinkingContent?: string | undefined;
  },
  thinkingConfig: Pick<ThinkingTagConfig, "openTag" | "closeTag">,
): string {
  const { openTag, closeTag } = thinkingConfig;
  if (openTag && message.rawContent.includes(openTag)) {
    return message.rawContent;
  }
  if (message.thinkingContent && openTag && closeTag) {
    return `${openTag}\n${message.thinkingContent}\n${closeTag}\n${message.content}`;
  }
  return message.rawContent || message.content;
}
