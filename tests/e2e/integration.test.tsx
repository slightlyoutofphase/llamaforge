/**
 * @packageDocumentation
 * Integration tests covering full client-side user flows.
 */

import { afterAll, afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import { useAppStore } from "../../src/client/store";
import { DEFAULT_APP_SETTINGS } from "../../src/shared/defaults";
import { asFetch } from "../fixtures";
import type { ReactNode } from "react";

/**
 * Router link stand-in for the integration flow.
 *
 * @param children - Link contents.
 * @returns An anchor the shell can render without a router.
 */
function IntegrationLink({ children }: { children?: ReactNode }) {
  return <a href="#test">{children}</a>;
}

/**
 * Router outlet stand-in for the integration flow.
 *
 * @returns A placeholder outlet.
 */
function IntegrationOutlet() {
  return <div data-testid="outlet">Mock Outlet</div>;
}

let App: typeof import("../../src/client/App").default;
let queryClient: QueryClient;
const originalFetch = global.fetch;
const originalWebSocket = global.WebSocket;

describe("E2E Integration", () => {
  beforeEach(async () => {
    queryClient = new QueryClient({
      defaultOptions: {
        queries: { retry: false },
        mutations: { retry: false },
      },
    });
    global.fetch = asFetch((input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url.includes("/api/hardware")) {
        return Promise.resolve(
          new Response(JSON.stringify({ totalRamBytes: 0, cpuThreads: 0, gpus: [] })),
        );
      }
      if (url.includes("/api/server/status")) {
        return Promise.resolve(new Response(JSON.stringify({ status: "idle", config: null })));
      }
      if (url.includes("/api/runtime/usage")) {
        return Promise.resolve(
          new Response(JSON.stringify({ ramBytes: 1024, vramBytes: 0, llamaServerPid: null })),
        );
      }
      if (url.includes("/api/settings")) {
        return Promise.resolve(new Response(JSON.stringify(DEFAULT_APP_SETTINGS)));
      }
      return Promise.resolve(new Response(JSON.stringify([])));
    });
    global.WebSocket = class {
      onopen: ((ev?: Event) => void) | null = null;
      onclose: ((ev?: CloseEvent) => void) | null = null;
      onmessage: ((ev?: MessageEvent) => void) | null = null;
      close() {}
      send() {}
    } as unknown as typeof WebSocket;

    await mock.module("@tanstack/react-router", () => ({
      Link: IntegrationLink,
      Outlet: IntegrationOutlet,
      useLocation: () => ({ pathname: "/" }),
      useNavigate: () => mock(),
      useParams: () => ({}),
    }));

    const appModule = await import(`../../src/client/App.tsx?cachebust=${Date.now()}`);
    App = appModule.default;
    useAppStore.setState({
      connectWs: mock(),
      disconnectWs: mock(),
      fetchHardware: mock().mockResolvedValue(undefined),
      fetchModels: mock().mockResolvedValue(undefined),
      fetchServerStatus: mock().mockResolvedValue(undefined),
      refreshProcessUsage: mock().mockResolvedValue(undefined),
      refreshContextUsage: mock().mockResolvedValue(undefined),
      unloadModel: mock(),
      serverStatus: "idle",
      isConnected: true,
      errorMessage: null,
      errorActionLabel: null,
      errorAction: null,
      clearError: mock(),
      notifications: [],
      removeNotification: mock(),
      currentChatId: null,
      contextUsage: null,
      processUsage: { ramBytes: 1024, vramBytes: 0, llamaServerPid: null },
      loadedConfig: null,
      generationStats: null,
      isGenerating: false,
    });
  });

  afterEach(() => {
    cleanup();
    mock.restore();
    global.fetch = originalFetch;
    global.WebSocket = originalWebSocket;
  });

  afterAll(() => {
    global.fetch = originalFetch;
    global.WebSocket = originalWebSocket;
  });

  it("mounts the root component and renders the status bar", async () => {
    await act(async () => {
      render(
        <QueryClientProvider client={queryClient}>
          <App />
        </QueryClientProvider>,
      );
    });

    const statusBar = await screen.findByTestId("status-bar");
    await waitFor(() => {
      expect(document.body.textContent).toContain("LF");
      expect(statusBar.textContent).toContain("Context:");
      expect(statusBar.textContent).toContain("System RAM:");
      expect(statusBar.textContent).toContain("VRAM:");
    });
  });
});
