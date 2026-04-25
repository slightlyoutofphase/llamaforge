import { afterEach, describe, expect, it, mock } from "bun:test";
import { cleanup, render, screen } from "@testing-library/react";
import * as React from "react";
import { ConsoleLog } from "../../src/client/ConsoleLog";
import { useUiStore } from "../../src/client/uiStore";

// Mock useDeferredValue to be synchronous in tests
mock.module("react", () => ({
  ...React,
  useDeferredValue: (val: any) => val,
}));

describe("debugConsole", () => {
  afterEach(() => {
    cleanup();
  });

  it("renders empty console state when visible", async () => {
    useUiStore.setState({ isConsoleVisible: true });
    render(<ConsoleLog />);
    const heading = await screen.findByText("System Stream");
    expect(heading).not.toBeNull();
  });
});
