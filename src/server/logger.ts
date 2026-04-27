import { broadcastLog } from "./wsHub";

function formatArgs(args: any[]): string {
  if (args.length === 0) return "";
  return ` ${args.map((a) => (typeof a === "object" ? JSON.stringify(a) : String(a))).join(" ")}`;
}

export function logInfo(message: string, ...args: any[]) {
  console.log(message, ...args);
  broadcastLog("info", message + formatArgs(args));
}

export function logWarn(message: string, ...args: any[]) {
  console.warn(message, ...args);
  broadcastLog("warn", message + formatArgs(args));
}

export function logError(message: string, ...args: any[]) {
  console.error(message, ...args);
  broadcastLog("error", message + formatArgs(args));
}

export function logDebug(message: string, ...args: any[]) {
  console.debug(message, ...args);
  broadcastLog("debug", message + formatArgs(args));
}
