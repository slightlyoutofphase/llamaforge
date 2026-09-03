/**
 * @packageDocumentation
 * Built-in tool definitions that can be toggled on inference presets.
 * Kept free of runtime dependencies so the client bundle can import it.
 */

import type { ToolDefinition } from "./types";

/**
 * Tools LlamaForge can execute locally. Custom JSON tools are not executed.
 */
export const BUILT_IN_TOOLS: ToolDefinition[] = [
  {
    name: "get_datetime",
    description: "Get the current date and time in ISO format.",
    parameters: { type: "object", properties: {} },
  },
  {
    name: "calculate",
    description: "Perform basic mathematical calculations.",
    parameters: {
      type: "object",
      properties: {
        expression: {
          type: "string",
          description: "The mathjs expression to evaluate (e.g. '2 + 2' or 'sqrt(16)').",
        },
      },
      required: ["expression"],
    },
  },
];

/**
 * Returns whether a tool name is one of the locally implemented built-ins.
 *
 * @param name - Tool function name.
 * @returns `true` when LlamaForge can execute the tool locally.
 */
export function isBuiltInToolName(name: string): boolean {
  return BUILT_IN_TOOLS.some((tool) => tool.name === name);
}
