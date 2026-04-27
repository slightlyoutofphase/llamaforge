/**
 * @packageDocumentation
 * Logic for rendering prompt templates and parsing thinking tags.
 * Supports Jinja-like templates through @huggingface/jinja.
 */

import { Template } from "@huggingface/jinja";
import type { ChatMessage, ThinkingTagConfig } from "@shared/types.js";

/**
 * Configuration specifically for the Gemma 4 architectures regarding their unique formatting.
 */
export const GEMMA4_THINKING_CONFIG: ThinkingTagConfig = {
  openTag: "<|channel>thought\n",
  closeTag: "<channel|>",
  enableToken: "<|think|>",
};

/**
 * Default thinking tag boundaries fallback primarily tuned for DeepSeek architecture models.
 */
export const DEFAULT_THINKING_CONFIG: ThinkingTagConfig = {
  openTag: "<think>",
  closeTag: "</think>",
  enableToken: undefined,
};

/**
 * Robustly parses content into target final text and thinking trace without stateful chunks.
 * Safeguards against partial trailing tags to prevent flashing.
 */
export function parseThinkTags(raw: string, openTag: string, closeTag: string) {
  let content = "";
  let thinking = "";
  let isThinking = false;
  let curr = 0;

  if (!openTag || !closeTag) {
    return { content: raw, thinking: "", isThinking: false };
  }

  while (curr < raw.length) {
    if (!isThinking) {
      const openIdx = raw.indexOf(openTag, curr);
      if (openIdx === -1) {
        let matchLen = 0;
        for (let i = openTag.length - 1; i >= 1; i--) {
          if (raw.endsWith(openTag.substring(0, i))) {
            matchLen = i;
            break;
          }
        }
        content += raw.substring(curr, raw.length - matchLen);
        break;
      } else {
        content += raw.substring(curr, openIdx);
        isThinking = true;
        curr = openIdx + openTag.length;
      }
    } else {
      const closeIdx = raw.indexOf(closeTag, curr);
      if (closeIdx === -1) {
        let matchLen = 0;
        for (let i = closeTag.length - 1; i >= 1; i--) {
          if (raw.endsWith(closeTag.substring(0, i))) {
            matchLen = i;
            break;
          }
        }
        thinking += raw.substring(curr, raw.length - matchLen);
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
 * Detects the appropriate thinking tag configuration for a given model architecture.
 *
 * @param arch - The model architecture string (from GGUF metadata).
 * @param override - User-provided manual override for the configuration.
 * @returns The final {@link ThinkingTagConfig} to use for parsing output.
 */
export function detectThinkingConfig(
  arch?: string,
  override?: ThinkingTagConfig,
): ThinkingTagConfig {
  const defaults =
    arch?.toLowerCase() === "gemma4" ? GEMMA4_THINKING_CONFIG : DEFAULT_THINKING_CONFIG;
  if (!override) return defaults;
  return {
    openTag: override.openTag || defaults.openTag,
    closeTag: override.closeTag || defaults.closeTag,
    enableToken: override.enableToken || defaults.enableToken,
  };
}

/**
 * Prepares conversation history for rendering by stripping raw thinking blocks from assistant turns.
 *
 * @param messages - The history of messages to prepare.
 * @param thinkingConfig - The configuration defining how thinking blocks are delimited.
 * @returns A shallow copy of messages with `content` stripped of thinking traces.
 */
export function prepareHistoryForRender(
  messages: readonly ChatMessage[],
  thinkingConfig: ThinkingTagConfig,
): ChatMessage[] {
  return messages.map((msg) => {
    if (msg.role !== "assistant" || !msg.rawContent) {
      return { ...msg };
    }

    let renderedContent = msg.rawContent;
    let found = true;

    while (found) {
      const openIdx = renderedContent.indexOf(thinkingConfig.openTag);
      if (openIdx !== -1) {
        const closeIdx = renderedContent.indexOf(
          thinkingConfig.closeTag,
          openIdx + thinkingConfig.openTag.length,
        );
        if (closeIdx !== -1) {
          renderedContent =
            renderedContent.substring(0, openIdx) +
            renderedContent.substring(closeIdx + thinkingConfig.closeTag.length);
        } else {
          renderedContent = renderedContent.substring(0, openIdx);
          found = false; // no more tags possible after a half-open one
        }
      } else {
        found = false;
      }
    }

    return { ...msg, content: renderedContent.trim() };
  });
}

/**
 * Renders a full prompt string using a Jinja template.
 *
 * @param messages - The prepared message array.
 * @param templateStr - The raw Jinja template string.
 * @param addGenerationPrompt - Whether to append the suffix that signals the model to start responding.
 * @param extraVars - Additional variables to pass to the template context.
 * @returns The fully rendered prompt string or a flat fallback if rendering fails.
 */
export function renderPrompt(
  messages: readonly ChatMessage[],
  templateStr: string,
  addGenerationPrompt: boolean,
  extraVars: Record<string, unknown> = {},
): string {
  try {
    const template = new Template(templateStr);
    return template.render({
      messages,
      add_generation_prompt: addGenerationPrompt,
      ...extraVars,
    });
  } catch (_e) {
    // Fallback manual looping if template fails to parse
    let fallback = "";
    for (const msg of messages) {
      if (msg.role === "system") {
        fallback += `System: ${msg.content}\n`;
      } else if (msg.role === "user") {
        fallback += `User: ${msg.content}\n`;
      } else if (msg.role === "assistant") {
        fallback += `Assistant: ${msg.content}\n`;
      } else if (msg.role === "tool") {
        fallback += `Tool (${msg.toolCallId}): ${msg.content}\n`;
      }
    }
    if (addGenerationPrompt) {
      fallback += "Assistant: ";
    }
    return fallback;
  }
}
