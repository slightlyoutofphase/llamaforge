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
let SystemPresetEditor: typeof import("../../src/client/components/preset/SystemPresetEditor").SystemPresetEditor;

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
 * Fixture: A sample system preset for testing.
 */
const mockSystemPreset = {
  id: "test-sys-id",
  name: "Test System",
  isDefault: true,
  content: "You are a helpful assistant.",
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
    const systemModule = await import("../../src/client/components/preset/SystemPresetEditor");
    SystemPresetEditor = systemModule.SystemPresetEditor;
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
    queryClient.setQueryData(queryKeys.presetsSystem(), [mockSystemPreset]);
    queryClient.setQueryData(queryKeys.tools(), {
      tools: [
        {
          name: "get_datetime",
          description: "Get the current date and time in ISO format.",
          parameters: { type: "object", properties: {} },
          source: "builtin",
          fileName: "get_datetime.ts",
        },
        {
          name: "calculate",
          description: "Perform basic mathematical calculations.",
          parameters: {
            type: "object",
            properties: { expression: { type: "string" } },
            required: ["expression"],
          },
          source: "builtin",
          fileName: "calculate.ts",
        },
        {
          name: "echo_text",
          description: "Return the provided text unchanged.",
          parameters: {
            type: "object",
            properties: { text: { type: "string" } },
            required: ["text"],
          },
          source: "user",
          fileName: "echo_text.ts",
        },
      ],
      directories: ["/repo/tools"],
    });

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
      loadedModel: null,
      loadedConfig: null,
      serverStatus: "idle",
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

    expect(await screen.findByText("Test Inference (Default)")).toBeDefined();

    const tempSlider = screen.getByLabelText(/Temperature/i);
    expect((tempSlider as HTMLInputElement).value).toBe("0.8");

    fireEvent.change(tempSlider, { target: { value: "1.2" } });
    expect(screen.getByText("1.20")).toBeDefined();
    expect(screen.queryByLabelText(/Preserve Thinking/i)).toBeNull();
  });

  it("InferencePresetEditor: lists built-in and user TypeScript tools for execution", async () => {
    useUiStore.setState({ activePresetId: "test-inf-id" });

    render(
      <QueryClientProvider client={queryClient}>
        <InferencePresetEditor />
      </QueryClientProvider>,
    );

    expect(await screen.findByText("Test Inference (Default)")).toBeDefined();

    fireEvent.click(screen.getByLabelText("Tools (Function Calling)"));
    expect(screen.getByText("echo_text")).toBeDefined();
    expect(screen.getByText("get_datetime")).toBeDefined();
    expect(screen.getByText("User")).toBeDefined();
    expect(screen.queryByText(/not executed/i)).toBeNull();
    expect(screen.queryByText(/Only built-in tools are executed/i)).toBeNull();

    fireEvent.click(screen.getByLabelText(/echo_text/i));
    expect((screen.getByLabelText(/echo_text/i) as HTMLInputElement).checked).toBe(true);
  });

  it("InferencePresetEditor: greys out tools when the loaded chat template cannot call them", async () => {
    useUiStore.setState({ activePresetId: "test-inf-id" });
    useAppStore.setState({
      serverStatus: "running",
      loadedModel: {
        publisher: "test",
        modelName: "plain",
        primaryPath: "/models/plain.gguf",
        metadata: {
          architecture: "llama",
          name: "plain",
          fileSizeBytes: 1,
          contextLength: 4096,
          embeddingLength: undefined,
          attentionHeadCount: undefined,
          attentionHeadCountKv: undefined,
          blockCount: undefined,
          feedForwardLength: undefined,
          quantType: undefined,
          hasVisionEncoder: false,
          hasAudioEncoder: false,
          hasToolCalling: false,
          isDraftModel: false,
          defaultTemperature: undefined,
          defaultTopK: undefined,
          defaultTopP: undefined,
          defaultMinP: undefined,
          defaultRepeatPenalty: undefined,
          chatTemplate: "{{ bos_token }}{{ message.content }}",
        },
      },
      loadedConfig: {
        modelPath: "/models/plain.gguf",
        contextSize: 4096,
      } as any,
    });

    render(
      <QueryClientProvider client={queryClient}>
        <InferencePresetEditor />
      </QueryClientProvider>,
    );

    expect(await screen.findByText("Test Inference (Default)")).toBeDefined();
    const toggle = screen.getByLabelText("Tools (Function Calling)") as HTMLInputElement;
    expect(toggle.disabled).toBe(true);
    expect(screen.getByText(/does not describe tools/i)).toBeDefined();
  });

  it("LoadPresetEditor: renders accordion sections and model config", async () => {
    useUiStore.setState({ activePresetId: "test-load-id" });

    render(
      <QueryClientProvider client={queryClient}>
        <LoadPresetEditor />
      </QueryClientProvider>,
    );

    expect(await screen.findByText("Test Load (Default)")).toBeDefined();

    expect(screen.getAllByText(/GPU Layers/i)).toBeDefined();
    const gpuInput = screen.getByLabelText(/GPU Layers/i);
    expect((gpuInput as HTMLInputElement).value).toBe("10");

    const imageBudgetSelect = screen.getByLabelText(/VIR max tokens/i);
    expect((imageBudgetSelect as HTMLSelectElement).value).toBe("560");
    const imageMinInput = screen.getByLabelText(/VIR min tokens/i);
    expect((imageMinInput as HTMLInputElement).value).toBe("70");
    const videoFpsInput = screen.getByLabelText(/Video FPS/i);
    expect((videoFpsInput as HTMLInputElement).value).toBe("4");

    fireEvent.click(screen.getByRole("button", { name: "Memory & KV Cache" }));
    const flashAttnSelect = screen.getByLabelText(/Flash Attention/i);
    expect((flashAttnSelect as HTMLSelectElement).value).toBe("on");

    expect(screen.getByText("Jinja Chat Template")).toBeDefined();
    fireEvent.click(screen.getByRole("button", { name: "Thinking Tag Override" }));
    expect(screen.getByLabelText("Open Tag")).toBeDefined();
    expect(screen.getByRole("button", { name: /Detect from architecture/i })).toBeDefined();
  });

  it("InferencePresetEditor: close button returns to settings panel", async () => {
    useUiStore.setState({ rightPanelView: "inferencePreset", activePresetId: "test-inf-id" });

    render(
      <QueryClientProvider client={queryClient}>
        <InferencePresetEditor />
      </QueryClientProvider>,
    );

    const closeButton = document.querySelector(".lucide-x")?.closest("button") as HTMLButtonElement;
    expect(closeButton).toBeTruthy();
    fireEvent.click(closeButton);

    expect(useUiStore.getState().rightPanelView).toBe("settings");
  });

  it("LoadPresetEditor: close button returns to settings panel", async () => {
    useUiStore.setState({ rightPanelView: "loadPreset", activePresetId: "test-load-id" });

    render(
      <QueryClientProvider client={queryClient}>
        <LoadPresetEditor />
      </QueryClientProvider>,
    );

    const closeButton = document.querySelector(".lucide-x")?.closest("button") as HTMLButtonElement;
    expect(closeButton).toBeTruthy();
    fireEvent.click(closeButton);

    expect(useUiStore.getState().rightPanelView).toBe("settings");
  });

  it("SystemPresetEditor: close button returns to settings panel", async () => {
    useUiStore.setState({ rightPanelView: "systemPreset", activePresetId: null });

    render(
      <QueryClientProvider client={queryClient}>
        <SystemPresetEditor />
      </QueryClientProvider>,
    );

    const closeButton = document.querySelector(".lucide-x")?.closest("button") as HTMLButtonElement;
    expect(closeButton).toBeTruthy();
    fireEvent.click(closeButton);

    expect(useUiStore.getState().rightPanelView).toBe("settings");
  });

  it("LoadPresetEditor: preserve thinking is disabled when this preset's template does not support it", async () => {
    useUiStore.setState({ activePresetId: "test-load-id" });

    render(
      <QueryClientProvider client={queryClient}>
        <LoadPresetEditor />
      </QueryClientProvider>,
    );

    expect(await screen.findByText("Test Load (Default)")).toBeDefined();

    const preserveCheckbox = screen.getByLabelText(/Preserve Thinking/i) as HTMLInputElement;
    expect(preserveCheckbox.disabled).toBe(true);
    expect(screen.getByText(/does not support preserve_thinking/i)).toBeDefined();
  });

  it("LoadPresetEditor: preserve thinking is enabled from the GGUF template without loading a model", async () => {
    useAppStore.setState({
      models: [
        {
          primaryPath: "/models/test.gguf",
          metadata: {
            name: "test-model",
            chatTemplate: "{%- set preserve_thinking = preserve_thinking | default(false) -%}",
          } as any,
          mmprojPath: undefined,
          mtime: Date.now(),
        },
      ],
      loadedModel: undefined,
      loadedConfig: undefined,
    });
    useUiStore.setState({ activePresetId: "test-load-id" });

    render(
      <QueryClientProvider client={queryClient}>
        <LoadPresetEditor />
      </QueryClientProvider>,
    );

    expect(await screen.findByText("Test Load (Default)")).toBeDefined();

    const preserveCheckbox = screen.getByLabelText(/Preserve Thinking/i) as HTMLInputElement;
    expect(preserveCheckbox.disabled).toBe(false);
    expect(screen.getByText(/Applies on the next generation/i)).toBeDefined();
  });

  it("LoadPresetEditor: preserve thinking can be toggled from a pasted jinja override before load", async () => {
    queryClient.setQueryData(queryKeys.presetsLoad(), [
      {
        ...mockLoadPreset,
        chatTemplateOverride:
          "{%- set preserve_thinking = preserve_thinking | default(false) -%}{{ bos_token }}",
      },
    ]);
    useAppStore.setState({
      loadedModel: undefined,
      loadedConfig: undefined,
    });
    useUiStore.setState({ activePresetId: "test-load-id" });

    render(
      <QueryClientProvider client={queryClient}>
        <LoadPresetEditor />
      </QueryClientProvider>,
    );

    expect(await screen.findByText("Test Load (Default)")).toBeDefined();
    const preserveCheckbox = screen.getByLabelText(/Preserve Thinking/i) as HTMLInputElement;
    expect(preserveCheckbox.disabled).toBe(false);
    expect(preserveCheckbox.checked).toBe(false);

    fireEvent.click(preserveCheckbox);
    expect(preserveCheckbox.checked).toBe(true);

    fireEvent.click(preserveCheckbox);
    expect(preserveCheckbox.checked).toBe(false);
  });
});
