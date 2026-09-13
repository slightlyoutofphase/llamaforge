/**
 * @packageDocumentation
 * Optional live llama-server tool round-trip against a Gemma 4 GGUF.
 *
 * llama.cpp may coerce string `arguments` via `func_args_not_string` before Jinja
 * rendering, so a 400 from the template is version-dependent. LlamaForge still
 * always sends a mapping (see `toApiToolCalls`). This test is skipped unless
 * both `GEMMA4_GGUF_PATH` and `LLAMA_SERVER_PATH` are set, because it needs a
 * real Gemma 4 weights file and a local llama-server binary.
 */

import { describe, expect, it } from "bun:test";
import { restoreBunNativeWebGlobals } from "../happy-setup";
import { toApiToolCalls } from "../../src/shared/toolCalls";

const hasRealGemma4 =
  Boolean(process.env["GEMMA4_GGUF_PATH"]?.trim()) &&
  Boolean(process.env["LLAMA_SERVER_PATH"]?.trim());

const describeGemma4 = hasRealGemma4 ? describe : describe.skip;

describe("Gemma 4 tool-call argument wire shape", () => {
  it("documents that inference payloads use argument mappings", () => {
    const api = toApiToolCalls([
      {
        id: "tc_doc",
        type: "function",
        function: { name: "calculate", arguments: '{"expression":"2+2"}' },
      },
    ]);
    expect(api[0]?.function.arguments).toEqual({ expression: "2+2" });
  });
});

describeGemma4("Gemma 4 live tool round trip", () => {
  it(
    "completes call → approve → result → follow-up against llama-server",
    async () => {
      const modelPath = process.env["GEMMA4_GGUF_PATH"];
      const llamaServerPath = process.env["LLAMA_SERVER_PATH"];
      expect(modelPath).toBeString();
      expect(llamaServerPath).toBeString();
      if (!modelPath || !llamaServerPath) {
        throw new Error("GEMMA4_GGUF_PATH and LLAMA_SERVER_PATH must be set");
      }

      const { initDb, resetDb } = await import("../../src/server/persistence/db");
      const { saveSettings } = await import("../../src/server/persistence/settingsRepo");
      const { createInferencePreset } = await import("../../src/server/persistence/presetRepo");
      const { createChat, getChat, updateChat } =
        await import("../../src/server/persistence/chatRepo");
      const { loadModel, unloadModel } = await import("../../src/server/llamaServer");
      const { proxyCompletion } = await import("../../src/server/streamProxy");
      const { resolveToolApproval } = await import("../../src/server/tools");
      const { defaultBatchingForImageTokens, DEFAULT_IMAGE_MAX_TOKENS } =
        await import("../../src/shared/imageTokens");

      restoreBunNativeWebGlobals();
      await initDb(":memory:");
      try {
        await saveSettings({
          llamaServerPath,
          modelsPath: modelPath,
        });

        const inferencePresetId = "gemma4-live-tools";
        await createInferencePreset({
          id: inferencePresetId,
          name: "Gemma 4 live tools",
          isDefault: false,
          temperature: 0.2,
          topK: 20,
          topP: 0.9,
          minP: 0.05,
          repeatPenalty: 1.0,
          repeatLastN: 64,
          typicalP: 1.0,
          presencePenalty: 0.0,
          frequencyPenalty: 0.0,
          mirostat: 0,
          mirostatTau: 5.0,
          mirostatEta: 0.1,
          dynaTempRange: 0.0,
          dynaTempExponent: 1.0,
          seed: 7,
          maxTokens: 128,
          stopStrings: [],
          toolCallsEnabled: true,
          tools: [
            {
              name: "calculate",
              description: "Evaluate a mathematical expression.",
              parameters: {
                type: "object",
                properties: { expression: { type: "string" } },
                required: ["expression"],
              },
            },
          ],
          structuredOutput: undefined,
          contextOverflowPolicy: "TruncateMiddle",
          thinkingEnabled: false,
          createdAt: Date.now(),
          updatedAt: Date.now(),
        });

        await loadModel(
          {
            modelPath: modelPath as string,
            contextSize: 4096,
            contextShift: false,
            gpuLayers: -1,
            threads: -1,
            ...defaultBatchingForImageTokens(DEFAULT_IMAGE_MAX_TOKENS),
            ropeScaling: "none",
            ropeFreqBase: 0,
            ropeFreqScale: 0,
            kvCacheTypeK: "f16",
            kvCacheTypeV: "f16",
            mlock: false,
            noMmap: false,
            contBatching: true,
            flashAttn: "auto",
            swaFull: false,
            noKvOffload: false,
            cacheReuse: 0,
            imageMaxTokens: DEFAULT_IMAGE_MAX_TOKENS,
          },
          llamaServerPath as string,
          12500,
          12510,
        );

        const chat = await createChat("Gemma 4 tool round trip", modelPath);
        await updateChat(chat.id, { inferencePresetId });
        await proxyCompletion({
          chatId: chat.id,
          content: "Use the calculate tool to compute 2+2. Do not answer without calling the tool.",
          attachments: [],
        });

        const pending = await getChat(chat.id);
        const assistant = pending?.messages?.find((m) => m.role === "assistant" && m.toolCallsJson);
        expect(assistant?.toolCallsJson).toBeString();
        const toolCallId = JSON.parse(assistant?.toolCallsJson ?? "[]")[0]?.id as string;
        expect(toolCallId).toBeString();
        resolveToolApproval(toolCallId, true);

        await new Promise((r) => setTimeout(r, 8000));
        const reloaded = await getChat(chat.id);
        expect(reloaded?.messages?.some((m) => m.role === "tool")).toBe(true);
        expect(
          reloaded?.messages?.some((m) => m.role === "assistant" && (m.content?.length ?? 0) > 0),
        ).toBe(true);
      } finally {
        await unloadModel().catch(() => {});
        resetDb();
      }
    },
    { timeout: 120_000 },
  );
});
