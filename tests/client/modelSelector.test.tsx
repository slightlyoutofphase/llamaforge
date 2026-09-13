/**
 * @packageDocumentation
 * Tests for the model selector and saved preset navigation.
 */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, mock } from "bun:test";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { useAppStore } from "../../src/client/store";
import { ModelSelector } from "../../src/client/ModelSelector";
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
});
