/**
 * @packageDocumentation
 * Shared thinking-tag constants and architecture detection used by client and server.
 */

import type { ThinkingTagConfig } from "./types";

/**
 * Configuration specifically for the Gemma 4 architectures regarding their unique formatting.
 */
export const GEMMA4_THINKING_CONFIG: ThinkingTagConfig = {
  // llama.cpp's Gemma 4 PEG parser is `literal("<|channel>thought") + space`,
  // so a required trailing newline misses traces that open with a space.
  openTag: "<|channel>thought",
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
 * Detects whether a GGUF architecture string identifies Gemma 4.
 * The canonical GGUF value is `gemma4`; hyphen and underscore variants are accepted defensively.
 *
 * @param arch - Architecture string from GGUF metadata.
 * @returns `true` when the architecture is Gemma 4.
 */
export function isGemma4Architecture(arch?: string): boolean {
  return /^gemma[-_]?4$/i.test(arch || "");
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
  const defaults = isGemma4Architecture(arch) ? GEMMA4_THINKING_CONFIG : DEFAULT_THINKING_CONFIG;
  if (!override) return defaults;
  return {
    openTag: override.openTag || defaults.openTag,
    closeTag: override.closeTag || defaults.closeTag,
    enableToken: override.enableToken || defaults.enableToken,
  };
}
