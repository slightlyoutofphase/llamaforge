/**
 * @packageDocumentation
 * Focused tests for root app-shell settings behavior.
 */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, mock } from "bun:test";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { useAppStore } from "../../src/client/store";
import { useUiStore } from "../../src/client/uiStore";

let App: typeof import("../../src/client/App").default;
let originalFetch: typeof global.fetch;
let navigateSpy = mock();

mock.module("@tanstack/react-router", () => ({
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

const queryClient = new QueryClient({
  defaultOptions: {
    queries: { retry: false },
    mutations: { retry: false },
  },
});

describe("App shell settings", () => {
  beforeAll(async () => {
    originalFetch = global.fetch;
    global.fetch = mock((input, init) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url.includes("/api/settings")) {
        return Promise.resolve(
          new Response(JSON.stringify(appSettings), {
            headers: { "Content-Type": "application/json" },
          }),
        );
      }
      if (url.includes("/api/chats") && init?.method === "POST") {
        return Promise.resolve(
          new Response(JSON.stringify({ id: "created-chat", name: "New Chat" }), {
            headers: { "Content-Type": "application/json" },
          }),
        );
      }
      if (
        url.includes("/api/chats") ||
        url.includes("/api/presets/load") ||
        url.includes("/api/presets/inference") ||
        url.includes("/api/presets/system")
      ) {
        return Promise.resolve(
          new Response(JSON.stringify([]), {
            headers: { "Content-Type": "application/json" },
          }),
        );
      }
      return Promise.resolve(
        new Response(JSON.stringify({}), { headers: { "Content-Type": "application/json" } }),
      );
    });

    const appModule = await import("../../src/client/App");
    App = appModule.default;
  });

  beforeEach(() => {
    cleanup();
    queryClient.clear();
    document.documentElement.style.fontSize = "";
    navigateSpy = mock();
    useAppStore.setState(defaultAppState);
    useUiStore.setState({ rightPanelView: null, activePresetId: null, isConsoleVisible: false });
  });

  afterEach(() => {
    cleanup();
  });

  afterAll(() => {
    mock.restore();
    global.fetch = originalFetch;
  });

  it("applies the configured root font size and opens the console on startup", async () => {
    render(
      <QueryClientProvider client={queryClient}>
        <App />
      </QueryClientProvider>,
    );

    await waitFor(() => {
      expect(document.documentElement.style.fontSize).toBe("17px");
      expect(useUiStore.getState().isConsoleVisible).toBe(true);
    });
  });

  it("creates and opens a chat when the chat workspace button is clicked without an active chat", async () => {
    render(
      <QueryClientProvider client={queryClient}>
        <App />
      </QueryClientProvider>,
    );

    fireEvent.click(screen.getByTitle("Chat Workspace"));

    await waitFor(() => {
      expect(navigateSpy).toHaveBeenCalledWith({
        to: "/chat/$chatId",
        params: { chatId: "created-chat" },
      });
    });
  });
});
