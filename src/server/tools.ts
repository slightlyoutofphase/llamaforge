/**
 * @packageDocumentation
 * JSON Schema to GBNF compiler and tool calling utilities.
 */

/**
 * Converts JSON Schema to GBNF (Grammar-Based Network Format) using json2gbnf.
 */
import json2gbnf from "json2gbnf";
import { all, create } from "mathjs";
import { logError } from "./logger";

if (!all) {
  throw new Error("mathjs factory map is unavailable.");
}
const math = create(all);
math.import(
  {
    import: () => {
      throw new Error("Function import is disabled");
    },
    createUnit: () => {
      throw new Error("Function createUnit is disabled");
    },
  },
  { override: true },
);

/**
 * Converts a JSON Schema object into a GBNF grammar string for constrained model output.
 *
 * @param schema - The JSON Schema defining the expected output structure.
 * @returns The compiled GBNF grammar string.
 */
export function generateGrammarFromSchema(schema: Record<string, unknown>): string {
  try {
    return json2gbnf(schema);
  } catch (error) {
    logError("Failed to compile JSON schema to GBNF", error);
    return "";
  }
}

type PendingToolApproval = {
  chatId: string;
  resolve: (decision: ToolApprovalDecision) => void;
  timer: ReturnType<typeof setTimeout>;
};

export type ToolApprovalDecision = {
  approved: boolean;
  editedArguments?: string | undefined;
  reason?: "approved" | "rejected" | "timeout" | "cancelled" | "disconnected" | "unloaded";
};

const pendingApprovals = new Map<string, PendingToolApproval>();
let toolApprovalTimeoutMs = 120_000;

/**
 * Resolves and removes a pending tool approval entry.
 *
 * @param toolCallId - Unique tool-call identifier waiting for a user decision.
 * @param decision - Final decision that should resolve the pending approval promise.
 * @returns `true` when a pending approval was found and settled.
 */
function settlePendingApproval(toolCallId: string, decision: ToolApprovalDecision): boolean {
  const pending = pendingApprovals.get(toolCallId);
  if (!pending) {
    return false;
  }

  clearTimeout(pending.timer);
  pendingApprovals.delete(toolCallId);
  pending.resolve(decision);
  return true;
}

/**
 * Overrides the default tool approval timeout for tests.
 *
 * @param timeoutMs - Timeout in milliseconds.
 * @returns No return value.
 * @internal
 */
export function __setToolApprovalTimeoutMs(timeoutMs: number): void {
  toolApprovalTimeoutMs = timeoutMs;
}

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
): Promise<ToolApprovalDecision> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      settlePendingApproval(toolCallId, { approved: false, reason: "timeout" });
    }, toolApprovalTimeoutMs);
    pendingApprovals.set(toolCallId, { chatId, resolve, timer });
  });
}

/**
 * Cancels all pending tool approvals for a specific chat or all chats.
 *
 * @param chatId - Optional chat ID used to limit which pending approvals are cancelled.
 * @param reason - Cancellation reason propagated back to the suspended generation.
 * @returns No return value.
 */
export function cancelPendingApprovals(
  chatId?: string,
  reason: "cancelled" | "disconnected" | "unloaded" = "cancelled",
) {
  for (const [id, pending] of pendingApprovals.entries()) {
    if (!chatId || pending.chatId === chatId) {
      clearTimeout(pending.timer);
      pending.resolve({ approved: false, reason });
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
 * @returns No return value.
 */
export function resolveToolApproval(
  toolCallId: string,
  approved: boolean,
  editedArguments?: string | undefined,
  chatId?: string,
) {
  const pending = pendingApprovals.get(toolCallId);
  if (!pending) return;
  if (chatId && pending.chatId !== chatId) {
    logError("Rejected tool approval for mismatched chat", { toolCallId, chatId });
    return;
  }
  settlePendingApproval(toolCallId, {
    approved,
    editedArguments,
    reason: approved ? "approved" : "rejected",
  });
}

/**
 * Executes a built-in tool function.
 *
 * @param name - The name of the tool to execute.
 * @param args - The JSON stringified arguments for the tool.
 * @returns The stringified result of the tool execution.
 */
export async function executeTool(name: string, args: string): Promise<string> {
  let parsedArgs: Record<string, unknown> = {};
  try {
    const parsed: unknown = JSON.parse(args || "{}");
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      return JSON.stringify({ error: "Tool arguments must be a JSON object." });
    }
    parsedArgs = parsed as Record<string, unknown>;
  } catch {
    return JSON.stringify({ error: "Malformed tool arguments: invalid JSON." });
  }

  if (name === "get_datetime") {
    return JSON.stringify({ result: new Date().toISOString() });
  }

  if (name === "calculate") {
    try {
      const expression = String(parsedArgs["expression"]);
      const result = math.evaluate(expression);
      return JSON.stringify({ result });
    } catch (e) {
      return JSON.stringify({ error: String(e) });
    }
  }

  return JSON.stringify({ error: `Tool ${name} not found.` });
}
