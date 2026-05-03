/**
 * @packageDocumentation
 * Safe parsing helpers for assistant tool call metadata.
 */

/**
 * A validated assistant tool call payload.
 */
export interface ParsedToolCall {
  /** Unique tool call identifier. */
  id: string;
  /** Tool call payload type. */
  type: "function";
  /** Function metadata for this tool call. */
  function: {
    /** Function name to invoke. */
    name: string;
    /** JSON string of tool arguments. */
    arguments: string;
  };
}

function isParsedToolCall(value: unknown): value is ParsedToolCall {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as {
    id?: unknown;
    type?: unknown;
    function?: { name?: unknown; arguments?: unknown };
  };

  return (
    typeof candidate.id === "string" &&
    candidate.id.length > 0 &&
    candidate.type === "function" &&
    typeof candidate.function?.name === "string" &&
    candidate.function.name.length > 0 &&
    typeof candidate.function?.arguments === "string"
  );
}

/**
 * Parses and validates stored `toolCallsJson` payloads.
 *
 * @param toolCallsJson - Raw JSON payload from persistence or websocket state.
 * @returns Validated tool call list or `null` when the payload is absent or invalid.
 */
export function parseToolCallsJson(
  toolCallsJson: string | null | undefined,
): ParsedToolCall[] | null {
  if (!toolCallsJson) return null;

  try {
    const parsed = JSON.parse(toolCallsJson) as unknown;
    if (!Array.isArray(parsed)) return null;
    if (!parsed.every(isParsedToolCall)) return null;
    return parsed;
  } catch {
    return null;
  }
}

/**
 * Normalizes a raw `toolCallsJson` payload for safe persistence.
 *
 * @param toolCallsJson - Raw JSON payload from persistence or import.
 * @returns Canonical JSON string for valid payloads, otherwise `undefined`.
 */
export function sanitizeToolCallsJson(
  toolCallsJson: string | null | undefined,
): string | undefined {
  const parsed = parseToolCallsJson(toolCallsJson);
  return parsed ? JSON.stringify(parsed) : undefined;
}
