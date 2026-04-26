import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, mock } from "bun:test";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { useAppStore } from "../../src/client/store";
import { useUiStore } from "../../src/client/uiStore";

let App: typeof import("../../src/client/App").default;
let ModelSelector: typeof import("../../src/client/ModelSelector").ModelSelector;
let ModelLibraryPanel: typeof import("../../src/client/components/sidebar/ModelLibraryPanel").ModelLibraryPanel;
let originalFetch: typeof global.fetch;

const mockPresets = [
  {
    id: "preset-1",
    name: "Default Preset",
    modelPath: "/model/path",
    isDefault: true,
    isReadonly: false,
    config: { modelPath: "/model/path" },
    createdAt: Date.now(),
    updatedAt: Date.now(),
  },
];

const longModelPath =
  "/very/long/path/to/a/model/weights/that/should/wrap/and/not/truncate/when/the/sidebar-is-opened/and/closed/for/regression/testing.gguf";

const defaultAppState = {
  connectWs: mock().mockResolvedValue(undefined),
  disconnectWs: mock().mockResolvedValue(undefined),
  fetchHardware: mock().mockResolvedValue(undefined),
  fetchModels: mock().mockResolvedValue(undefined),
  fetchServerStatus: mock().mockResolvedValue(undefined),
  serverStatus: "idle",
  isConnected: true,
  errorMessage: null,
  errorActionLabel: null,
  errorAction: null,
  clearError: mock(),
  notifications: [],
  removeNotification: mock(),
};

const queryClient = new QueryClient({
  defaultOptions: {
    queries: { retry: false },
    mutations: { retry: false },
  },
});

describe("Layout regression tests", () => {
  beforeAll(async () => {
    mock.restore();

    mock.module("@tanstack/react-router", () => ({
      useLocation: () => ({ pathname: "/" }),
      useParams: () => ({}),
      Link: ({ children, className, to, ...props }: any) => (
        <a href={to} className={className} {...props}>
          {children}
        </a>
      ),
      Outlet: () => <div data-testid="registry-outlet">Registry content</div>,
      useNavigate: () => mock(),
    }));

    originalFetch = global.fetch;
    global.fetch = mock((input) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url.includes("/api/presets/load")) {
        return Promise.resolve(
          new Response(JSON.stringify(mockPresets), {
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
    ({ ModelSelector } = await import("../../src/client/ModelSelector"));
    ({ ModelLibraryPanel } = await import("../../src/client/components/sidebar/ModelLibraryPanel"));
  });

  beforeEach(() => {
    cleanup();
    queryClient.clear();
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

  it("keeps registry content visible when toggling the settings sidebar", async () => {
    render(
      <QueryClientProvider client={queryClient}>
        <App />
      </QueryClientProvider>,
    );

    expect(screen.getByTestId("registry-outlet")).toBeTruthy();

    fireEvent.click(screen.getByTitle("Settings"));
    expect(await screen.findByTestId("settings-panel")).toBeTruthy();

    fireEvent.click(screen.getByTitle("Settings"));
    expect(screen.queryByTestId("settings-panel")).toBeNull();
    expect(screen.getByTestId("registry-outlet")).toBeTruthy();
  });

  it("renders ModelSelector with a responsive shrink container and long path wrapping styles", () => {
    useAppStore.setState({
      models: [
        {
          publisher: "Test Vendor",
          modelName: "Long Model Name Example",
          primaryPath: longModelPath,
          mmProjPath: "/model/mmproj",
          metadata: {
            architecture: "gemma4",
            name: "Long Model Name Example",
            fileSizeBytes: 4_294_967_296,
            contextLength: 4096,
            embeddingLength: 0,
            attentionHeadCount: 16,
            attentionHeadCountKv: 16,
            blockCount: 32,
            feedForwardLength: 0,
            quantType: "q4_0",
            hasVisionEncoder: true,
            hasAudioEncoder: false,
            defaultTemperature: 0.8,
            defaultTopK: 40,
            defaultTopP: 0.95,
            defaultMinP: 0.05,
            defaultRepeatPenalty: 1.1,
            chatTemplate: undefined,
            bosToken: undefined,
            eosToken: undefined,
          },
        },
      ],
      loadModel: mock(),
      unloadModel: mock(),
      serverStatus: "idle",
      loadedModel: null,
      messages: [],
      isGenerating: false,
    });

    const { container } = render(
      <QueryClientProvider client={queryClient}>
        <ModelSelector />
      </QueryClientProvider>,
    );
    const wrapper = container.querySelector("div[class*='min-w-0'][class*='overflow-y-auto']");
    expect(wrapper).toBeTruthy();

    const pathElement = screen.getByText((content) => content.includes(longModelPath));
    expect(pathElement).toBeTruthy();
    expect(pathElement.className).toContain("break-all");
    expect(pathElement.className).toContain("whitespace-pre-wrap");
  });

  it("renders ModelLibraryPanel cards with wrapping classes instead of truncation", () => {
    useAppStore.setState({
      models: [
        {
          publisher: "Vendor",
          modelName: "Long Model Name Example",
          primaryPath: longModelPath,
          mmProjPath: "/model/mmproj",
          metadata: {
            architecture: "gemma4",
            name: "Long Model Name Example",
            fileSizeBytes: 4_294_967_296,
            contextLength: 4096,
            embeddingLength: 0,
            attentionHeadCount: 16,
            attentionHeadCountKv: 16,
            blockCount: 32,
            feedForwardLength: 0,
            quantType: "q4_0",
            hasVisionEncoder: true,
            hasAudioEncoder: false,
            defaultTemperature: 0.8,
            defaultTopK: 40,
            defaultTopP: 0.95,
            defaultMinP: 0.05,
            defaultRepeatPenalty: 1.1,
            chatTemplate: undefined,
            bosToken: undefined,
            eosToken: undefined,
          },
        },
      ],
      loadModel: mock(),
      unloadModel: mock(),
      serverStatus: "idle",
      loadedModel: null,
      messages: [],
      isGenerating: false,
    });

    render(
      <QueryClientProvider client={queryClient}>
        <ModelLibraryPanel />
      </QueryClientProvider>,
    );

    const nameElement = screen.getByText("Long Model Name Example");
    expect(nameElement.className).toContain("break-words");

    const pathElement = screen.getByText((content) => content.includes(longModelPath));
    expect(pathElement.className).toContain("break-all");
    expect(pathElement.className).toContain("whitespace-pre-wrap");
  });
});
