/**
 * @packageDocumentation
 * Keeps the Windows process tree tied to the terminal that launched LlamaForge.
 *
 * Closing the console window does not deliver SIGINT. Bun can swallow the
 * close notification and keep serving, which leaves llama-server inferencing
 * and the browser still receiving tokens. A console-control handler exits on
 * that notification, and a kill-on-close job kills llama-server if the Bun
 * process is terminated without running JavaScript.
 */

import { dlopen, JSCallback, ptr } from "bun:ffi";
import { logDebug } from "./logger";

/** Windows `CTRL_CLOSE_EVENT`. The console window is being closed. */
export const CTRL_CLOSE_EVENT = 2;
/** Windows `CTRL_LOGOFF_EVENT`. The user is logging off. */
export const CTRL_LOGOFF_EVENT = 5;
/** Windows `CTRL_SHUTDOWN_EVENT`. The machine is shutting down. */
export const CTRL_SHUTDOWN_EVENT = 6;

/** `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE` — children die when the job handle closes. */
const JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE = 0x2000;
/** `JobObjectExtendedLimitInformation`. */
const JOB_OBJECT_EXTENDED_LIMIT_INFORMATION = 9;
/**
 * Size of `JOBOBJECT_EXTENDED_LIMIT_INFORMATION` on 64-bit Windows.
 * `LimitFlags` sits at byte 16 of the nested basic-limit struct.
 */
const EXTENDED_LIMIT_INFO_BYTES = 144;
const LIMIT_FLAGS_OFFSET = 16;
/** `PROCESS_TERMINATE | PROCESS_SET_QUOTA`, required by `AssignProcessToJobObject`. */
const PROCESS_ASSIGN_ACCESS = 0x0101;

/**
 * Reports whether a Windows console-control code means the terminal is going away.
 *
 * Ctrl+C and Ctrl+Break return false so Bun can still emit SIGINT / SIGBREAK.
 * Close, logoff, and shutdown must exit from this process: returning "handled"
 * without exiting is what leaves the server running after the window disappears.
 *
 * @param ctrlType - `dwCtrlType` passed to a `HandlerRoutine`.
 * @returns `true` when LlamaForge should kill child processes and exit.
 */
export function consoleControlForcesExit(ctrlType: number): boolean {
  return (
    ctrlType === CTRL_CLOSE_EVENT ||
    ctrlType === CTRL_LOGOFF_EVENT ||
    ctrlType === CTRL_SHUTDOWN_EVENT
  );
}

type Kernel32 = {
  symbols: {
    SetConsoleCtrlHandler: (handler: unknown, add: number) => number;
    CreateJobObjectW: (security: null, name: null) => unknown;
    SetInformationJobObject: (
      job: unknown,
      infoClass: number,
      info: unknown,
      length: number,
    ) => number;
    AssignProcessToJobObject: (job: unknown, processHandle: unknown) => number;
    OpenProcess: (access: number, inherit: number, pid: number) => unknown;
    CloseHandle: (handle: unknown) => number;
  };
};

let kernel32: Kernel32 | null = null;
let consoleCallback: JSCallback | null = null;
let jobHandle: unknown = null;

/**
 * Loads kernel32 once. Non-Windows platforms never call this.
 *
 * @returns The opened library, or `null` when the symbols cannot be bound.
 */
function loadKernel32(): Kernel32 | null {
  if (kernel32) return kernel32;
  if (process.platform !== "win32") return null;
  try {
    kernel32 = dlopen("kernel32.dll", {
      SetConsoleCtrlHandler: { args: ["ptr", "i32"], returns: "i32" },
      CreateJobObjectW: { args: ["ptr", "ptr"], returns: "ptr" },
      SetInformationJobObject: { args: ["ptr", "u32", "ptr", "u32"], returns: "i32" },
      AssignProcessToJobObject: { args: ["ptr", "ptr"], returns: "i32" },
      OpenProcess: { args: ["u32", "i32", "u32"], returns: "ptr" },
      CloseHandle: { args: ["ptr"], returns: "i32" },
    }) as unknown as Kernel32;
    return kernel32;
  } catch (err) {
    logDebug("[windowsLifetime] kernel32 is unavailable", err);
    return null;
  }
}

/**
 * True when an FFI handle looks like a real Win32 HANDLE.
 *
 * @param handle - Value returned by a kernel32 function that yields a HANDLE.
 * @returns `false` for null, 0, and 0n.
 */
function isLiveHandle(handle: unknown): boolean {
  if (handle === null || handle === undefined) return false;
  if (typeof handle === "number") return handle !== 0;
  if (typeof handle === "bigint") return handle !== 0n;
  return true;
}

/**
 * Creates the process job used to reap llama-server when this process dies.
 *
 * The job handle is intentionally leaked for the life of the Bun process.
 * Windows closes it on exit, and `KILL_ON_JOB_CLOSE` then kills every member
 * even if JavaScript `exit` hooks never run.
 *
 * @returns The job handle, or `null` when the job cannot be created.
 */
function ensureKillOnCloseJob(): unknown {
  if (isLiveHandle(jobHandle)) return jobHandle;
  const lib = loadKernel32();
  if (!lib) return null;
  const job = lib.symbols.CreateJobObjectW(null, null);
  if (!isLiveHandle(job)) return null;
  const info = new Uint8Array(EXTENDED_LIMIT_INFO_BYTES);
  new DataView(info.buffer).setUint32(LIMIT_FLAGS_OFFSET, JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE, true);
  const configured = lib.symbols.SetInformationJobObject(
    job,
    JOB_OBJECT_EXTENDED_LIMIT_INFORMATION,
    ptr(info),
    EXTENDED_LIMIT_INFO_BYTES,
  );
  if (configured === 0) {
    lib.symbols.CloseHandle(job);
    return null;
  }
  jobHandle = job;
  return job;
}

/**
 * Puts a child process in the kill-on-close job.
 *
 * Failure is non-fatal. llama-server is still tracked and taskkilled from the
 * normal unload and `exit` paths; the job is the backstop for a hard kill.
 *
 * @param pid - Operating-system process id of the spawned llama-server.
 * @returns No return value.
 */
export function attachChildProcessToParentLifetime(pid: number): void {
  if (process.platform !== "win32") return;
  if (!Number.isInteger(pid) || pid <= 0) return;
  try {
    const lib = loadKernel32();
    const job = ensureKillOnCloseJob();
    if (!lib || !isLiveHandle(job)) return;
    const processHandle = lib.symbols.OpenProcess(PROCESS_ASSIGN_ACCESS, 0, pid);
    if (!isLiveHandle(processHandle)) {
      logDebug("[windowsLifetime] OpenProcess failed for llama-server", { pid });
      return;
    }
    try {
      const assigned = lib.symbols.AssignProcessToJobObject(job, processHandle);
      if (assigned === 0) {
        logDebug("[windowsLifetime] Could not assign llama-server to the lifetime job", { pid });
      }
    } finally {
      lib.symbols.CloseHandle(processHandle);
    }
  } catch (err) {
    logDebug("[windowsLifetime] Failed to attach llama-server to the parent lifetime", err);
  }
}

/**
 * Registers a Windows console-control handler that force-exits on window close.
 *
 * The callback is retained for the process lifetime so the FFI trampoline is
 * not garbage-collected. Ctrl+C is not consumed here.
 *
 * @param onForceExit - Synchronous shutdown. It must kill child processes and exit.
 * @returns No return value.
 */
export function installWindowsConsoleCloseHandler(onForceExit: () => void): void {
  if (process.platform !== "win32") return;
  if (consoleCallback) return;
  const lib = loadKernel32();
  if (!lib) return;
  consoleCallback = new JSCallback(
    (ctrlType: number) => {
      if (!consoleControlForcesExit(ctrlType)) return 0;
      try {
        onForceExit();
      } catch (err) {
        logDebug("[windowsLifetime] Console-close shutdown failed", err);
      }
      return 1;
    },
    { args: ["u32"], returns: "i32", threadsafe: true },
  );
  const registered = lib.symbols.SetConsoleCtrlHandler(consoleCallback.ptr, 1);
  if (registered === 0) {
    consoleCallback.close();
    consoleCallback = null;
    logDebug("[windowsLifetime] SetConsoleCtrlHandler failed");
  }
}
