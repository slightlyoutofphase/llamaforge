/**
 * @packageDocumentation
 * Tests for preset editor components and their form interactions.
 */

import { afterEach, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";

import { queryKeys } from "../../src/client/queries";
import { useAppStore } from "../../src/client/store";
import { useUiStore } from "../../src/client/uiStore";

let InferencePresetEditor: typeof import("../../src/client/components/preset/InferencePresetEditor").InferencePresetEditor;
let LoadPresetEditor: typeof import("../../src/client/components/preset/LoadPresetEditor").LoadPresetEditor;

let queryClient: QueryClient;

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
  thinkingTagOverride: {
    openTag: "<think>",
    closeTag: "</think>",
    enableToken: "<|think|>",
  },
  config: {
    modelPath: "/models/test.gguf",
    contextSize: 2048,
    gpuLayers: 10,
    threads: 4,
    flashAttn: "on",
  },
};

describe("Preset Editors Integration", () => {
  beforeAll(async () => {
    const inferenceModule =
      await import("../../src/client/components/preset/InferencePresetEditor");
    InferencePresetEditor = inferenceModule.InferencePresetEditor;
    const loadModule = await import("../../src/client/components/preset/LoadPresetEditor");
    LoadPresetEditor = loadModule.LoadPresetEditor;
  });

  beforeEach(() => {
    queryClient = new QueryClient({
      defaultOptions: {
        queries: { retry: false, staleTime: Number.POSITIVE_INFINITY },
        mutations: { retry: false },
      },
    });

    queryClient.setQueryData(queryKeys.presetsInference(), [mockInferencePreset]);
    queryClient.setQueryData(queryKeys.presetsLoad(), [mockLoadPreset]);
    queryClient.setQueryData(queryKeys.presetsSystem(), []);

    useUiStore.setState({
      rightPanelView: null,
      activePresetId: null,
      isConsoleVisible: false,
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
    useUiStore.setState({ activePresetId: "test-inf-id" });

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
    useUiStore.setState({ activePresetId: "test-load-id" });

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

    const imageBudgetSelect = screen.getByLabelText(/VIR max tokens/i);
    expect((imageBudgetSelect as HTMLSelectElement).value).toBe("560");

    fireEvent.click(screen.getByRole("button", { name: "Memory & KV Cache" }));
    const flashAttnSelect = screen.getByLabelText(/Flash Attention/i);
    expect((flashAttnSelect as HTMLSelectElement).value).toBe("on");

    // Verify Jinja template override section
    expect(screen.getByText("Jinja Chat Template")).toBeDefined();
    fireEvent.click(screen.getByRole("button", { name: "Thinking Tag Override" }));
    expect(screen.getByLabelText("Open Tag")).toBeDefined();
    expect(screen.getByRole("button", { name: /Detect from architecture/i })).toBeDefined();
  });
});
