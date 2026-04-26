/**
 * @packageDocumentation
 * Setup helpers for Bun test and Happy DOM compatibility during client tests.
 */

import { mock } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import * as ReactReal from "react";

try {
  GlobalRegistrator.register();
} catch (_e) {}

// React 19 + Testing Library + Bun "act" compatibility patch
// We mock 'react' to ensure 'act' is exported and reachable by testing-library
mock.module("react", () => {
  return {
    ...ReactReal,
    act: ReactReal.act || ((cb: any) => cb()),
  };
});

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
