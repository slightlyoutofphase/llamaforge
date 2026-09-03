/**
 * @packageDocumentation
 * Tests for the model selector and saved preset navigation.
 */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, mock } from "bun:test";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { useAppStore } from "../../src/client/store";

mock.module("@tanstack/react-router", () => ({
  useNavigate: () => mock(),
}));

import { ModelSelector } from "../../src/client/ModelSelector";

const queryClient = new QueryClient({
  defaultOptions: {
    queries: { retry: false },
    mutations: { retry: false },
  },
});

const defaultState = {
  models: [],
  loadModel: () => {},
  unloadModel: () => {},
  serverStatus: "idle",
  loadedModel: null,
  messages: [],
  isGenerating: false,
  loadProgress: 0,
  loadProgressPhase: null,
  loadProgressDetail: null,
};

mock.module("@tanstack/react-router", () => ({
  useNavigate: () => mock(),
}));

let originalFetch: typeof global.fetch;

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
    useAppStore.setState(defaultState);
    global.fetch = mock((input) => {
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
    });
  });

  afterEach(() => {
    cleanup();
    useAppStore.setState(defaultState);
  });

  it("renders model metadata without unknown placeholders when metadata is available", () => {
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
            defaultTemperature: 0.8,
            defaultTopK: 40,
            defaultTopP: 0.95,
            defaultMinP: 0.05,
            defaultRepeatPenalty: 1.1,
            chatTemplate: undefined,
          },
        },
      ],
      loadModel: () => {},
      unloadModel: () => {},
      serverStatus: "idle",
      loadedModel: null,
      messages: [],
      isGenerating: false,
    });

    render(
      <QueryClientProvider client={queryClient}>
        <ModelSelector />
      </QueryClientProvider>,
    );

    expect(screen.getByText("unsloth")).toBeTruthy();
    expect(screen.getByText("gemma4")).toBeTruthy();
    expect(screen.getByText("0.11 GB")).toBeTruthy();
    expect(screen.getByText("VISION ENABLED")).toBeTruthy();
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
      unloadModel: () => {},
      serverStatus: "idle",
      loadedModel: null,
      messages: [],
      isGenerating: false,
      loadProgress: 0,
      loadProgressPhase: null,
      loadProgressDetail: null,
    } as any);

    global.fetch = mock((input) => {
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
    });

    render(
      <QueryClientProvider client={queryClient}>
        <ModelSelector />
      </QueryClientProvider>,
    );

    fireEvent.click(await screen.findByRole("button", { name: /load/i }));

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

  it("shows load progress instead of the static splash while a model is loading", () => {
    useAppStore.setState({
      models: [],
      loadModel: () => {},
      unloadModel: () => {},
      serverStatus: "loading",
      loadedModel: null,
      messages: [],
      isGenerating: false,
      loadProgress: 42,
      loadProgressPhase: "loading_weights",
      loadProgressDetail: "Loading tensor blocks",
    } as any);

    render(
      <QueryClientProvider client={queryClient}>
        <ModelSelector />
      </QueryClientProvider>,
    );

    expect(screen.queryByText("Initializing Weights")).toBeNull();
    expect(screen.getByText("Loading model")).toBeTruthy();
    expect(screen.getByText("42%")).toBeTruthy();
    expect(screen.getByText("Loading tensor blocks")).toBeTruthy();
  });
});
