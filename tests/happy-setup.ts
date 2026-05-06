/**
 * @packageDocumentation
 * Setup helpers for Bun test and Happy DOM compatibility during client tests.
 */

import { afterEach, mock } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import fs from "node:fs";
import path from "node:path";
import * as ReactReal from "react";

const TEST_APP_DATA_DIR = path.resolve(import.meta.dir, "data", ".llamaforge");
const nativeWebGlobals = {
  fetch: globalThis.fetch,
  Request: globalThis.Request,
  Response: globalThis.Response,
  Headers: globalThis.Headers,
  FormData: globalThis.FormData,
  File: globalThis.File,
  Blob: globalThis.Blob,
};

function restoreNativeWebGlobals(): void {
  Object.assign(globalThis, nativeWebGlobals);

  if (typeof window !== "undefined") {
    Object.assign(window, nativeWebGlobals);
  }
}

Bun.env.LLAMAFORGE_APP_DATA_DIR = TEST_APP_DATA_DIR;
fs.rmSync(TEST_APP_DATA_DIR, { recursive: true, force: true });
fs.mkdirSync(TEST_APP_DATA_DIR, { recursive: true });

try {
  GlobalRegistrator.register();
} catch (_e) {}

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
