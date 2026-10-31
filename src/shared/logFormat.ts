/**
 * @packageDocumentation
 * Shared formatting for log arguments that are not plain strings.
 */

/**
 * Formats one logger argument for a single-line or multi-line log record.
 *
 * `Error` values keep their message and stack. Circular objects are marked
 * instead of throwing out of `JSON.stringify`.
 *
 * @param value - Argument passed to a logger call.
 * @returns Text safe to append to a log line.
 */
export function formatLogArgument(value: unknown): string {
  if (value instanceof Error) {
    return value.stack || `${value.name}: ${value.message}`;
  }
  if (typeof value === "bigint") return value.toString();
  if (typeof value !== "object" || value === null) return String(value);

  const ancestors: object[] = [];
  try {
    return JSON.stringify(value, function (this: object, _key, nested: unknown) {
      if (nested instanceof Error) {
        return { name: nested.name, message: nested.message, stack: nested.stack };
      }
      if (typeof nested === "bigint") return nested.toString();
      if (typeof nested === "object" && nested !== null) {
        const holderIndex = ancestors.lastIndexOf(this);
        if (holderIndex >= 0) {
          ancestors.length = holderIndex + 1;
        }
        if (ancestors.includes(nested)) return "[Circular]";
        ancestors.push(nested);
      }
      return nested;
    });
  } catch {
    return Object.prototype.toString.call(value);
  }
}
