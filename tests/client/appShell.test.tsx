/**
 * @packageDocumentation
 * Focused tests for root app-shell settings behavior.
 */

import { afterAll, afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { useAppStore } from "../../src/client/store";
import { useUiStore } from "../../src/client/uiStore";

let App: typeof import("../../src/client/App").default;
let navigateSpy = mock();
let queryClient: QueryClient;
let originalFetch: typeof global.fetch;

const appSettings = {
  theme: "dark",
  accentColor: "#7c3aed",
  fontSize: 17,
  showConsoleOnStartup: true,
};

const defaultAppState = {
  connectWs: mock().mockResolvedValue(undefined),
  disconnectWs: mock().mockResolvedValue(undefined),
  fetchHardware: mock().mockResolvedValue(undefined),
  fetchModels: mock().mockResolvedValue(undefined),
  fetchServerStatus: mock().mockResolvedValue(undefined),
  refreshProcessUsage: mock().mockResolvedValue(undefined),
  refreshContextUsage: mock().mockResolvedValue(undefined),
  unloadModel: mock().mockResolvedValue(undefined),
  serverStatus: "idle" as const,
  isConnected: true,
  errorMessage: null,
  errorActionLabel: null,
  errorAction: null,
  clearError: mock(),
  notifications: [],
  removeNotification: mock(),
  currentChatId: null,
};

describe("App shell settings", () => {
  beforeEach(() => {
    originalFetch = global.fetch;
  });

  beforeEach(async () => {
    mock.restore();
    cleanup();
    queryClient = new QueryClient({
      defaultOptions: {
        queries: { retry: false },
        mutations: { retry: false },
      },
    });
    document.documentElement.style.fontSize = "";
    document.documentElement.className = "";
    navigateSpy = mock();
    global.fetch = mock((input, init) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url.endsWith("/api/settings")) {
        return Promise.resolve(
          new Response(JSON.stringify(appSettings), {
            headers: { "Content-Type": "application/json" },
          }),
        );
      }
      if (url.includes("/api/chats") && (init?.method ?? "GET") === "POST") {
        return Promise.resolve(
          new Response(JSON.stringify({ id: "created-chat", name: "New Chat" }), {
            headers: { "Content-Type": "application/json" },
          }),
        );
      }
      if (url.includes("/api/presets/load") || url.includes("/api/presets/inference")) {
        return Promise.resolve(
          new Response(JSON.stringify([]), {
            headers: { "Content-Type": "application/json" },
          }),
        );
      }

      return Promise.resolve(
        new Response(JSON.stringify({}), {
          headers: { "Content-Type": "application/json" },
        }),
      );
    }) as typeof global.fetch;

    await mock.module("@tanstack/react-router", () => ({
      useLocation: () => ({ pathname: "/" }),
      useNavigate: () => navigateSpy,
      useParams: () => ({}),
      Link: ({ children, className, to, ...props }: any) => (
        <a href={to} className={className} {...props}>
          {children}
        </a>
      ),
      Outlet: () => <div data-testid="app-outlet">Outlet</div>,
    }));

    useAppStore.setState(defaultAppState);
    useUiStore.setState({ rightPanelView: null, activePresetId: null, isConsoleVisible: false });

    const appModule = await import(`../../src/client/App.tsx?cachebust=${Date.now()}`);
    App = appModule.default;
  });

  afterEach(() => {
    cleanup();
    mock.restore();
    global.fetch = originalFetch;
  });

  afterAll(() => {
    mock.restore();
  });

  /**
   * Renders the app shell and waits for the settings query to settle.
   *
   * App applies theme/font/console state from `/api/settings` after mount.
   * Waiting here keeps those updates inside Testing Library's `act` boundary.
   *
   * @returns No return value.
   */
  async function renderApp(): Promise<void> {
    render(
      <QueryClientProvider client={queryClient}>
        <App />
      </QueryClientProvider>,
    );
    await waitFor(() => {
      expect(document.documentElement.style.fontSize).toBe("17px");
    });
  }

  it("applies the configured root font size and opens the console on startup", async () => {
    await renderApp();
    expect(useUiStore.getState().isConsoleVisible).toBe(true);
  });

  it("creates and opens a chat when the chat workspace button is clicked without an active chat", async () => {
    await renderApp();

    fireEvent.click(screen.getByTitle("Chat Workspace"));

    await waitFor(() => {
      expect(navigateSpy).toHaveBeenCalledWith({
        to: "/chat/$chatId",
        params: { chatId: "created-chat" },
      });
    });
  });

  it("shows the model load overlay over the shell while a model is loading", async () => {
    useAppStore.setState({
      ...defaultAppState,
      serverStatus: "loading",
      loadProgress: 42,
      loadProgressPhase: "loading_weights",
      loadProgressDetail: "Loading tensor blocks",
    });

    await renderApp();

    expect(screen.getByText("Loading model")).toBeTruthy();
    expect(screen.getByText("42%")).toBeTruthy();
    expect(screen.getByText("Loading tensor blocks")).toBeTruthy();
    expect(screen.getByRole("alertdialog")).toBeTruthy();
  });

  it("renders the status bar with context and memory meters", async () => {
    useAppStore.setState({
      ...defaultAppState,
      processUsage: { ramBytes: 1024 ** 3, vramBytes: 0, llamaServerPid: null },
    });

    await renderApp();

    const statusBar = await screen.findByTestId("status-bar");
    expect(statusBar.textContent).toContain("Context:");
    expect(statusBar.textContent).toContain("System RAM:");
    expect(statusBar.textContent).toContain("VRAM:");
  });
});
