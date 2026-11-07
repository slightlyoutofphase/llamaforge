/**
 * @packageDocumentation
 * End-to-end client shell tests covering the status bar, settings defaults, and chat switching.
 */

import { afterAll, afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, render, screen } from "@testing-library/react";
import { useAppStore } from "../../src/client/store";
import { useUiStore } from "../../src/client/uiStore";
import { DEFAULT_APP_SETTINGS } from "../../src/shared/defaults";
import { asFetch } from "../fixtures";

/**
 * Router link stand-in for the app shell end-to-end tests.
 *
 * @param children - Link contents.
 * @param className - Class forwarded onto the anchor.
 * @param to - Destination href.
 * @param props - Remaining anchor attributes.
 * @returns An anchor the shell can render without a router.
 */
function E2eLink({ children, className, to, ...props }: any) {
  return (
    <a href={to} className={className} {...props}>
      {children}
    </a>
  );
}

/**
 * Router outlet stand-in for the app shell end-to-end tests.
 *
 * @returns A placeholder the shell renders as its route content.
 */
function E2eOutlet() {
  return <div data-testid="e2e-outlet">Outlet</div>;
}

let App: typeof import("../../src/client/App").default;
let queryClient: QueryClient;
let originalFetch: typeof global.fetch;
let navigateSpy = mock();

const settings = {
  ...DEFAULT_APP_SETTINGS,
  llamaServerPath: "/usr/bin/llama-server",
  modelsPath: "/models",
};

describe("E2E application shell", () => {
  beforeEach(async () => {
    originalFetch = global.fetch;
    queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
    });
    navigateSpy = mock();
    global.fetch = asFetch(
      mock((input) => {
        const url = typeof input === "string" ? input : input.toString();
        if (url.endsWith("/api/settings")) {
          return Promise.resolve(
            new Response(JSON.stringify(settings), {
              headers: { "Content-Type": "application/json" },
            }),
          );
        }
        if (url.includes("/api/runtime/usage")) {
          return Promise.resolve(
            new Response(
              JSON.stringify({ ramBytes: 512 * 1024 * 1024, vramBytes: 0, llamaServerPid: null }),
              {
                headers: { "Content-Type": "application/json" },
              },
            ),
          );
        }
        if (url.includes("/context-usage")) {
          const used = url.includes("chat-a") ? 120 : url.includes("chat-b") ? 40 : 0;
          return Promise.resolve(
            new Response(JSON.stringify({ usedTokens: used, contextSize: 4096 }), {
              headers: { "Content-Type": "application/json" },
            }),
          );
        }
        if (url.includes("/api/server/status")) {
          return Promise.resolve(
            new Response(JSON.stringify({ status: "idle", config: null }), {
              headers: { "Content-Type": "application/json" },
            }),
          );
        }
        if (url.includes("/api/hardware")) {
          return Promise.resolve(
            new Response(
              JSON.stringify({ totalRamBytes: 16 * 1024 ** 3, cpuThreads: 8, gpus: [] }),
              {
                headers: { "Content-Type": "application/json" },
              },
            ),
          );
        }
        if (url.includes("/api/chats") && url.includes("POST")) {
          return Promise.resolve(
            new Response(JSON.stringify({ id: "created-chat", name: "New Chat" }), {
              headers: { "Content-Type": "application/json" },
            }),
          );
        }
        return Promise.resolve(
          new Response(JSON.stringify([]), { headers: { "Content-Type": "application/json" } }),
        );
      }),
    );

    global.WebSocket = class {
      onopen: ((ev?: Event) => void) | null = null;
      onclose: ((ev?: CloseEvent) => void) | null = null;
      onmessage: ((ev?: MessageEvent) => void) | null = null;
      onerror: ((ev?: Event) => void) | null = null;
      readyState = 1;
      close() {}
      send() {}
    } as unknown as typeof WebSocket;

    await mock.module("@tanstack/react-router", () => ({
      useLocation: () => ({ pathname: "/" }),
      useNavigate: () => navigateSpy,
      useParams: () => ({}),
      Link: E2eLink,
      Outlet: E2eOutlet,
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
      processUsage: { ramBytes: 512 * 1024 * 1024, vramBytes: 0, llamaServerPid: null },
      loadedConfig: null,
      generationStats: null,
      isGenerating: false,
    });
    useUiStore.setState({ rightPanelView: null, isConsoleVisible: false });
  });

  afterEach(() => {
    cleanup();
    mock.restore();
    global.fetch = originalFetch;
  });

  afterAll(() => {
    mock.restore();
  });

  it("renders the status bar with context and memory meters", async () => {
    await act(async () => {
      render(
        <QueryClientProvider client={queryClient}>
          <App />
        </QueryClientProvider>,
      );
    });

    const statusBar = await screen.findByTestId("status-bar");
    expect(statusBar.textContent).toContain("Context:");
    expect(statusBar.textContent).toContain("System RAM:");
    expect(statusBar.textContent).toContain("VRAM:");
    expect(statusBar.textContent).toContain("0.5 GB");
  });

  it("updates context occupancy when switching conversations", async () => {
    await act(async () => {
      render(
        <QueryClientProvider client={queryClient}>
          <App />
        </QueryClientProvider>,
      );
    });

    await act(async () => {
      useAppStore.setState({
        currentChatId: "chat-a",
        contextUsage: { usedTokens: 120, contextSize: 4096 },
        loadedConfig: { contextSize: 4096 } as any,
      });
    });
    expect((await screen.findByTestId("status-bar")).textContent).toContain("120");
    expect(screen.getByTestId("status-bar").textContent).toContain("4,096");

    await act(async () => {
      useAppStore.setState({
        currentChatId: "chat-b",
        contextUsage: { usedTokens: 40, contextSize: 4096 },
      });
    });
    expect(screen.getByTestId("status-bar").textContent).toContain("40");
    expect(screen.getByTestId("status-bar").textContent).not.toContain("120");
  });

  it("keeps reload-last-model off in the default settings payload", () => {
    expect(settings.autoloadLastModel).toBe(false);
    expect(DEFAULT_APP_SETTINGS.autoloadLastModel).toBe(false);
  });

  it("keeps include-audio-from-videos off in the default settings payload", () => {
    expect(settings.includeVideoAudio).toBe(false);
    expect(DEFAULT_APP_SETTINGS.includeVideoAudio).toBe(false);
  });
});
