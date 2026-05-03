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
 * Enables or disables console logging and UI log buffering.
 */
export function setSilent(silent: boolean) {
  isSilent = silent;
}

function formatArgs(args: any[]): string {
  if (args.length === 0) return "";
  return ` ${args.map((a) => (typeof a === "object" ? JSON.stringify(a) : String(a))).join(" ")}`;
}

export function logInfo(message: string, ...args: any[]) {
  if (!isSilent) console.log(message, ...args);
  useAppStore.getState().addLog("info", message + formatArgs(args));
}

export function logWarn(message: string, ...args: any[]) {
  if (!isSilent) console.warn(message, ...args);
  useAppStore.getState().addLog("warn", message + formatArgs(args));
}

export function logError(message: string, ...args: any[]) {
  if (!isSilent) console.error(message, ...args);
  useAppStore.getState().addLog("error", message + formatArgs(args));
}

export function logDebug(message: string, ...args: any[]) {
  if (!isSilent) console.debug(message, ...args);
  useAppStore.getState().addLog("debug", message + formatArgs(args));
}
