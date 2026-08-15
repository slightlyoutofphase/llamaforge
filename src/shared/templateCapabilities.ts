/**
 * @packageDocumentation
 * Shared template capability analysis utilities used by both client and server.
 */

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
