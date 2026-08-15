import { describe, expect, it } from "bun:test";
import { analyzeTemplateCapabilities } from "../../src/shared/templateCapabilities";

describe("analyzeTemplateCapabilities", () => {
  it("returns null for empty template", () => {
    expect(analyzeTemplateCapabilities("")).toBeNull();
    expect(analyzeTemplateCapabilities("   ")).toBeNull();
  });

  it("returns null for template without preserve_thinking", () => {
    const template = `
      {%- set enable_thinking = enable_thinking | default(false) -%}
      {{ bos_token }}
      {%- for message in messages -%}
        {{ message.content }}
      {%- endfor -%}
    `;
    expect(analyzeTemplateCapabilities(template)).toBeNull();
  });

  it("detects Gemma 4 style preserve_thinking | default(false)", () => {
    const template = `
      {%- set preserve_thinking = preserve_thinking | default(false) -%}
      {%- if preserve_thinking and message.get('tool_calls') -%}
        {{ '<|think|>' }}
      {%- endif -%}
    `;
    const result = analyzeTemplateCapabilities(template);
    expect(result).not.toBeNull();
    expect(result?.hasPreserveThinking).toBe(true);
    expect(result?.preserveThinkingDefault).toBe(false);
  });

  it("detects preserve_thinking | default(true)", () => {
    const template = `
      {%- set preserve_thinking = preserve_thinking | default(true) -%}
      {%- if preserve_thinking -%}
        {{ reasoning_content }}
      {%- endif -%}
    `;
    const result = analyzeTemplateCapabilities(template);
    expect(result).not.toBeNull();
    expect(result?.hasPreserveThinking).toBe(true);
    expect(result?.preserveThinkingDefault).toBe(true);
  });

  it("detects 'is undefined or preserve_thinking is true' pattern", () => {
    const template = `
      {%- if preserve_thinking is undefined or preserve_thinking is true -%}
        {{ reasoning_content }}
      {%- endif -%}
    `;
    const result = analyzeTemplateCapabilities(template);
    expect(result).not.toBeNull();
    expect(result?.hasPreserveThinking).toBe(true);
    expect(result?.preserveThinkingDefault).toBe(true);
  });

  it("detects 'is defined and preserve_thinking' pattern", () => {
    const template = `
      {%- if preserve_thinking is defined and preserve_thinking -%}
        {{ reasoning_content }}
      {%- endif -%}
    `;
    const result = analyzeTemplateCapabilities(template);
    expect(result).not.toBeNull();
    expect(result?.hasPreserveThinking).toBe(true);
    expect(result?.preserveThinkingDefault).toBe(false);
  });

  it("detects preserve_thinking in complex template with multiple features", () => {
    const template = `
      {%- set enable_thinking = enable_thinking | default(false) -%}
      {%- set preserve_thinking = preserve_thinking | default(false) -%}
      {%- set tools = tools | default(none) -%}
      
      {%- if enable_thinking -%}
        {{ '<|think|>' }}
      {%- endif -%}
      
      {%- if preserve_thinking and message.get('tool_calls') -%}
        {{ '<|channel>thought' }}
      {%- endif -%}
      
      {%- for tool in tools -%}
        {{ tool.name }}
      {%- endfor -%}
    `;
    const result = analyzeTemplateCapabilities(template);
    expect(result).not.toBeNull();
    expect(result?.hasPreserveThinking).toBe(true);
    expect(result?.preserveThinkingDefault).toBe(false);
  });

  it("handles template with only enable_thinking but not preserve_thinking", () => {
    const template = `
      {%- set enable_thinking = enable_thinking | default(false) -%}
      {%- if enable_thinking -%}
        {{ '<|think|>' }}
      {%- endif -%}
    `;
    expect(analyzeTemplateCapabilities(template)).toBeNull();
  });

  it("handles null/undefined input gracefully", () => {
    expect(analyzeTemplateCapabilities(null as unknown as string)).toBeNull();
    expect(analyzeTemplateCapabilities(undefined as unknown as string)).toBeNull();
  });

  it("detects preserve_thinking used in conditional without default", () => {
    const template = `
      {%- if preserve_thinking -%}
        {{ reasoning }}
      {%- endif -%}
    `;
    const result = analyzeTemplateCapabilities(template);
    expect(result).not.toBeNull();
    expect(result?.hasPreserveThinking).toBe(true);
    expect(result?.preserveThinkingDefault).toBe(false);
  });

  it("detects preserve_thinking in macro parameter", () => {
    const template = `
      {%- macro render_thinking(preserve_thinking=false) -%}
        {%- if preserve_thinking -%}
          {{ reasoning }}
        {%- endif -%}
      {%- endmacro -%}
    `;
    const result = analyzeTemplateCapabilities(template);
    expect(result).not.toBeNull();
    expect(result?.hasPreserveThinking).toBe(true);
    expect(result?.preserveThinkingDefault).toBe(false);
  });
});
