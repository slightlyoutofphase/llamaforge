import { useAppStore } from "./store";

function formatArgs(args: any[]): string {
  if (args.length === 0) return "";
  return ` ${args.map((a) => (typeof a === "object" ? JSON.stringify(a) : String(a))).join(" ")}`;
}

export function logInfo(message: string, ...args: any[]) {
  console.log(message, ...args);
  useAppStore.getState().addLog("info", message + formatArgs(args));
}

export function logWarn(message: string, ...args: any[]) {
  console.warn(message, ...args);
  useAppStore.getState().addLog("warn", message + formatArgs(args));
}

export function logError(message: string, ...args: any[]) {
  console.error(message, ...args);
  useAppStore.getState().addLog("error", message + formatArgs(args));
}

export function logDebug(message: string, ...args: any[]) {
  console.debug(message, ...args);
  useAppStore.getState().addLog("debug", message + formatArgs(args));
}
