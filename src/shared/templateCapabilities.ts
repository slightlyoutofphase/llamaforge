/**
 * @packageDocumentation
 * Shared template capability analysis utilities used by both client and server.
 */

import type { GgufDisplayMetadata } from "./types";

/**
 * Result of analyzing a Jinja template for capability flags.
 */
export interface TemplateCapabilityInfo {
  /** Whether the template references the `preserve_thinking` variable. */
  hasPreserveThinking: boolean;
  /** The template's default value for `preserve_thinking` when not explicitly provided. */
  preserveThinkingDefault?: boolean | undefined;
}

/**
 * Whether a Jinja chat template can drive OpenAI-style function calling.
 *
 * This matches llama.cpp `chat_template_caps` (`supports_tools` plus
 * `supports_tool_calls`): the template must consume the `tools` input so the
 * model is told which functions exist, and consume `tool_calls` so history can
 * replay prior function calls. It is a template heuristic, not a GGUF flag, and
 * cannot prove the weights were trained for tool use.
 */
export interface ToolCallingCapabilityInfo {
  /** Template consumes the `tools` input (describes available functions). */
  supportsTools: boolean;
  /** Template consumes `message.tool_calls` (replays function calls in history). */
  supportsToolCalls: boolean;
}

/**
 * Provenance of the Jinja template used for capability detection.
 */
export type ChatTemplateProvenance = "loaded" | "override" | "gguf";

/**
 * Result of resolving the chat template that should drive capability detection.
 */
export interface ResolvedChatTemplate {
  /** Effective Jinja source. */
  template: string;
  /** Where the template was sourced from. */
  provenance: ChatTemplateProvenance;
}

/**
 * Compares two model filesystem paths, ignoring slash direction and letter case.
 *
 * Load-preset rows and scanned model entries can disagree on `\` vs `/` and on
 * drive-letter casing on Windows, which would otherwise hide a pasted override.
 *
 * @param left - First path.
 * @param right - Second path.
 * @returns `true` when both paths refer to the same model file.
 */
export function modelPathsMatch(left: string | undefined, right: string | undefined): boolean {
  if (!left || !right) return false;
  const normalize = (value: string) => value.replace(/\\/g, "/").replace(/\/+$/, "");
  const a = normalize(left);
  const b = normalize(right);
  return a === b || a.toLowerCase() === b.toLowerCase();
}

/**
 * Picks the Jinja template that should control `preserve_thinking` availability.
 *
 * Preference order:
 * 1. The template actually loaded into llama-server (`chatTemplateContent`)
 * 2. A load-preset override that contains `preserve_thinking` (so pasting a
 *    current template enables the control even when another preset matches first)
 * 3. The load preset that produced the running config, then any override
 * 4. The GGUF-embedded chat template
 *
 * @param options - Loaded config, scanned model, and load presets.
 * @returns The effective template and its provenance, or `null` when none exist.
 */
export function resolveChatTemplateForCapabilities(options: {
  loadedTemplate?: string | undefined;
  ggufTemplate?: string | undefined;
  modelPath?: string | undefined;
  loadedPresetId?: string | undefined;
  loadPresets?: Array<{
    id: string;
    modelPath?: string | undefined;
    chatTemplateOverride?: string | undefined;
  }>;
}): ResolvedChatTemplate | null {
  const loaded = options.loadedTemplate?.trim();
  if (loaded && /\bpreserve_thinking\b/.test(loaded)) {
    const provenance: ChatTemplateProvenance =
      options.ggufTemplate && loaded === options.ggufTemplate ? "gguf" : "loaded";
    return { template: loaded, provenance };
  }

  const matching = (options.loadPresets ?? []).filter(
    (preset) => !preset.modelPath || modelPathsMatch(preset.modelPath, options.modelPath),
  );
  const byId = options.loadedPresetId
    ? matching.find((preset) => preset.id === options.loadedPresetId)
    : undefined;
  const withPreserveThinking = matching.find(
    (preset) =>
      typeof preset.chatTemplateOverride === "string" &&
      /\bpreserve_thinking\b/.test(preset.chatTemplateOverride),
  );
  if (withPreserveThinking?.chatTemplateOverride) {
    return { template: withPreserveThinking.chatTemplateOverride, provenance: "override" };
  }

  const override =
    (typeof byId?.chatTemplateOverride === "string" && byId.chatTemplateOverride.trim()
      ? byId.chatTemplateOverride
      : undefined) ||
    matching.find(
      (preset) =>
        typeof preset.chatTemplateOverride === "string" && preset.chatTemplateOverride.trim(),
    )?.chatTemplateOverride;

  if (typeof override === "string" && override.trim()) {
    return { template: override, provenance: "override" };
  }

  if (loaded) {
    const provenance: ChatTemplateProvenance =
      options.ggufTemplate && loaded === options.ggufTemplate ? "gguf" : "loaded";
    return { template: loaded, provenance };
  }

  const gguf = options.ggufTemplate?.trim();
  if (gguf) {
    return { template: gguf, provenance: "gguf" };
  }

  return null;
}

/**
 * Strips Jinja comments so capability scans ignore documented-but-unused names.
 *
 * @param template - Raw Jinja source.
 * @returns Source with `{# ... #}` regions removed.
 */
function stripJinjaComments(template: string): string {
  return template.replace(/\{#[\s\S]*?#\}/g, "");
}

/**
 * Removes `{% set tools = tools | default(...) %}` bindings.
 *
 * Those lines mention `tools` without describing functions to the model, which
 * would otherwise count as tool support.
 *
 * @param template - Jinja source, typically after comments are stripped.
 * @returns Source with default-`tools` assignments removed.
 */
function stripToolsDefaultBindings(template: string): string {
  return template.replace(
    /\{%-?\s*set\s+tools\s*=\s*tools\s*\|\s*default\s*\(\s*[^)]*\s*\)\s*-?%\}/gi,
    "",
  );
}

/**
 * Analyzes a Jinja chat template for OpenAI-style function-calling support.
 *
 * llama.cpp decides this by executing the template and checking whether
 * `tools[0].function.name` and `messages[n].tool_calls` were accessed. This
 * scan uses the same signals from source: a live `tools` reference beyond a
 * default binding, plus a `tool_calls` reference.
 *
 * @param templateStr - Raw Jinja template string.
 * @returns Tool-calling capability flags. Both are false when the template is empty.
 */
export function analyzeToolCallingCapabilities(
  templateStr: string | undefined | null,
): ToolCallingCapabilityInfo {
  if (!templateStr || typeof templateStr !== "string") {
    return { supportsTools: false, supportsToolCalls: false };
  }

  const source = stripToolsDefaultBindings(stripJinjaComments(templateStr));
  return {
    supportsTools: /\btools\b/.test(source),
    supportsToolCalls: /\btool_calls\b/.test(source),
  };
}

/**
 * Whether a Jinja chat template can both describe tools and replay tool calls.
 *
 * @param templateStr - Raw Jinja template string.
 * @returns `true` when both {@link ToolCallingCapabilityInfo} flags are set.
 */
export function templateSupportsToolCalling(templateStr: string | undefined | null): boolean {
  const caps = analyzeToolCallingCapabilities(templateStr);
  return caps.supportsTools && caps.supportsToolCalls;
}

/**
 * Resolves whether the running (or GGUF-default) chat template supports tools.
 *
 * Preference order matches llama-server: an explicit loaded override, then the
 * GGUF-embedded template, then a previously computed metadata flag.
 *
 * @param loadedTemplate - Jinja actually written for `--chat-template-file`.
 * @param ggufTemplate - `tokenizer.chat_template` from the GGUF.
 * @param cachedFlag - Stored {@link GgufDisplayMetadata.hasToolCalling}, if any.
 * @returns `true` when the effective template supports function calling.
 */
export function chatTemplateSupportsToolCalling(
  loadedTemplate?: string | undefined | null,
  ggufTemplate?: string | undefined | null,
  cachedFlag?: boolean | undefined,
): boolean {
  const loaded = loadedTemplate?.trim();
  if (loaded) return templateSupportsToolCalling(loaded);
  const gguf = ggufTemplate?.trim();
  if (gguf) return templateSupportsToolCalling(gguf);
  return Boolean(cachedFlag);
}

/**
 * Reads tool-calling support from scanned GGUF metadata, recomputing from the
 * embedded chat template when a cache row predates {@link GgufDisplayMetadata.hasToolCalling}.
 *
 * @param metadata - Scanned model metadata, if present.
 * @returns `true` when the GGUF chat template supports function calling.
 */
export function metadataHasToolCalling(
  metadata:
    Partial<Pick<GgufDisplayMetadata, "hasToolCalling" | "chatTemplate">> | null | undefined,
): boolean {
  if (!metadata) return false;
  if (typeof metadata.hasToolCalling === "boolean") return metadata.hasToolCalling;
  return templateSupportsToolCalling(metadata.chatTemplate);
}

/**
 * Fills {@link GgufDisplayMetadata.hasToolCalling} when a cache row omitted it.
 *
 * @param metadata - Metadata parsed from GGUF or loaded from `model_cache`.
 * @returns The same object, or a copy with `hasToolCalling` derived from the template.
 */
export function withToolCallingMetadata<
  T extends {
    hasToolCalling?: boolean | undefined;
    chatTemplate?: string | undefined;
  },
>(metadata: T): T & { hasToolCalling: boolean } {
  if (typeof metadata.hasToolCalling === "boolean") {
    return metadata as T & { hasToolCalling: boolean };
  }
  return {
    ...metadata,
    hasToolCalling: templateSupportsToolCalling(metadata.chatTemplate),
  };
}

/**
 * Analyzes a Jinja chat template to detect capability flags and their defaults.
 *
 * @param templateStr - The raw Jinja template string.
 * @returns Capability information extracted from the template.
 */
export function analyzeTemplateCapabilities(templateStr: string): TemplateCapabilityInfo | null {
  if (!templateStr || typeof templateStr !== "string") {
    return null;
  }

  const hasPreserveThinking = /\bpreserve_thinking\b/.test(templateStr);

  if (!hasPreserveThinking) {
    return null;
  }

  // Pattern 1: explicit default filter, e.g. preserve_thinking | default(false)
  const defaultFilterMatch = templateStr.match(
    /preserve_thinking\s*\|\s*default\s*\(\s*(true|false)\s*\)/i,
  );
  if (defaultFilterMatch?.[1]) {
    return {
      hasPreserveThinking: true,
      preserveThinkingDefault: defaultFilterMatch[1].toLowerCase() === "true",
    };
  }

  // Pattern 2: undefined treated as true, e.g.
  // "preserve_thinking is undefined or preserve_thinking is true"
  const undefinedTrueMatch = templateStr.match(
    /preserve_thinking\s+is\s+undefined\s+or\s+preserve_thinking\s+is\s+true/i,
  );
  if (undefinedTrueMatch) {
    return { hasPreserveThinking: true, preserveThinkingDefault: true };
  }

  // Pattern 3: defined check without explicit true default, e.g.
  // "preserve_thinking is defined and preserve_thinking"
  const definedCheckMatch = templateStr.match(
    /preserve_thinking\s+is\s+defined\s+and\s+preserve_thinking/i,
  );
  if (definedCheckMatch) {
    return { hasPreserveThinking: true, preserveThinkingDefault: false };
  }

  // Fallback: variable is used but no clear default pattern detected
  return { hasPreserveThinking: true, preserveThinkingDefault: false };
}

/**
 * Analyzes the Jinja template that belongs to a load preset, without requiring
 * a model to be loaded.
 *
 * The editor override wins whenever it is non-empty; otherwise the GGUF-embedded
 * template for the preset's model is used.
 *
 * @param chatTemplateOverride - Load-preset Jinja override, if any.
 * @param ggufTemplate - GGUF-embedded chat template for the preset's model.
 * @returns Capability info plus provenance, or `null` when no template exists.
 */
export function analyzeLoadPresetChatTemplate(
  chatTemplateOverride: string | undefined,
  ggufTemplate: string | undefined,
): (TemplateCapabilityInfo & { provenance: ChatTemplateProvenance }) | null {
  const override = chatTemplateOverride?.trim();
  if (override) {
    const capabilities = analyzeTemplateCapabilities(override);
    return capabilities
      ? { ...capabilities, provenance: "override" }
      : { hasPreserveThinking: false, provenance: "override" };
  }

  const gguf = ggufTemplate?.trim();
  if (gguf) {
    const capabilities = analyzeTemplateCapabilities(gguf);
    return capabilities
      ? { ...capabilities, provenance: "gguf" }
      : { hasPreserveThinking: false, provenance: "gguf" };
  }

  return null;
}
