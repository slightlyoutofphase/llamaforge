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

/**
 * Verifies that an unknown JSON value matches the stored tool-call payload shape.
 *
 * @param value - Arbitrary parsed JSON value.
 * @returns `true` when the value conforms to {@link ParsedToolCall}.
 */
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

/**
 * Tool-call payload shape sent to llama-server / Jinja chat templates.
 * Persistence keeps `arguments` as a JSON string (OpenAI wire format); the
 * Gemma 4 template requires a mapping and `raise_exception`s on a string.
 */
export interface ApiToolCall {
  /** Unique tool call identifier. */
  id: string;
  /** Tool call payload type. */
  type: "function";
  /** Function metadata with deserialized argument mapping. */
  function: {
    /** Function name to invoke. */
    name: string;
    /** Argument object expected by Jinja templates (`arguments is mapping`). */
    arguments: Record<string, unknown>;
  };
}

/**
 * Parses a persisted tool-call arguments JSON string into a mapping.
 *
 * Gemma 4's chat template requires `arguments` to be a mapping. Arrays, primitives,
 * and malformed JSON become `{}` rather than being forwarded as a string.
 *
 * @param raw - JSON string stored on {@link ParsedToolCall.function.arguments}.
 * @returns A plain object suitable for the llama-server chat template context.
 */
export function parseToolCallArgumentsObject(raw: string): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(raw);
    if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    // Fall through to the empty mapping. A string here would trip Gemma 4's template.
  }
  return {};
}

/**
 * Converts persisted tool calls into the mapping-arguments shape sent at inference.
 *
 * llama.cpp may also coerce strings via `func_args_not_string` before Jinja rendering;
 * that behaviour is version-dependent, so LlamaForge always sends a mapping.
 *
 * @param toolCalls - Validated tool calls from persistence (string `arguments`).
 * @returns Tool calls with `arguments` deserialized to objects.
 */
export function toApiToolCalls(toolCalls: ParsedToolCall[]): ApiToolCall[] {
  return toolCalls.map((tc) => ({
    id: tc.id,
    type: "function",
    function: {
      name: tc.function.name,
      arguments: parseToolCallArgumentsObject(tc.function.arguments),
    },
  }));
}
