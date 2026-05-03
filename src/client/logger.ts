/**
 * @packageDocumentation
 * Client-side logging helpers that mirror messages to the in-app debug console.
 */

import { useAppStore } from "./store";

let isSilent = false;
try {
  isSilent =
    (globalThis as any).process?.env?.NODE_ENV === "test" ||
    (globalThis as any).Bun?.env?.NODE_ENV === "test";
} catch {
  // Ignore
}

/**
 * Enables or disables client-side logging output.
 *
 * @param silent - Whether console output and UI log buffering should be suppressed.
 * @returns No return value.
 */
export function setSilent(silent: boolean) {
  isSilent = silent;
}

/**
 * Formats arbitrary log arguments into the single string stored in the UI log buffer.
 *
 * @param args - Additional log arguments supplied alongside the primary message.
 * @returns A space-prefixed string representation of the extra log arguments.
 */
function formatArgs(args: any[]): string {
  if (args.length === 0) return "";
  return ` ${args.map((a) => (typeof a === "object" ? JSON.stringify(a) : String(a))).join(" ")}`;
}

/**
 * Records an informational log entry.
 *
 * @param message - Primary message text to emit.
 * @param args - Additional diagnostic values appended to the log message.
 * @returns No return value.
 */
export function logInfo(message: string, ...args: any[]) {
  if (!isSilent) console.log(message, ...args);
  useAppStore.getState().addLog("info", message + formatArgs(args));
}

/**
 * Records a warning log entry.
 *
 * @param message - Primary warning text to emit.
 * @param args - Additional diagnostic values appended to the log message.
 * @returns No return value.
 */
export function logWarn(message: string, ...args: any[]) {
  if (!isSilent) console.warn(message, ...args);
  useAppStore.getState().addLog("warn", message + formatArgs(args));
}

/**
 * Records an error log entry.
 *
 * @param message - Primary error text to emit.
 * @param args - Additional diagnostic values appended to the log message.
 * @returns No return value.
 */
export function logError(message: string, ...args: any[]) {
  if (!isSilent) console.error(message, ...args);
  useAppStore.getState().addLog("error", message + formatArgs(args));
}

/**
 * Records a debug log entry.
 *
 * @param message - Primary debug message to emit.
 * @param args - Additional diagnostic values appended to the log message.
 * @returns No return value.
 */
export function logDebug(message: string, ...args: any[]) {
  if (!isSilent) console.debug(message, ...args);
  useAppStore.getState().addLog("debug", message + formatArgs(args));
}
