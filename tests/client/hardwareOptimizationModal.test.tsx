/**
 * @packageDocumentation
 * Tests for the hardware optimization modal apply, cancel, and error paths.
 */

import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { HardwareOptimizationModal } from "../../src/client/components/preset/HardwareOptimizationModal";
import { useAppStore } from "../../src/client/store";
import { asFetch } from "../fixtures";

describe("HardwareOptimizationModal", () => {
  let queryClient: QueryClient;
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
    queryClient = new QueryClient({
      defaultOptions: {
        queries: { retry: false },
        mutations: { retry: false },
      },
    });
    useAppStore.setState({
      hardware: {
        cpuThreads: 16,
        totalRamBytes: 32 * 1024 * 1024 * 1024,
        gpus: [
          {
            name: "NVIDIA RTX 4090",
            vramBytes: 24 * 1024 * 1024 * 1024,
            backend: "cuda",
          },
        ],
      },
    });
  });

  afterEach(() => {
    queryClient.clear();
    cleanup();
    globalThis.fetch = originalFetch;
    mock.restore();
  });

  it("shows heuristic suggestions and applies the optimized load config", async () => {
    const onApply = mock();
    const onClose = mock();
    globalThis.fetch = asFetch(
      mock((input) => {
        const url = typeof input === "string" ? input : input.toString();
        if (url.includes("/api/hardware/optimize")) {
          return Promise.resolve(
            new Response(
              JSON.stringify({
                gpuLayers: 32,
                contextSize: 8192,
                threads: 8,
                mlock: true,
                kvCacheTypeK: "q8_0",
              }),
              { status: 200, headers: { "Content-Type": "application/json" } },
            ),
          );
        }
        return Promise.resolve(new Response("not found", { status: 404 }));
      }),
    );

    await act(async () => {
      render(
        <QueryClientProvider client={queryClient}>
          <HardwareOptimizationModal
            modelPath="/models/qwen.gguf"
            onApply={onApply}
            onClose={onClose}
          />
        </QueryClientProvider>,
      );
    });

    expect(await screen.findByText("Offloading 32 layers to GPU.")).toBeTruthy();
    expect(screen.getByText("Optimized context size to 8192 based on memory.")).toBeTruthy();
    expect(screen.getByText("Set 8 parallel threads for optimal CPU utilization.")).toBeTruthy();
    expect(screen.getByText("Enabling mlock to prevent memory swapping.")).toBeTruthy();
    expect(screen.getByText("Using 8-bit quantized KV cache to save memory.")).toBeTruthy();
    expect(screen.getByText("16 Logical Threads Available")).toBeTruthy();

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /apply settings/i }));
    });
    expect(onApply).toHaveBeenCalledWith({
      gpuLayers: 32,
      contextSize: 8192,
      threads: 8,
      mlock: true,
      kvCacheTypeK: "q8_0",
    });

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /cancel/i }));
    });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("surfaces a failed optimization request", async () => {
    globalThis.fetch = asFetch(
      mock((input) => {
        const url = typeof input === "string" ? input : input.toString();
        if (url.includes("/api/hardware/optimize")) {
          return Promise.resolve(new Response("nope", { status: 500 }));
        }
        return Promise.resolve(new Response("not found", { status: 404 }));
      }),
    );

    await act(async () => {
      render(
        <QueryClientProvider client={queryClient}>
          <HardwareOptimizationModal
            modelPath="/models/qwen.gguf"
            onApply={() => {}}
            onClose={() => {}}
          />
        </QueryClientProvider>,
      );
    });

    expect(await screen.findByText("Hardware optimization failed")).toBeTruthy();
    expect(
      (screen.getByRole("button", { name: /apply settings/i }) as HTMLButtonElement).disabled,
    ).toBe(true);
  });
});
