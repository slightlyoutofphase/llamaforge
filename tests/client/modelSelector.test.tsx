/**
 * @packageDocumentation
 * Tests for the model selector and saved preset navigation.
 */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, mock } from "bun:test";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { createDefaultLoadConfig } from "../../src/shared/defaults";
import { useAppStore } from "../../src/client/store";
import { ModelSelector } from "../../src/client/ModelSelector";
import { ModelLibraryPanel } from "../../src/client/components/sidebar/ModelLibraryPanel";
import { ModelLoadOverlay } from "../../src/client/components/ModelLoadOverlay";
import { asFetch, ggufDisplayMetadata } from "../fixtures";

mock.module("@tanstack/react-router", () => ({
  useNavigate: () => mock(),
}));

const defaultState = {
  models: [],
  loadModel: async () => true,
  unloadModel: async () => {},
  serverStatus: "idle" as const,
  loadedModel: null,
  messages: [],
  isGenerating: false,
  loadProgress: 0,
  loadProgressPhase: null,
  loadProgressDetail: null,
};

let originalFetch: typeof global.fetch;
let queryClient: QueryClient;

describe("ModelSelector Component", () => {
  beforeAll(() => {
    originalFetch = global.fetch;
  });

  afterAll(() => {
    mock.restore();
    global.fetch = originalFetch;
  });

  beforeEach(() => {
    cleanup();
    queryClient = new QueryClient({
      defaultOptions: {
        queries: { retry: false },
        mutations: { retry: false },
      },
    });
    useAppStore.setState(defaultState);
    global.fetch = asFetch(
      mock((input) => {
        const url = typeof input === "string" ? input : input.toString();
        if (url.includes("/api/presets/load")) {
          return Promise.resolve(
            new Response(
              JSON.stringify([
                {
                  id: "preset-1",
                  name: "Balanced Default (Default)",
                  modelPath: "D:/Programs/test/embe.gguf",
                  isDefault: true,
                  isReadonly: false,
                  config: {
                    modelPath: "D:/Programs/test/embe.gguf",
                    contextSize: 4096,
                    contextShift: false,
                    gpuLayers: 33,
                    threads: 4,
                    batchSize: 512,
                    microBatchSize: 128,
                    ropeScaling: "none",
                    ropeFreqBase: 10000,
                    ropeFreqScale: 1.0,
                    kvCacheTypeK: "f16",
                    kvCacheTypeV: "f16",
                    mlock: false,
                    noMmap: false,
                    flashAttn: "off",
                  },
                  createdAt: Date.now(),
                  updatedAt: Date.now(),
                },
              ]),
              { headers: { "Content-Type": "application/json" } },
            ),
          );
        }
        if (url.includes("/api/chats")) {
          return Promise.resolve(
            new Response(JSON.stringify({ id: "new-chat", name: "New Chat" }), {
              status: 200,
              headers: { "Content-Type": "application/json" },
            }),
          );
        }
        return Promise.resolve(new Response(JSON.stringify([])));
      }),
    );
  });

  afterEach(() => {
    queryClient.clear();
    cleanup();
    useAppStore.setState(defaultState);
  });

  it("renders model metadata without unknown placeholders when metadata is available", async () => {
    useAppStore.setState({
      models: [
        {
          publisher: "unsloth",
          modelName: "embe...",
          primaryPath: "D:/Programs/test/embe.gguf",
          mmProjPath: "D:/Programs/test/embe.mmproj",
          metadata: {
            architecture: "gemma4",
            name: "embe...",
            fileSizeBytes: 123456789,
            contextLength: 4096,
            embeddingLength: 0,
            attentionHeadCount: 16,
            attentionHeadCountKv: 16,
            blockCount: 32,
            feedForwardLength: 0,
            quantType: "q4_0",
            hasVisionEncoder: true,
            hasAudioEncoder: false,
            hasToolCalling: true,
            isDraftModel: false,
            defaultTemperature: 0.8,
            defaultTopK: 40,
            defaultTopP: 0.95,
            defaultMinP: 0.05,
            defaultRepeatPenalty: 1.1,
            chatTemplate: undefined,
          },
        },
      ],
      loadModel: async () => true,
      unloadModel: async () => {},
      serverStatus: "idle" as const,
      loadedModel: null,
      messages: [],
      isGenerating: false,
    });

    await act(async () => {
      render(
        <QueryClientProvider client={queryClient}>
          <ModelSelector />
        </QueryClientProvider>,
      );
    });

    expect(await screen.findByText("unsloth")).toBeTruthy();
    expect(screen.getByText("gemma4")).toBeTruthy();
    expect(screen.getByText("0.11 GB")).toBeTruthy();
    expect(screen.getByText("VISION ENABLED")).toBeTruthy();
    expect(screen.getByText("TOOLS ENABLED")).toBeTruthy();
    expect(screen.queryByText("Unknown Architecture")).toBeNull();
    expect(screen.queryByText("Unknown Size")).toBeNull();
  });

  it("passes thinking overrides and suppresses redundant template overrides on load", async () => {
    const loadModelSpy = mock().mockResolvedValue(true);
    useAppStore.setState({
      models: [
        {
          publisher: "unsloth",
          modelName: "embe...",
          primaryPath: "D:/Programs/test/embe.gguf",
          mmProjPath: undefined,
          metadata: {
            architecture: "gemma4",
            name: "embe...",
            fileSizeBytes: 123456789,
            contextLength: 4096,
            embeddingLength: 0,
            attentionHeadCount: 16,
            attentionHeadCountKv: 16,
            blockCount: 32,
            feedForwardLength: 0,
            quantType: "q4_0",
            hasVisionEncoder: false,
            hasAudioEncoder: false,
            hasToolCalling: false,
            isDraftModel: false,
            defaultTemperature: 0.8,
            defaultTopK: 40,
            defaultTopP: 0.95,
            defaultMinP: 0.05,
            defaultRepeatPenalty: 1.1,
            chatTemplate: "same-template",
          },
        },
      ],
      loadModel: loadModelSpy,
      unloadModel: async () => {},
      serverStatus: "idle" as const,
      loadedModel: null,
      messages: [],
      isGenerating: false,
      loadProgress: 0,
      loadProgressPhase: null,
      loadProgressDetail: null,
    } as any);

    global.fetch = asFetch(
      mock((input) => {
        const url = typeof input === "string" ? input : input.toString();
        if (url.includes("/api/presets/load")) {
          return Promise.resolve(
            new Response(
              JSON.stringify([
                {
                  id: "preset-1",
                  name: "Balanced Default (Default)",
                  modelPath: "D:/Programs/test/embe.gguf",
                  isDefault: true,
                  isReadonly: true,
                  chatTemplateOverride: "same-template",
                  thinkingTagOverride: {
                    openTag: "<|channel>thought\n",
                    closeTag: "<channel|>",
                    enableToken: "<|think|>",
                  },
                  config: {
                    modelPath: "D:/Programs/test/embe.gguf",
                    contextSize: 4096,
                    contextShift: false,
                    gpuLayers: 33,
                    threads: 4,
                    batchSize: 512,
                    microBatchSize: 128,
                    ropeScaling: "none",
                    ropeFreqBase: 10000,
                    ropeFreqScale: 1.0,
                    kvCacheTypeK: "f16",
                    kvCacheTypeV: "f16",
                    mlock: false,
                    noMmap: false,
                    contBatching: true,
                    flashAttn: "auto",
                    swaFull: false,
                    kvUnified: true,
                    noKvOffload: false,
                    cacheReuse: 0,
                  },
                  createdAt: Date.now(),
                  updatedAt: Date.now(),
                },
              ]),
              { headers: { "Content-Type": "application/json" } },
            ),
          );
        }
        if (url.includes("/api/chats")) {
          return Promise.resolve(
            new Response(JSON.stringify({ id: "new-chat", name: "New Chat" }), {
              status: 200,
              headers: { "Content-Type": "application/json" },
            }),
          );
        }
        return Promise.resolve(new Response(JSON.stringify([])));
      }),
    );

    await act(async () => {
      render(
        <QueryClientProvider client={queryClient}>
          <ModelSelector />
        </QueryClientProvider>,
      );
    });

    const loadButton = await screen.findByRole("button", { name: /load/i });
    await act(async () => {
      fireEvent.click(loadButton);
    });

    expect(loadModelSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        presetId: "preset-1",
        thinkingTagOverride: {
          openTag: "<|channel>thought\n",
          closeTag: "<channel|>",
          enableToken: "<|think|>",
        },
      }),
    );
    expect(loadModelSpy.mock.calls[0]?.[0]?.chatTemplateContent).toBeUndefined();
  });

  it("shows load progress instead of the static splash while a model is loading", async () => {
    useAppStore.setState({
      models: [],
      loadModel: async () => true,
      unloadModel: async () => {},
      serverStatus: "loading" as const,
      loadedModel: null,
      messages: [],
      isGenerating: false,
      loadProgress: 42,
      loadProgressPhase: "loading_weights",
      loadProgressDetail: "Loading tensor blocks",
    } as any);

    await act(async () => {
      render(
        <QueryClientProvider client={queryClient}>
          <ModelLoadOverlay />
          <ModelSelector />
        </QueryClientProvider>,
      );
    });

    expect(screen.queryByText("Initializing Weights")).toBeNull();
    expect(await screen.findByText("Loading model")).toBeTruthy();
    expect(screen.getByText("42%")).toBeTruthy();
    expect(screen.getByText("Loading tensor blocks")).toBeTruthy();
  });

  it("hides draft models from the selectable library", async () => {
    useAppStore.setState({
      models: [
        {
          publisher: "unsloth",
          modelName: "Primary Chat Model",
          primaryPath: "D:/Programs/test/primary.gguf",
          metadata: ggufDisplayMetadata({
            architecture: "gemma4",
            name: "Primary Chat Model",
            isDraftModel: false,
          }),
        },
        {
          publisher: "unsloth",
          modelName: "Draft Speculator",
          primaryPath: "D:/Programs/test/primary-draft.gguf",
          metadata: ggufDisplayMetadata({
            architecture: "gemma4",
            name: "Draft Speculator",
            isDraftModel: true,
          }),
        },
      ],
      loadModel: async () => true,
      unloadModel: async () => {},
      serverStatus: "idle" as const,
      loadedModel: null,
      messages: [],
      isGenerating: false,
    });

    await act(async () => {
      render(
        <QueryClientProvider client={queryClient}>
          <ModelSelector />
        </QueryClientProvider>,
      );
    });

    expect(await screen.findByText("Primary Chat Model")).toBeTruthy();
    expect(screen.queryByText("Draft Speculator")).toBeNull();
  });

  it("lists only load presets for that model, matching paths with different slashes", async () => {
    useAppStore.setState({
      models: [
        {
          publisher: "unsloth",
          modelName: "embe...",
          primaryPath: "D:/Programs/test/embe.gguf",
          metadata: ggufDisplayMetadata({ name: "embe..." }),
        },
      ],
      loadModel: async () => true,
      unloadModel: async () => {},
      serverStatus: "idle" as const,
      loadedModel: null,
      messages: [],
      isGenerating: false,
    });
    global.fetch = asFetch(
      mock((input) => {
        const url = typeof input === "string" ? input : input.toString();
        if (url.includes("/api/presets/load")) {
          return Promise.resolve(
            new Response(
              JSON.stringify([
                {
                  id: "slash",
                  name: "Slash Variant",
                  modelPath: "D:\\Programs\\test\\embe.gguf",
                  isDefault: false,
                  isReadonly: false,
                  config: { modelPath: "D:\\Programs\\test\\embe.gguf" },
                  createdAt: 1,
                  updatedAt: 1,
                },
                {
                  id: "foreign",
                  name: "Foreign Load Preset",
                  modelPath: "D:/Programs/test/other.gguf",
                  isDefault: false,
                  isReadonly: false,
                  config: { modelPath: "D:/Programs/test/other.gguf" },
                  createdAt: 1,
                  updatedAt: 1,
                },
                {
                  id: "global",
                  name: "Global Load",
                  modelPath: "",
                  isDefault: true,
                  isReadonly: true,
                  config: { modelPath: "" },
                  createdAt: 1,
                  updatedAt: 1,
                },
              ]),
              { headers: { "Content-Type": "application/json" } },
            ),
          );
        }
        return Promise.resolve(new Response(JSON.stringify([])));
      }),
    );

    await act(async () => {
      render(
        <QueryClientProvider client={queryClient}>
          <ModelSelector />
        </QueryClientProvider>,
      );
    });

    const select = (await screen.findByRole("combobox", {
      name: "Load preset for embe...",
    })) as HTMLSelectElement;
    const names = [...select.options].map((option) => option.textContent ?? "");
    expect(names.some((name) => name.includes("Slash Variant"))).toBe(true);
    expect(names.some((name) => name.includes("Global Load"))).toBe(true);
    expect(names.some((name) => name.includes("Foreign Load Preset"))).toBe(false);
    expect(select.value).toBe("slash");
  });

  it("shows each quant as its own model and only that quant's preset", async () => {
    const q4 = "D:/Models/Aura/Aura-Q4_K_S.gguf";
    const q8 = "D:/Models/Aura/Aura-Q8_0.gguf";
    useAppStore.setState({
      models: [
        {
          publisher: "publisher",
          modelName: "Aura",
          primaryPath: q4,
          metadata: ggufDisplayMetadata({ name: "Aura" }),
        },
        {
          publisher: "publisher",
          modelName: "Aura",
          primaryPath: q8,
          metadata: ggufDisplayMetadata({ name: "Aura" }),
        },
      ],
      loadModel: async () => true,
      unloadModel: async () => {},
      serverStatus: "idle" as const,
      loadedModel: null,
      messages: [],
      isGenerating: false,
    });
    global.fetch = asFetch(
      mock((input) => {
        const url = typeof input === "string" ? input : input.toString();
        if (url.includes("/api/presets/load")) {
          return Promise.resolve(
            new Response(
              JSON.stringify([
                {
                  id: "balanced",
                  name: "Balanced Default",
                  modelPath: "",
                  isDefault: true,
                  isReadonly: true,
                  config: { modelPath: "" },
                  createdAt: 1,
                  updatedAt: 1,
                },
                {
                  id: "q4",
                  name: "Aura-Q4_K_S",
                  modelPath: q4,
                  isDefault: false,
                  isReadonly: false,
                  config: { modelPath: q4 },
                  createdAt: 2,
                  updatedAt: 2,
                },
                {
                  id: "q8",
                  name: "Aura-Q8_0",
                  modelPath: q8,
                  isDefault: false,
                  isReadonly: false,
                  config: { modelPath: q8 },
                  createdAt: 3,
                  updatedAt: 3,
                },
              ]),
              { headers: { "Content-Type": "application/json" } },
            ),
          );
        }
        return Promise.resolve(new Response(JSON.stringify([])));
      }),
    );

    await act(async () => {
      render(
        <QueryClientProvider client={queryClient}>
          <ModelSelector />
        </QueryClientProvider>,
      );
    });

    const headings = (await screen.findAllByRole("heading", { level: 3 })).map(
      (heading) => heading.textContent,
    );
    expect(headings).toEqual(["Aura-Q4_K_S", "Aura-Q8_0"]);

    const q4Select = screen.getByRole("combobox", {
      name: "Load preset for Aura-Q4_K_S",
    }) as HTMLSelectElement;
    const q8Select = screen.getByRole("combobox", {
      name: "Load preset for Aura-Q8_0",
    }) as HTMLSelectElement;
    const q4Names = [...q4Select.options].map((option) => option.textContent);
    const q8Names = [...q8Select.options].map((option) => option.textContent);
    expect(q4Names).toEqual(["Balanced Default", "Aura-Q4_K_S"]);
    expect(q8Names).toEqual(["Balanced Default", "Aura-Q8_0"]);
    expect(q4Names.join(" ").match(/\bdefault\b/gi)).toEqual(["Default"]);
  });

  it("keeps LOAD unavailable until load presets resolve", async () => {
    global.fetch = asFetch(mock(() => new Promise(() => undefined)));
    useAppStore.setState({
      models: [
        {
          publisher: "lab",
          modelName: "Shared Model",
          primaryPath: "D:/models/shared.gguf",
          metadata: ggufDisplayMetadata({ name: "Shared Model" }),
        },
      ],
      loadModel: async () => true,
      unloadModel: async () => {},
      serverStatus: "idle",
      loadedModel: null,
      messages: [],
      isGenerating: false,
    });

    await act(async () => {
      render(
        <QueryClientProvider client={queryClient}>
          <ModelSelector />
        </QueryClientProvider>,
      );
    });
    expect(await screen.findByText("Loading presets…")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "LOAD" })).toBeNull();

    cleanup();
    await act(async () => {
      render(
        <QueryClientProvider client={queryClient}>
          <ModelLibraryPanel />
        </QueryClientProvider>,
      );
    });
    fireEvent.click(screen.getByRole("button", { name: /Shared Model/ }));
    expect(await screen.findByText("Loading presets…")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Shared Load" })).toBeNull();
  });

  it("sends the same load request from the registry and the model library", async () => {
    const modelPath = "D:/models/shared.gguf";
    const preset = {
      id: "shared-preset",
      name: "Shared Load",
      modelPath,
      isDefault: false,
      isReadonly: false,
      chatTemplateOverride: "custom-template",
      thinkingTagOverride: {
        openTag: "<think>",
        closeTag: "</think>",
        enableToken: "<think>",
      },
      config: {
        ...createDefaultLoadConfig("D:/models/other.gguf"),
        specType: "draft-simple" as const,
        specDraftModelPath: "D:/models/configured-draft.gguf",
        contextSize: 2048,
      },
      createdAt: 1,
      updatedAt: 1,
    };
    const model = {
      publisher: "lab",
      modelName: "Shared Model",
      primaryPath: modelPath,
      draftModelPath: "D:/models/detected-draft.gguf",
      draftSpecType: "draft-mtp" as const,
      metadata: ggufDisplayMetadata({
        name: "Shared Model",
        chatTemplate: "default-template",
      }),
    };
    global.fetch = asFetch(
      mock((input) => {
        const url = typeof input === "string" ? input : input.toString();
        if (url.includes("/api/presets/load")) {
          return Promise.resolve(
            new Response(JSON.stringify([preset]), {
              headers: { "Content-Type": "application/json" },
            }),
          );
        }
        return Promise.resolve(new Response(JSON.stringify([])));
      }),
    );

    const selectorLoad = mock().mockResolvedValue(true);
    useAppStore.setState({
      models: [model],
      loadModel: selectorLoad,
      unloadModel: async () => {},
      serverStatus: "idle",
      loadedModel: null,
      messages: [],
      isGenerating: false,
    });
    await act(async () => {
      render(
        <QueryClientProvider client={queryClient}>
          <ModelSelector />
        </QueryClientProvider>,
      );
    });
    await act(async () => {
      fireEvent.click(await screen.findByRole("button", { name: "LOAD" }));
    });

    cleanup();
    const libraryLoad = mock().mockResolvedValue(true);
    useAppStore.setState({ loadModel: libraryLoad });
    await act(async () => {
      render(
        <QueryClientProvider client={queryClient}>
          <ModelLibraryPanel />
        </QueryClientProvider>,
      );
    });
    fireEvent.click(await screen.findByRole("button", { name: /Shared Model/ }));
    await act(async () => {
      fireEvent.click(await screen.findByRole("button", { name: "Shared Load" }));
    });

    expect(selectorLoad).toHaveBeenCalledTimes(1);
    expect(libraryLoad).toHaveBeenCalledTimes(1);
    expect(selectorLoad.mock.calls[0]?.[0]).toEqual(libraryLoad.mock.calls[0]?.[0]);
    expect(selectorLoad.mock.calls[0]?.[0]).toMatchObject({
      modelPath,
      presetId: "shared-preset",
      contextSize: 2048,
      specDraftModelPath: "D:/models/configured-draft.gguf",
      chatTemplateContent: "custom-template",
      thinkingTagOverride: preset.thinkingTagOverride,
    });
  });
});
