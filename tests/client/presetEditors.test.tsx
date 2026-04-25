import { afterEach, beforeAll, describe, expect, it, mock } from "bun:test";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { InferencePresetEditor } from "../../src/client/components/preset/InferencePresetEditor";
import { LoadPresetEditor } from "../../src/client/components/preset/LoadPresetEditor";

import { useAppStore } from "../../src/client/store";
import { useUiStore } from "../../src/client/uiStore";

const queryClient = new QueryClient({
  defaultOptions: {
    queries: { retry: false },
    mutations: { retry: false },
  },
});

/**
 * Fixture: A sample inference preset for testing.
 */
const mockInferencePreset = {
  id: "test-inf-id",
  name: "Test Inference",
  isDefault: true,
  temperature: 0.8,
  topK: 40,
  topP: 0.95,
  minP: 0.05,
  repeatPenalty: 1.1,
  maxTokens: -1,
  stopStrings: [],
  toolCallsEnabled: false,
  tools: [],
  structuredOutput: { enabled: false, schema: {} },
};

/**
 * Fixture: A sample load preset for testing.
 */
const mockLoadPreset = {
  id: "test-load-id",
  name: "Test Load",
  modelPath: "/models/test.gguf",
  isDefault: true,
  isReadonly: false,
  config: {
    modelPath: "/models/test.gguf",
    contextSize: 2048,
    gpuLayers: 10,
    threads: 4,
    flashAttention: true,
  },
};

describe("Preset Editors Integration", () => {
  beforeAll(() => {
    // Mock fetch for all API calls in these components
    global.fetch = mock((url, _options) => {
      if (typeof url === "string") {
        if (url.includes("/api/presets/inference")) {
          return Promise.resolve(new Response(JSON.stringify([mockInferencePreset])));
        }
        if (url.includes("/api/presets/load")) {
          return Promise.resolve(new Response(JSON.stringify([mockLoadPreset])));
        }
        if (url.includes("/api/presets/system")) {
          return Promise.resolve(new Response(JSON.stringify([])));
        }
      }
      return Promise.resolve(new Response(JSON.stringify({})));
    });

    // Setup UI and store state via zustand
    useUiStore.setState({
      activePresetId: "test-inf-id",
    });

    useAppStore.setState({
      models: [
        {
          primaryPath: "/models/test.gguf",
          metadata: { name: "test-model", chatTemplate: "test-template" } as any,
          mmprojPath: undefined,
          mtime: Date.now(),
        },
      ],
    });
  });

  afterEach(() => {
    cleanup();
    queryClient.clear();
  });

  it("InferencePresetEditor: renders sampling parameters and handles changes", async () => {
    render(
      <QueryClientProvider client={queryClient}>
        <InferencePresetEditor />
      </QueryClientProvider>,
    );

    // Verify initial render from fixture
    expect(await screen.findByText("Test Inference (Default)")).toBeDefined();

    const tempSlider = screen.getByLabelText(/Temperature/i);
    expect((tempSlider as HTMLInputElement).value).toBe("0.8");

    // Verify change updates local state (the value on screen)
    fireEvent.change(tempSlider, { target: { value: "1.2" } });
    expect(screen.getByText("1.20")).toBeDefined();
  });

  it("LoadPresetEditor: renders accordion sections and model config", async () => {
    render(
      <QueryClientProvider client={queryClient}>
        <LoadPresetEditor />
      </QueryClientProvider>,
    );

    expect(await screen.findByText("Test Load (Default)")).toBeDefined();

    // Verify accordion section content
    expect(screen.getAllByText(/GPU Layers/i)).toBeDefined();
    const gpuInput = screen.getByLabelText(/GPU Layers/i);
    expect((gpuInput as HTMLInputElement).value).toBe("10");

    // Verify Jinja template override section
    expect(screen.getByText("Jinja Chat Template")).toBeDefined();
  });
});
