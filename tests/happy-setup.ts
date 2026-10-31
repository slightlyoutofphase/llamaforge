/**
 * @packageDocumentation
 * Setup helpers for Bun test and Happy DOM compatibility during client tests.
 */

import { afterEach, mock } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { notifyManager } from "@tanstack/react-query";
import fs from "node:fs";
import path from "node:path";
import * as ReactReal from "react";

const TEST_APP_DATA_DIR = path.resolve(import.meta.dir, "data", ".llamaforge");
const nativeWebGlobals = {
  fetch: globalThis.fetch.bind(globalThis),
  Request: globalThis.Request,
  Response: globalThis.Response,
  Headers: globalThis.Headers,
  FormData: globalThis.FormData,
  File: globalThis.File,
  Blob: globalThis.Blob,
  AbortController: globalThis.AbortController,
  AbortSignal: globalThis.AbortSignal,
};

/**
 * Bun's native `fetch`, captured before Happy DOM replaces web globals.
 * Server and real-integration tests must use this instead of `globalThis.fetch`.
 */
export const bunNativeFetch = nativeWebGlobals.fetch;

/**
 * Reassigns Bun's native web globals onto `globalThis` and `window`.
 *
 * @returns No return value.
 */
function restoreNativeWebGlobals(): void {
  Object.assign(globalThis, nativeWebGlobals);

  if (typeof window !== "undefined") {
    Object.assign(window, nativeWebGlobals);
  }
}

/**
 * Restores Bun's native fetch/Request/Response after Happy DOM or a test mock
 * has replaced them. Real llama-server tests call this before any HTTP I/O.
 *
 * @returns No return value.
 */
export function restoreBunNativeWebGlobals(): void {
  restoreNativeWebGlobals();
}

Bun.env["LLAMAFORGE_APP_DATA_DIR"] = TEST_APP_DATA_DIR;
fs.rmSync(TEST_APP_DATA_DIR, { recursive: true, force: true });
fs.mkdirSync(TEST_APP_DATA_DIR, { recursive: true });

try {
  GlobalRegistrator.register();
} catch (_e) {}

// index.html starts with <!doctype html>, so browsers report standards mode. happy-dom
// never sets compatMode. KaTeX reads it at import time and replaces its render() with a
// throwing stub in quirks mode, so report standards mode here as the app page does.
if (typeof document !== "undefined" && document.compatMode !== "CSS1Compat") {
  Object.defineProperty(document, "compatMode", { value: "CSS1Compat", configurable: true });
}

// Happy DOM replaces web globals like fetch/Request/Response with its own
// implementations. Server tests must keep Bun's native networking stack.
restoreNativeWebGlobals();

afterEach(() => {
  restoreNativeWebGlobals();
});

// React 19 + Testing Library + Bun "act" compatibility patch
// We mock 'react' to ensure 'act' is exported and reachable by testing-library
mock.module("react", () => {
  return {
    ...ReactReal,
    act: ReactReal.act || ((cb: any) => cb()),
  };
});

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

/**
 * Runs TanStack Query observer notifications in the same turn as the fetch
 * resolution so `await act(async () => render())` sees the re-render.
 *
 * The default scheduler posts a `setTimeout(0)`, which lands outside that
 * `act` and warns that ChatView/App updated without wrapping.
 *
 * @returns No return value.
 */
function installSyncReactQueryScheduler(): void {
  notifyManager.setScheduler((callback) => {
    callback();
  });
}

installSyncReactQueryScheduler();
