import { describe, expect, it, beforeAll, beforeEach, afterEach, afterAll, mock } from "bun:test";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, cleanup } from "@testing-library/react";
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
                  flashAttention: false,
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
            bosToken: undefined,
            eosToken: undefined,
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
});
