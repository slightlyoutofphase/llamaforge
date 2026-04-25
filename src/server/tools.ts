/**
 * @packageDocumentation
 * JSON Schema to GBNF compiler and tool calling utilities.
 */

/**
 * Converts JSON Schema to GBNF (Grammar-Based Network Format) using json2gbnf.
 */
import json2gbnf from "json2gbnf";

/**
 * Converts a JSON Schema object into a GBNF grammar string for constrained model output.
 *
 * @param schema - The JSON Schema defining the expected output structure.
 * @returns The compiled GBNF grammar string.
 */
export function generateGrammarFromSchema(schema: Record<string, unknown>): string {
  try {
    return json2gbnf(schema as any);
  } catch (error) {
    console.error("Failed to compile JSON schema to GBNF", error);
    return "";
  }
}

/**
 * Parses generic returned message structures attempting safely to uncover JSON tool call outputs.
 *
 * @param content - Internal raw string prediction context.
 * @returns Array mapped tool calls or null.
 */
export function parseToolCallsFromResponse(content: string) {
  try {
    // If output is structured as JSON Tool Call
    const parsed = JSON.parse(content);
    if (parsed.tool_calls) return parsed.tool_calls;
    return null;
  } catch {
    return null;
  }
}

type PendingToolApproval = {
  chatId: string;
  resolve: (decision: { approved: boolean; editedArguments?: string | undefined }) => void;
};

const pendingApprovals = new Map<string, PendingToolApproval>();

/**
 * Waits for a user to approve or edit a tool call via the UI.
 *
 * @param chatId - The chat ID this tool call belongs to.
 * @param toolCallId - The unique ID of the tool call.
 * @returns A promise resolving to the user's decision (approval and optional edited arguments).
 */
export function waitForToolApproval(
  chatId: string,
  toolCallId: string,
): Promise<{ approved: boolean; editedArguments?: string | undefined }> {
  return new Promise((resolve) => {
    pendingApprovals.set(toolCallId, { chatId, resolve });
  });
}

/**
 * Cancels all pending tool approvals for a specific chat or all chats.
 *
 * @param chatId - Optional chat ID to filter by.
 */
export function cancelPendingApprovals(chatId?: string) {
  for (const [id, pending] of pendingApprovals.entries()) {
    if (!chatId || pending.chatId === chatId) {
      pending.resolve({ approved: false });
      pendingApprovals.delete(id);
    }
  }
}

/**
 * Releases the execution hold for an pending tool once user responds.
 *
 * @param toolCallId - Explicit lookup identifier mapped to pending interaction.
 * @param approved - Action explicitly sanctioned by the user natively.
 * @param editedArguments - Parameter string mapped for execution bypass/override.
 */
export function resolveToolApproval(
  toolCallId: string,
  approved: boolean,
  editedArguments?: string | undefined,
) {
  const pending = pendingApprovals.get(toolCallId);
  if (pending) {
    pending.resolve({ approved, editedArguments });
    pendingApprovals.delete(toolCallId);
  }
}

/**
 * Default global tools provided across contexts when explicitly bound for usage.
 */
export const BUILT_IN_TOOLS = [
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
          description: "The math expression (e.g., '2 + 2' or 'Math.sqrt(16)')",
        },
      },
      required: ["expression"],
    },
  },
];

import { evaluate } from "mathjs";

/**
 * Executes a built-in tool function.
 *
 * @param name - The name of the tool to execute.
 * @param args - The JSON stringified arguments for the tool.
 * @returns The stringified result of the tool execution.
 * @throws {Error} If argument parsing fails.
 */
export async function executeTool(name: string, args: string): Promise<string> {
  const parsedArgs = JSON.parse(args || "{}");

  if (name === "get_datetime") {
    return JSON.stringify({ result: new Date().toISOString() });
  }

  if (name === "calculate") {
    try {
      const expression = String(parsedArgs.expression);
      const result = evaluate(expression);
      return JSON.stringify({ result });
    } catch (e) {
      return JSON.stringify({ error: String(e) });
    }
  }

  return JSON.stringify({ error: `Tool ${name} not found.` });
}
