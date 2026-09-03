/**
 * @packageDocumentation
 * Thinking-tag parsing and template-capability re-exports used during streaming.
 */

export { analyzeTemplateCapabilities } from "../shared/templateCapabilities";
export type { TemplateCapabilityInfo } from "../shared/templateCapabilities";
export {
  DEFAULT_THINKING_CONFIG,
  detectThinkingConfig,
  GEMMA4_THINKING_CONFIG,
} from "../shared/thinkingTags";

/**
 * Robustly parses content into target final text and thinking trace without stateful chunks.
 * Safeguards against partial trailing tags to prevent flashing.
 *
 * @param raw - Raw assistant output accumulated so far.
 * @param openTag - Opening delimiter for thinking content.
 * @param closeTag - Closing delimiter for thinking content.
 * @returns Split content containing visible text, captured thinking text, and the active parsing state.
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
        content += raw.substring(curr, Math.max(curr, raw.length - matchLen));
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
