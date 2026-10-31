/**
 * @packageDocumentation
 * Client-side logging helpers that mirror messages to the in-app debug console.
 */

import { formatLogArgument } from "../shared/logFormat";
import { useAppStore } from "./store";

let isSilent = false;
try {
  const runtime = globalThis as typeof globalThis & {
    process?: { env?: { NODE_ENV?: string } };
    Bun?: { env?: { NODE_ENV?: string } };
  };
  isSilent = runtime.process?.env?.NODE_ENV === "test" || runtime.Bun?.env?.NODE_ENV === "test";
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
function formatArgs(args: unknown[]): string {
  if (args.length === 0) return "";
  return ` ${args.map((arg) => formatLogArgument(arg)).join(" ")}`;
}

/**
 * Records an informational log entry.
 *
 * @param message - Primary message text to emit.
 * @param args - Additional diagnostic values appended to the log message.
 * @returns No return value.
 */
export function logInfo(message: string, ...args: unknown[]) {
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
export function logWarn(message: string, ...args: unknown[]) {
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
export function logError(message: string, ...args: unknown[]) {
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
export function logDebug(message: string, ...args: unknown[]) {
  if (!isSilent) console.debug(message, ...args);
  useAppStore.getState().addLog("debug", message + formatArgs(args));
}
