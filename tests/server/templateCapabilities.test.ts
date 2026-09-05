import { describe, expect, it } from "bun:test";
import {
  analyzeLoadPresetChatTemplate,
  analyzeTemplateCapabilities,
  modelPathsMatch,
  resolveChatTemplateForCapabilities,
} from "../../src/shared/templateCapabilities";

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

describe("resolveChatTemplateForCapabilities", () => {
  it("matches model paths across slash and case differences", () => {
    expect(modelPathsMatch("D:\\Models\\Qwen.gguf", "d:/Models/Qwen.gguf")).toBe(true);
    expect(modelPathsMatch("D:\\Models\\A.gguf", "D:\\Models\\B.gguf")).toBe(false);
  });

  it("prefers a pasted load-preset override that contains preserve_thinking", () => {
    const resolved = resolveChatTemplateForCapabilities({
      loadedTemplate: "{{ bos_token }}",
      ggufTemplate: "{{ bos_token }}",
      modelPath: "D:\\Models\\qwen.gguf",
      loadPresets: [
        {
          id: "auto",
          modelPath: "D:/Models/qwen.gguf",
          chatTemplateOverride: "{{ bos_token }}",
        },
        {
          id: "custom",
          modelPath: "d:\\models\\qwen.gguf",
          chatTemplateOverride:
            "{%- set preserve_thinking = preserve_thinking | default(false) -%}{{ bos_token }}",
        },
      ],
    });
    expect(resolved?.provenance).toBe("override");
    expect(resolved?.template).toContain("preserve_thinking");
    expect(analyzeTemplateCapabilities(resolved?.template ?? "")?.hasPreserveThinking).toBe(true);
  });

  it("uses the loaded chatTemplateContent when it already supports preserve_thinking", () => {
    const loaded = "{%- set preserve_thinking = preserve_thinking | default(true) -%}";
    const resolved = resolveChatTemplateForCapabilities({
      loadedTemplate: loaded,
      ggufTemplate: "{{ bos_token }}",
      modelPath: "/models/a.gguf",
      loadPresets: [],
    });
    expect(resolved).toEqual({ template: loaded, provenance: "loaded" });
  });
});

describe("analyzeLoadPresetChatTemplate", () => {
  it("uses the load-preset override without requiring a loaded model", () => {
    const result = analyzeLoadPresetChatTemplate(
      "{%- set preserve_thinking = preserve_thinking | default(true) -%}",
      "{{ bos_token }}",
    );
    expect(result?.hasPreserveThinking).toBe(true);
    expect(result?.preserveThinkingDefault).toBe(true);
    expect(result?.provenance).toBe("override");
  });

  it("falls back to the GGUF template when no override is present", () => {
    const result = analyzeLoadPresetChatTemplate(
      undefined,
      "{%- set preserve_thinking = preserve_thinking | default(false) -%}",
    );
    expect(result?.hasPreserveThinking).toBe(true);
    expect(result?.preserveThinkingDefault).toBe(false);
    expect(result?.provenance).toBe("gguf");
  });

  it("does not enable preserve thinking for templates that lack the variable", () => {
    const result = analyzeLoadPresetChatTemplate("{{ bos_token }}", "{{ bos_token }}");
    expect(result?.hasPreserveThinking).toBe(false);
    expect(result?.provenance).toBe("override");
  });
});
