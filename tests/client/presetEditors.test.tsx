/**
 * @packageDocumentation
 * Tests for preset editor components and their form interactions.
 */

import { EditorView } from "@codemirror/view";
import { afterEach, beforeAll, beforeEach, describe, expect, it, spyOn } from "bun:test";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { queryKeys } from "../../src/client/queries";
import { useAppStore } from "../../src/client/store";
import { useUiStore } from "../../src/client/uiStore";
import { asFetch, ggufDisplayMetadata } from "../fixtures";

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
          publisher: "test",
          modelName: "test-model",
          primaryPath: "/models/test.gguf",
          metadata: { name: "test-model", chatTemplate: "test-template" } as any,
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
          publisher: "test",
          modelName: "test-model",
          primaryPath: "/models/test.gguf",
          metadata: {
            name: "test-model",
            chatTemplate: "{%- set preserve_thinking = preserve_thinking | default(false) -%}",
          } as any,
        },
      ],
      loadedModel: null,
      loadedConfig: null,
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
      loadedModel: null,
      loadedConfig: null,
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

  it("LoadPresetEditor: Reset Default then Save clears the template and stays clean", async () => {
    const saved = {
      ...mockLoadPreset,
      chatTemplateOverride: "custom jinja",
    };
    queryClient.setQueryData(queryKeys.presetsLoad(), [saved]);
    useUiStore.setState({ activePresetId: "test-load-id" });
    const cleared = { ...mockLoadPreset, preserveThinking: false };
    let putBody: { chatTemplateOverride?: string | null } | undefined;
    const originalFetch = globalThis.fetch;
    globalThis.fetch = asFetch(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      if (url.includes("/api/presets/load/") && init?.method === "PUT") {
        putBody = JSON.parse(String(init.body)) as { chatTemplateOverride?: string | null };
        return new Response(JSON.stringify({ success: true }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      if (url.includes("/api/presets/load")) {
        return new Response(JSON.stringify([cleared]), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      return new Response("[]", { status: 200, headers: { "Content-Type": "application/json" } });
    });
    const confirmSpy = spyOn(window, "confirm").mockReturnValue(false);

    try {
      render(
        <QueryClientProvider client={queryClient}>
          <LoadPresetEditor />
        </QueryClientProvider>,
      );
      expect(await screen.findByText("Test Load (Default)")).toBeDefined();
      fireEvent.click(screen.getByText("Reset Default"));
      fireEvent.click(screen.getByRole("button", { name: /Save Changes/i }));
      expect(await screen.findByText("Saved.")).toBeDefined();
      await waitFor(() => {
        expect(putBody?.chatTemplateOverride).toBeNull();
      });
      const deleteButton = screen.getByTitle("Delete");
      const closeButton = deleteButton.nextElementSibling;
      expect(closeButton).toBeInstanceOf(HTMLButtonElement);
      fireEvent.click(closeButton as HTMLButtonElement);
      expect(confirmSpy).not.toHaveBeenCalled();
    } finally {
      confirmSpy.mockRestore();
      globalThis.fetch = originalFetch;
    }
  });

  it("LoadPresetEditor: shows the server validation message when a save is rejected", async () => {
    useUiStore.setState({ activePresetId: "test-load-id" });
    const originalFetch = globalThis.fetch;
    globalThis.fetch = asFetch(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      if (url.includes("/api/presets/load/") && init?.method === "PUT") {
        return new Response(JSON.stringify({ error: "contextSize must be >= 1" }), {
          status: 400,
          headers: { "Content-Type": "application/json" },
        });
      }
      return new Response("[]", { status: 200, headers: { "Content-Type": "application/json" } });
    });

    try {
      render(
        <QueryClientProvider client={queryClient}>
          <LoadPresetEditor />
        </QueryClientProvider>,
      );
      expect(await screen.findByText("Test Load (Default)")).toBeDefined();
      fireEvent.click(screen.getByRole("button", { name: /Save Changes/i }));
      expect(await screen.findByText("contextSize must be >= 1")).toBeDefined();
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("LoadPresetEditor: enables MTP for a gemma4-assistant companion without listing the draft GGUF", async () => {
    useAppStore.setState({
      models: [
        {
          publisher: "FadedRedStar",
          modelName: "gemma-4-12B-it-qat-q4_0-heretic-GGUF",
          primaryPath: "/models/test.gguf",
          draftModelPath: "/models/gemma-4-12b-qat-it-assistant-Q4_0_Q4emb.gguf",
          draftSpecType: "draft-mtp",
          metadata: ggufDisplayMetadata({ name: "test-model", architecture: "gemma4" }),
        },
      ],
    });
    useUiStore.setState({ activePresetId: "test-load-id" });

    render(
      <QueryClientProvider client={queryClient}>
        <LoadPresetEditor />
      </QueryClientProvider>,
    );

    expect(await screen.findByText("Test Load (Default)")).toBeDefined();
    fireEvent.click(screen.getByRole("button", { name: "Speculative Decoding" }));

    const specType = screen.getByLabelText(/^Mode$/) as HTMLSelectElement;
    const mtpOption = screen.getByRole("option", {
      name: /MTP \(assistant companion found\)/,
    }) as HTMLOptionElement;
    expect(mtpOption.disabled).toBe(false);
    expect(screen.getByLabelText(/Draft Model Path/i)).toBeDefined();
    expect(screen.getByText(/Auto-detected MTP assistant/i)).toBeDefined();
    expect(screen.getByText(/gemma-4-12b-qat-it-assistant-Q4_0_Q4emb\.gguf/i)).toBeDefined();

    fireEvent.change(specType, { target: { value: "draft-mtp" } });
    expect(specType.value).toBe("draft-mtp");
    expect((screen.getByLabelText(/Draft Model Path/i) as HTMLInputElement).value).toBe(
      "/models/gemma-4-12b-qat-it-assistant-Q4_0_Q4emb.gguf",
    );

    fireEvent.change(specType, { target: { value: "draft-simple" } });
    expect(specType.value).toBe("draft-simple");
    expect(
      screen.getByText(
        /The auto-detected companion is a Gemma MTP assistant and must be loaded with MTP, not Draft Model/i,
      ),
    ).toBeDefined();
  });

  it("LoadPresetEditor: enables DFlash, DSpark, and Eagle3 for matching scanned companions", async () => {
    const cases = [
      {
        specType: "draft-dflash" as const,
        label: "DFlash",
        draftPath: "/models/model-dflash.gguf",
        optionName: /DFlash \(companion found\)/,
        warning:
          /The auto-detected companion is a DFlash and must be loaded with DFlash, not Draft Model/i,
        autoDetected: /Auto-detected DFlash companion/i,
      },
      {
        specType: "draft-dspark" as const,
        label: "DSpark",
        draftPath: "/models/model-dspark.gguf",
        optionName: /DSpark \(companion found\)/,
        warning:
          /The auto-detected companion is a DSpark and must be loaded with DSpark, not Draft Model/i,
        autoDetected: /Auto-detected DSpark companion/i,
      },
      {
        specType: "draft-eagle3" as const,
        label: "Eagle3",
        draftPath: "/models/model-eagle3.gguf",
        optionName: /Eagle3 \(companion found\)/,
        warning:
          /The auto-detected companion is an Eagle3 and must be loaded with Eagle3, not Draft Model/i,
        autoDetected: /Auto-detected Eagle3 companion/i,
      },
    ];

    for (const testCase of cases) {
      cleanup();
      queryClient.setQueryData(queryKeys.presetsLoad(), [mockLoadPreset]);
      useAppStore.setState({
        models: [
          {
            publisher: "test",
            modelName: "test-model",
            primaryPath: "/models/test.gguf",
            draftModelPath: testCase.draftPath,
            draftSpecType: testCase.specType,
            metadata: ggufDisplayMetadata({ name: "test-model", architecture: "llama" }),
          },
        ],
      });
      useUiStore.setState({ activePresetId: "test-load-id" });

      render(
        <QueryClientProvider client={queryClient}>
          <LoadPresetEditor />
        </QueryClientProvider>,
      );

      expect(await screen.findByText("Test Load (Default)")).toBeDefined();
      fireEvent.click(screen.getByRole("button", { name: "Speculative Decoding" }));

      const specType = screen.getByLabelText(/^Mode$/) as HTMLSelectElement;
      const specializedOption = screen.getByRole("option", {
        name: testCase.optionName,
      }) as HTMLOptionElement;
      expect(specializedOption.disabled).toBe(false);
      expect(screen.getByText(testCase.autoDetected)).toBeDefined();
      for (const other of cases) {
        if (other.specType === testCase.specType) continue;
        expect(
          (
            screen.getByRole("option", {
              name: new RegExp(`${other.label} \\(no ${other.label} model found\\)`),
            }) as HTMLOptionElement
          ).disabled,
        ).toBe(true);
      }

      fireEvent.change(specType, { target: { value: testCase.specType } });
      expect(specType.value).toBe(testCase.specType);
      expect((screen.getByLabelText(/Draft Model Path/i) as HTMLInputElement).value).toBe(
        testCase.draftPath,
      );

      fireEvent.change(specType, { target: { value: "draft-simple" } });
      expect(specType.value).toBe("draft-simple");
      expect(screen.getByText(testCase.warning)).toBeDefined();
    }
  });

  it("LoadPresetEditor: lets the user select Draft Model and set a path without a scanned companion", async () => {
    useUiStore.setState({ activePresetId: "test-load-id" });

    render(
      <QueryClientProvider client={queryClient}>
        <LoadPresetEditor />
      </QueryClientProvider>,
    );

    expect(await screen.findByText("Test Load (Default)")).toBeDefined();
    fireEvent.click(screen.getByRole("button", { name: "Speculative Decoding" }));

    const specType = screen.getByLabelText(/^Mode$/) as HTMLSelectElement;
    const draftOption = screen.getByRole("option", {
      name: /Draft Model \(set path below\)/,
    }) as HTMLOptionElement;
    expect(draftOption.disabled).toBe(false);

    fireEvent.change(specType, { target: { value: "draft-simple" } });
    expect(specType.value).toBe("draft-simple");

    const pathInput = screen.getByLabelText(/Draft Model Path/i) as HTMLInputElement;
    fireEvent.change(pathInput, { target: { value: "/models/custom-assistant.gguf" } });
    expect(pathInput.value).toBe("/models/custom-assistant.gguf");
    expect(specType.value).toBe("draft-simple");

    expect(
      (screen.getByRole("option", { name: /MTP \(no MTP model found\)/ }) as HTMLOptionElement)
        .disabled,
    ).toBe(true);
    expect(
      (
        screen.getByRole("option", {
          name: /DFlash \(no DFlash model found\)/,
        }) as HTMLOptionElement
      ).disabled,
    ).toBe(true);
    expect(
      (
        screen.getByRole("option", {
          name: /DSpark \(no DSpark model found\)/,
        }) as HTMLOptionElement
      ).disabled,
    ).toBe(true);
    expect(
      (
        screen.getByRole("option", {
          name: /Eagle3 \(no Eagle3 model found\)/,
        }) as HTMLOptionElement
      ).disabled,
    ).toBe(true);
  });

  it("InferencePresetEditor: copies settings from another model and keeps this preset's name", async () => {
    queryClient.setQueryData(queryKeys.presetsInference(), [
      { ...mockInferencePreset, sourceModelPath: "/models/finetune-b.gguf" },
      {
        ...mockInferencePreset,
        id: "other-inf",
        name: "FineTune A",
        sourceModelPath: "/models/finetune-a.gguf",
        isDefault: false,
        temperature: 0.15,
        topK: 12,
      },
    ]);
    useAppStore.setState({
      loadedModel: {
        publisher: "test",
        modelName: "FineTune B",
        primaryPath: "/models/finetune-b.gguf",
      },
      serverStatus: "idle",
    });
    useUiStore.setState({ activePresetId: "test-inf-id" });

    render(
      <QueryClientProvider client={queryClient}>
        <InferencePresetEditor />
      </QueryClientProvider>,
    );

    const switcher = (await screen.findByRole("combobox", {
      name: "Inference preset",
    })) as HTMLSelectElement;
    const switcherNames = [...switcher.options].map((option) => option.textContent ?? "");
    expect(switcherNames.some((name) => name.includes("Test Inference"))).toBe(true);
    expect(switcherNames.some((name) => name.includes("FineTune A"))).toBe(false);

    const copyFrom = screen.getByLabelText("Copy from") as HTMLSelectElement;
    expect([...copyFrom.options].some((option) => option.textContent?.includes("FineTune A"))).toBe(
      true,
    );

    fireEvent.change(copyFrom, { target: { value: "other-inf" } });
    expect((screen.getByLabelText(/Temperature/i) as HTMLInputElement).value).toBe("0.15");
    expect((screen.getByLabelText("Preset Name") as HTMLInputElement).value).toBe("Test Inference");
  });

  it("LoadPresetEditor: copies settings from another model and keeps this preset's paths", async () => {
    queryClient.setQueryData(queryKeys.presetsLoad(), [
      mockLoadPreset,
      {
        ...mockLoadPreset,
        id: "other-load",
        name: "FineTune A Load",
        modelPath: "/models/finetune-a.gguf",
        isDefault: false,
        config: {
          ...mockLoadPreset.config,
          modelPath: "/models/finetune-a.gguf",
          mmProjPath: "/models/finetune-a.mmproj",
          specDraftModelPath: "/models/finetune-a-draft.gguf",
          gpuLayers: 40,
        },
      },
    ]);
    useAppStore.setState({
      loadedModel: {
        publisher: "test",
        modelName: "test-model",
        primaryPath: "/models/test.gguf",
      },
      serverStatus: "idle",
    });
    useUiStore.setState({ activePresetId: "test-load-id" });

    render(
      <QueryClientProvider client={queryClient}>
        <LoadPresetEditor />
      </QueryClientProvider>,
    );

    const switcher = (await screen.findByRole("combobox", {
      name: "Load preset",
    })) as HTMLSelectElement;
    const switcherNames = [...switcher.options].map((option) => option.textContent ?? "");
    expect(switcherNames.some((name) => name.includes("Test Load"))).toBe(true);
    expect(switcherNames.some((name) => name.includes("FineTune A Load"))).toBe(false);

    const copyFrom = screen.getByLabelText("Copy from") as HTMLSelectElement;
    fireEvent.change(copyFrom, { target: { value: "other-load" } });

    expect((screen.getByLabelText(/GPU Layers/i) as HTMLInputElement).value).toBe("40");
    expect((screen.getByLabelText(/Primary Model Path/i) as HTMLInputElement).value).toBe(
      "/models/test.gguf",
    );
    expect((screen.getByLabelText(/MMProj Path/i) as HTMLInputElement).value).toBe("");
    expect((screen.getByLabelText("Preset Name") as HTMLInputElement).value).toBe("Test Load");
  });

  it("LoadPresetEditor: keeps MTP until models are loaded and the companion is missing", async () => {
    queryClient.setQueryData(queryKeys.presetsLoad(), [
      {
        ...mockLoadPreset,
        config: { ...mockLoadPreset.config, specType: "draft-mtp" },
      },
    ]);
    useAppStore.setState({ models: [], loadedModel: null, loadedConfig: null });
    useUiStore.setState({ activePresetId: "test-load-id" });

    render(
      <QueryClientProvider client={queryClient}>
        <LoadPresetEditor />
      </QueryClientProvider>,
    );
    fireEvent.click(await screen.findByRole("button", { name: "Speculative Decoding" }));
    const mode = (await screen.findByLabelText("Mode")) as HTMLSelectElement;
    expect(mode.value).toBe("draft-mtp");

    act(() => {
      useAppStore.setState({
        models: [
          {
            publisher: "test",
            modelName: "test-model",
            primaryPath: "/models/test.gguf",
            metadata: { name: "test-model" } as any,
          },
        ],
      });
    });
    await waitFor(() => {
      expect((screen.getByLabelText("Mode") as HTMLSelectElement).value).toBe("off");
    });
  });

  it("InferencePresetEditor: blocks save on invalid schema and restores a cleared number", async () => {
    useUiStore.setState({ activePresetId: "test-inf-id" });
    render(
      <QueryClientProvider client={queryClient}>
        <InferencePresetEditor />
      </QueryClientProvider>,
    );
    expect(await screen.findByText("Test Inference (Default)")).toBeDefined();

    const base = screen.getByLabelText("Base") as HTMLInputElement;
    expect(base.value).toBe("1.75");
    fireEvent.change(base, { target: { value: "" } });
    fireEvent.blur(base);
    expect(base.value).toBe("1.75");

    fireEvent.click(screen.getByLabelText("Structured Output"));
    const editorRoot = document.querySelector(".cm-editor");
    if (!(editorRoot instanceof HTMLElement)) {
      throw new Error("expected the schema editor");
    }
    const view = EditorView.findFromDOM(editorRoot);
    if (!view) throw new Error("expected a CodeMirror view");
    act(() => {
      view.dispatch({
        changes: { from: 0, to: view.state.doc.length, insert: "{" },
      });
    });
    const fieldset = editorRoot.closest("fieldset");
    if (!fieldset) throw new Error("expected the schema fieldset");
    fireEvent.blur(fieldset);
    fireEvent.click(screen.getByRole("button", { name: /Save Changes/i }));
    expect(await screen.findByText("Fix the JSON schema before saving.")).toBeDefined();
  });

  it("SystemPresetEditor: applying an empty name shows the same message as Save", async () => {
    useAppStore.setState({ currentChatId: "chat-1" });
    useUiStore.setState({ activePresetId: "test-sys-id" });
    render(
      <QueryClientProvider client={queryClient}>
        <SystemPresetEditor />
      </QueryClientProvider>,
    );
    const name = (await screen.findByLabelText("Preset Name")) as HTMLInputElement;
    fireEvent.change(name, { target: { value: "   " } });
    fireEvent.click(screen.getByRole("button", { name: /Use in Active Chat/i }));
    expect(await screen.findByText("Preset name cannot be empty.")).toBeDefined();
    fireEvent.click(screen.getByRole("button", { name: /Save Changes/i }));
    expect(screen.getByText("Preset name cannot be empty.")).toBeDefined();
  });
});
