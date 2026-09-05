/**
 * @packageDocumentation
 * Centralized backend logging helpers with WebSocket broadcasting and runtime log-level filtering.
 */

import type { AppSettings } from "../shared/types";
import { broadcastLog } from "./wsHub";

type LogLevel = AppSettings["logLevel"];
type EmittedLogLevel = "info" | "warn" | "error" | "debug" | "verbose" | "server";

const LOG_LEVEL_PRIORITY: Record<LogLevel, number> = {
  off: -1,
  error: 0,
  warn: 1,
  info: 2,
  debug: 3,
  verbose: 4,
};

const EMITTED_LEVEL_PRIORITY: Record<EmittedLogLevel, number> = {
  error: 0,
  warn: 1,
  info: 2,
  debug: 3,
  verbose: 4,
  server: 3,
};

let isSilent = Bun.env.NODE_ENV === "test";
let configuredLogLevel: LogLevel = Bun.env.NODE_ENV === "test" ? "off" : "info";

/**
 * Enables or disables console logging and WebSocket log broadcasting.
 * Useful for suppressing noise during automated tests.
 *
 * @param silent - Whether all logger output should be suppressed.
 * @returns Nothing.
 */
export function setSilent(silent: boolean): void {
  isSilent = silent;
}

/**
 * Updates the configured runtime log level used for backend log emission.
 *
 * @param level - The new log level from persisted application settings.
 * @returns Nothing.
 */
export function setConfiguredLogLevel(level: LogLevel): void {
  configuredLogLevel = level;
}

/**
 * Determines whether a log message at the given severity should be emitted.
 *
 * @param level - The candidate emitted log level.
 * @returns `true` when the current logger configuration allows the message.
 */
export function shouldEmitLog(level: EmittedLogLevel): boolean {
  if (isSilent) {
    return false;
  }

  return EMITTED_LEVEL_PRIORITY[level] <= LOG_LEVEL_PRIORITY[configuredLogLevel];
}

/**
 * Serializes extra logger arguments into the string forwarded to WebSocket clients.
 *
 * @param args - Additional values supplied to the logger call.
 * @returns A space-prefixed string containing the serialized arguments.
 */
function formatArgs(args: unknown[]): string {
  if (args.length === 0) return "";
  return ` ${args.map((arg) => (typeof arg === "object" ? JSON.stringify(arg) : String(arg))).join(" ")}`;
}

/**
 * Emits an informational log message when the current settings allow it.
 *
 * @param message - The primary log message.
 * @param args - Additional structured arguments to append.
 * @returns Nothing.
 */
export function logInfo(message: string, ...args: unknown[]): void {
  if (!shouldEmitLog("info")) {
    return;
  }

  console.log(message, ...args);
  broadcastLog("info", message + formatArgs(args));
}

/**
 * Emits a warning log message when the current settings allow it.
 *
 * @param message - The primary log message.
 * @param args - Additional structured arguments to append.
 * @returns Nothing.
 */
export function logWarn(message: string, ...args: unknown[]): void {
  if (!shouldEmitLog("warn")) {
    return;
  }

  console.warn(message, ...args);
  broadcastLog("warn", message + formatArgs(args));
}

/**
 * Emits an error log message when the current settings allow it.
 *
 * @param message - The primary log message.
 * @param args - Additional structured arguments to append.
 * @returns Nothing.
 */
export function logError(message: string, ...args: unknown[]): void {
  if (!shouldEmitLog("error")) {
    return;
  }

  console.error(message, ...args);
  broadcastLog("error", message + formatArgs(args));
}

/**
 * Emits a debug log message when the current settings allow it.
 *
 * @param message - The primary log message.
 * @param args - Additional structured arguments to append.
 * @returns Nothing.
 */
export function logDebug(message: string, ...args: unknown[]): void {
  if (!shouldEmitLog("debug")) {
    return;
  }

  console.debug(message, ...args);
  broadcastLog("debug", message + formatArgs(args));
}

/**
 * Emits a verbose log message when the configured log level is `verbose`.
 *
 * Use this for bulky diagnostic payloads such as the active inference sampling
 * settings, which should not appear at `debug`.
 *
 * @param message - The primary log message.
 * @param args - Additional structured arguments to append.
 * @returns Nothing.
 */
export function logVerbose(message: string, ...args: unknown[]): void {
  if (!shouldEmitLog("verbose")) {
    return;
  }

  console.debug(message, ...args);
  broadcastLog("debug", message + formatArgs(args));
}
