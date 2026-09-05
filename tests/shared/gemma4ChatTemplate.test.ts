/**
 * @packageDocumentation
 * Tests for the Gemma 4 follow-up thinking generation-prompt patch.
 */

import { describe, expect, it } from "bun:test";
import {
  ensureGemma4GenerationOpensThought,
  GEMMA4_FOLLOWUP_THOUGHT_MARKER,
  isGemma4ChatTemplate,
} from "../../src/shared/gemma4ChatTemplate";

const GOOGLE_GENERATION_PROMPT = `{%- if add_generation_prompt -%}
 {%- if ns.prev_message_type != 'tool_response' and ns.prev_message_type != 'tool_call' -%}
 {{- '<|turn>model\\n' -}}
 {%- elif ns.prev_message_type == 'tool_response' and enable_thinking -%}
 {{- '<|channel>thought\\n' -}}
 {%- endif -%}
{%- endif -%}`;

const LLAMACPP_31B_GENERATION_PROMPT = `{%- if add_generation_prompt -%}
 {%- if ns.prev_message_type != 'tool_response' and ns.prev_message_type != 'tool_call' -%}
 {{- '<|turn>model\\n' -}}
 {%- if not enable_thinking | default(false) -%}
 {{- '<|channel>thought\\n<channel|>' -}}
 {%- endif -%}
 {%- endif -%}
{%- endif -%}`;

/**
 * Minimal Gemma 4-shaped template wrapping a generation-prompt fragment.
 *
 * @param generationPrompt - The `add_generation_prompt` block to embed.
 * @returns A template that {@link isGemma4ChatTemplate} accepts.
 */
function wrapGemma4(generationPrompt: string): string {
  return `{%- set enable_thinking = enable_thinking | default(false) -%}
{{- '<|think|>' -}}
{{- '<|channel>thought' -}}
${generationPrompt}`;
}

describe("gemma4ChatTemplate", () => {
  it("detects Gemma 4 templates by thought tokens and generation prompt", () => {
    expect(isGemma4ChatTemplate(wrapGemma4(GOOGLE_GENERATION_PROMPT))).toBe(true);
    expect(
      isGemma4ChatTemplate("{%- if add_generation_prompt -%}{{ bos_token }}{%- endif -%}"),
    ).toBe(false);
  });

  it("opens a thought channel after <|turn>model when enable_thinking is on", () => {
    const patched = ensureGemma4GenerationOpensThought(wrapGemma4(GOOGLE_GENERATION_PROMPT));
    expect(patched).toContain(GEMMA4_FOLLOWUP_THOUGHT_MARKER);
    expect(patched).toContain("{%- if enable_thinking -%}");
    expect(patched).toContain("{{- '<|channel>thought\\n' -}}");
    expect(patched.indexOf("<|turn>model\\n")).toBeLessThan(
      patched.indexOf(GEMMA4_FOLLOWUP_THOUGHT_MARKER),
    );
    expect(patched).toContain(
      "{%- elif ns.prev_message_type == 'tool_response' and enable_thinking -%}",
    );
  });

  it("keeps the empty thought skip used when thinking is off", () => {
    const patched = ensureGemma4GenerationOpensThought(wrapGemma4(LLAMACPP_31B_GENERATION_PROMPT));
    expect(patched).toContain("{%- if not enable_thinking | default(false) -%}");
    expect(patched).toContain("{{- '<|channel>thought\\n<channel|>' -}}");
    expect(patched).toContain(GEMMA4_FOLLOWUP_THOUGHT_MARKER);
  });

  it("does not patch twice", () => {
    const once = ensureGemma4GenerationOpensThought(wrapGemma4(GOOGLE_GENERATION_PROMPT));
    const twice = ensureGemma4GenerationOpensThought(once);
    expect(twice).toBe(once);
    expect(twice.split(GEMMA4_FOLLOWUP_THOUGHT_MARKER).length - 1).toBe(1);
  });

  it("leaves non-Gemma templates unchanged", () => {
    const qwen = "{%- if add_generation_prompt -%}{{- '<|im_start|>assistant\\n' -}}{%- endif -%}";
    expect(ensureGemma4GenerationOpensThought(qwen)).toBe(qwen);
  });
});
