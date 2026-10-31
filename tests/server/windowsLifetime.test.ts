/**
 * @packageDocumentation
 * Tests for the Windows console-close decision.
 */

import { describe, expect, it } from "bun:test";
import {
  consoleControlForcesExit,
  CTRL_CLOSE_EVENT,
  CTRL_LOGOFF_EVENT,
  CTRL_SHUTDOWN_EVENT,
} from "../../src/server/windowsLifetime";

describe("windowsLifetime", () => {
  it("force-exits when the console window, session, or machine is going away", () => {
    expect(consoleControlForcesExit(CTRL_CLOSE_EVENT)).toBe(true);
    expect(consoleControlForcesExit(CTRL_LOGOFF_EVENT)).toBe(true);
    expect(consoleControlForcesExit(CTRL_SHUTDOWN_EVENT)).toBe(true);
  });

  it("leaves Ctrl+C and Ctrl+Break to the normal signal handlers", () => {
    expect(consoleControlForcesExit(0)).toBe(false);
    expect(consoleControlForcesExit(1)).toBe(false);
  });
});
