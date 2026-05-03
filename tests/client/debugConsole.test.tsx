/**
 * @packageDocumentation
 * Tests for the client debug console and associated UI flows.
 */

import { afterEach, describe, expect, it, mock } from "bun:test";
import { cleanup, render, screen } from "@testing-library/react";
import * as React from "react";
import { ConsoleLog } from "../../src/client/ConsoleLog";
import { useAppStore } from "../../src/client/store";
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

  it("virtualizes large log lists", async () => {
    useUiStore.setState({ isConsoleVisible: true });
    useAppStore.setState({
      logs: Array.from({ length: 200 }, (_, index) => `[info] line-${index}`),
    });

    render(<ConsoleLog />);

    expect(screen.getAllByTestId("console-log-row").length).toBeLessThan(200);
    expect(screen.getByText("[info] line-0")).toBeDefined();
  });

  it("renders understandable cache stat labels instead of acronyms", async () => {
    useUiStore.setState({ isConsoleVisible: true });
    useAppStore.setState({
      promptCacheStats: { totalEvaluated: 250, totalCached: 125 },
      generationStats: {
        tokensCached: 40,
        totalPredicted: 20,
        tokensEvaluated: 80,
      },
    });

    render(<ConsoleLog />);

    expect(screen.getByText(/Prompt tokens processed:/)).toBeTruthy();
    expect(screen.getByText(/Prompt tokens reused from cache:/)).toBeTruthy();
    expect(screen.getByText(/Last request cache reuse:/)).toBeTruthy();
  });
});
