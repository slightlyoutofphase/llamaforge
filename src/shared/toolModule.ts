/**
 * @packageDocumentation
 * Shared helpers for LlamaForge tool module names and persistable definitions.
 */

import type { ToolDefinition } from "./types";

/**
 * OpenAI-style function names accepted for built-in and user tools.
 * Must start with a letter and may contain letters, digits, and underscores.
 */
export const TOOL_NAME_PATTERN = /^[A-Za-z][A-Za-z0-9_]{0,63}$/;

/**
 * Returns whether a tool function name is valid for discovery and execution.
 *
 * @param name - Candidate tool name.
 * @returns `true` when the name matches {@link TOOL_NAME_PATTERN}.
 */
export function isValidToolName(name: string): boolean {
  return TOOL_NAME_PATTERN.test(name);
}

/**
 * Copies only the fields stored on an inference preset and sent to llama-server.
 *
 * @param tool - Tool metadata that may include extra discovery fields.
 * @returns A persistable {@link ToolDefinition}.
 */
export function toStoredToolDefinition(tool: ToolDefinition): ToolDefinition {
  return {
    name: tool.name,
    description: tool.description,
    parameters: tool.parameters,
  };
}
