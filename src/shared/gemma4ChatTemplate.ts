/**
 * @packageDocumentation
 * Surgical Gemma 4 Jinja fix so follow-up turns still open a thought channel.
 *
 * Canonical Gemma 4 templates inject `<|think|>` once on the first system turn,
 * then start later model turns with only `<|turn>model`. Historical thoughts are
 * stripped from `content`, and `reasoning_content` is not replayed for ordinary
 * chat. The model therefore sees a thoughtless previous reply and often skips
 * CoT after turn 1. This patch does not rewrite tool-calling or strip_thinking;
 * it only opens `<|channel>thought` when `enable_thinking` is set.
 */

/** Marker inserted so the generation-prompt patch is idempotent. */
export const GEMMA4_FOLLOWUP_THOUGHT_MARKER = "{#- llamaforge-gemma4-followup-thought -#}";

/**
 * Jinja inserted immediately after the generation-prompt `<|turn>model` emit.
 * The thought channel is left open so the model continues inside reasoning.
 */
const OPEN_THOUGHT_WHEN_ENABLED = [
  GEMMA4_FOLLOWUP_THOUGHT_MARKER,
  "{%- if enable_thinking -%}",
  "{{- '<|channel>thought\\n' -}}",
  "{%- endif -%}",
].join("\n");

const TURN_MODEL_EMIT = /\{\{-?\s*(['"])<\|turn>model\\n\1\s*-?\}\}/;

/**
 * Whether a Jinja body is a Gemma 4 chat template that can receive the patch.
 *
 * @param template - Chat template source.
 * @returns `true` when the template uses Gemma 4 thought tokens and a generation prompt.
 */
export function isGemma4ChatTemplate(template: string): boolean {
  return (
    template.includes("<|channel>thought") &&
    template.includes("<|think|>") &&
    template.includes("add_generation_prompt")
  );
}

/**
 * Opens `<|channel>thought` on Gemma 4's generation prompt when thinking is on.
 *
 * Applied only inside the last `add_generation_prompt` block, after the
 * `<|turn>model` emit, so tool-response turns that already open thought are
 * unchanged. Templates that already contain {@link GEMMA4_FOLLOWUP_THOUGHT_MARKER}
 * are returned as-is.
 *
 * @param template - GGUF or load-preset Jinja source.
 * @returns The same template, or a copy with the follow-up thought open inserted.
 */
export function ensureGemma4GenerationOpensThought(template: string): string {
  if (!isGemma4ChatTemplate(template)) return template;
  if (template.includes(GEMMA4_FOLLOWUP_THOUGHT_MARKER)) return template;

  const genIdx = template.lastIndexOf("add_generation_prompt");
  if (genIdx === -1) return template;

  const head = template.slice(0, genIdx);
  const tail = template.slice(genIdx);
  const match = TURN_MODEL_EMIT.exec(tail);
  if (!match || match.index === undefined) return template;

  const insertAt = match.index + match[0].length;
  return `${head}${tail.slice(0, insertAt)}\n${OPEN_THOUGHT_WHEN_ENABLED}${tail.slice(insertAt)}`;
}
