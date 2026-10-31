/**
 * @packageDocumentation
 * GGUF metadata parsing using @huggingface/gguf.
 */
import { gguf } from "@huggingface/gguf";
import { templateSupportsToolCalling } from "../shared/templateCapabilities";
import type { GgufDisplayMetadata } from "../shared/types";

/**
 * llama.cpp `LlamaFileType` names, in the same display style as the GGUF reader.
 * Removed ids (4–6 and 33–35) are omitted so they fall through to `TYPE_<n>`.
 */
const QUANT_NAMES: Record<number, string> = {
  0: "F32",
  1: "F16",
  2: "Q4_0",
  3: "Q4_1",
  7: "Q8_0",
  8: "Q5_0",
  9: "Q5_1",
  10: "Q2_K",
  11: "Q3_K_S",
  12: "Q3_K_M",
  13: "Q3_K_L",
  14: "Q4_K_S",
  15: "Q4_K_M",
  16: "Q5_K_S",
  17: "Q5_K_M",
  18: "Q6_K",
  19: "IQ2_XXS",
  20: "IQ2_XS",
  21: "Q2_K_S",
  22: "IQ3_XS",
  23: "IQ3_XXS",
  24: "IQ1_S",
  25: "IQ4_NL",
  26: "IQ3_S",
  27: "IQ3_M",
  28: "IQ2_S",
  29: "IQ2_M",
  30: "IQ4_XS",
  31: "IQ1_M",
  32: "BF16",
  36: "TQ1_0",
  37: "TQ2_0",
  38: "MXFP4_MOE",
  39: "NVFP4",
  40: "Q1_0",
  41: "Q2_0",
  42: "F8_E4M3",
};

/**
 * Maps a GGUF `general.file_type` id to its quantization label.
 *
 * Unknown and removed ids use the `TYPE_<n>` fallback.
 *
 * @param fileType - Numeric file type from the GGUF header.
 * @returns The display label for that file type.
 */
export function describeGgufQuantization(fileType: number): string {
  return QUANT_NAMES[fileType] ?? `TYPE_${String(fileType)}`;
}

/**
 * Interprets a GGUF scalar as an enabled boolean flag.
 * GGUF bools are often encoded as integer `0`/`1` rather than JSON booleans.
 *
 * @param value - Raw metadata value from `@huggingface/gguf`.
 * @returns `true` when the value represents an enabled flag.
 */
function ggufFlagEnabled(value: unknown): boolean {
  return value === true || value === 1 || value === 1n || value === "true" || value === "1";
}

/**
 * Reads a GGUF boolean when the key is present.
 *
 * An explicit `false` must stay false. Callers use `undefined` to mean the key
 * was absent and a filename or architecture fallback is allowed.
 *
 * @param value - Raw metadata value for the flag.
 * @returns The flag, or `undefined` when the key is missing.
 */
function readOptionalGgufFlag(value: unknown): boolean | undefined {
  if (value === undefined || value === null) return undefined;
  return ggufFlagEnabled(value);
}

/**
 * Parses a GGUF file and extracts display metadata.
 *
 * @param fileAbsolutePath - The absolute path to the local GGUF file.
 * @returns A promise that resolves to the {@link GgufDisplayMetadata} extracted from the file.
 * @throws {Error} If the GGUF file cannot be parsed or access is denied.
 */
export async function parseGgufMetadata(fileAbsolutePath: string): Promise<GgufDisplayMetadata> {
  const { metadata } = (await gguf(fileAbsolutePath, { allowLocalFile: true })) as {
    metadata: Record<string, string | number | bigint | boolean | unknown>;
  };

  const arch = String(metadata?.["general.architecture"] || "unknown");

  const ctx = metadata?.[`${arch}.context_length`];
  const emb = metadata?.[`${arch}.embedding_length`];
  const headCount = metadata?.[`${arch}.attention.head_count`];
  const headCountKv = metadata?.[`${arch}.attention.head_count_kv`];
  const blockCount = metadata?.[`${arch}.block_count`];
  const ffLen = metadata?.[`${arch}.feed_forward_length`];

  const explicitVision = readOptionalGgufFlag(metadata?.["clip.has_vision_encoder"]);
  const explicitAudio = readOptionalGgufFlag(metadata?.["clip.has_audio_encoder"]);
  const projectorType = String(metadata?.["clip.projector_type"] ?? "").toLowerCase();
  const hasVision =
    explicitVision ?? (arch === "clip" || metadata?.["clip.projector_type"] !== undefined);
  const hasAudio = explicitAudio ?? projectorType.includes("audio");

  const chatTemplate =
    typeof metadata?.["tokenizer.chat_template"] === "string"
      ? (metadata["tokenizer.chat_template"] as string)
      : undefined;

  return {
    architecture: arch,
    name: String(metadata?.["general.name"] || "Unknown"),
    fileSizeBytes: 0, // This should be populated by the caller using fs.statSync
    contextLength: typeof ctx === "number" || typeof ctx === "bigint" ? Number(ctx) : undefined,
    embeddingLength: typeof emb === "number" || typeof emb === "bigint" ? Number(emb) : undefined,
    attentionHeadCount:
      typeof headCount === "number" || typeof headCount === "bigint"
        ? Number(headCount)
        : undefined,
    attentionHeadCountKv:
      typeof headCountKv === "number" || typeof headCountKv === "bigint"
        ? Number(headCountKv)
        : undefined,
    blockCount:
      typeof blockCount === "number" || typeof blockCount === "bigint"
        ? Number(blockCount)
        : undefined,
    feedForwardLength:
      typeof ffLen === "number" || typeof ffLen === "bigint" ? Number(ffLen) : undefined,
    quantType:
      typeof metadata?.["general.file_type"] === "number"
        ? describeGgufQuantization(metadata["general.file_type"] as number)
        : undefined,
    hasVisionEncoder: hasVision,
    hasAudioEncoder: hasAudio,
    hasToolCalling: templateSupportsToolCalling(chatTemplate),
    isDraftModel: false,
    defaultTemperature:
      typeof metadata?.["tokenizer.ggml.sampling.temperature"] === "number"
        ? (metadata["tokenizer.ggml.sampling.temperature"] as number)
        : typeof metadata?.["general.sampling.temperature"] === "number"
          ? (metadata["general.sampling.temperature"] as number)
          : typeof metadata?.["general.sampling.temp"] === "number"
            ? (metadata["general.sampling.temp"] as number)
            : undefined,
    defaultTopK:
      typeof metadata?.["tokenizer.ggml.sampling.top_k"] === "number"
        ? (metadata["tokenizer.ggml.sampling.top_k"] as number)
        : typeof metadata?.["general.sampling.top_k"] === "number"
          ? (metadata["general.sampling.top_k"] as number)
          : undefined,
    defaultTopP:
      typeof metadata?.["tokenizer.ggml.sampling.top_p"] === "number"
        ? (metadata["tokenizer.ggml.sampling.top_p"] as number)
        : typeof metadata?.["general.sampling.top_p"] === "number"
          ? (metadata["general.sampling.top_p"] as number)
          : undefined,
    defaultMinP:
      typeof metadata?.["tokenizer.ggml.sampling.min_p"] === "number"
        ? (metadata["tokenizer.ggml.sampling.min_p"] as number)
        : typeof metadata?.["general.sampling.min_p"] === "number"
          ? (metadata["general.sampling.min_p"] as number)
          : undefined,
    defaultRepeatPenalty:
      typeof metadata?.["tokenizer.ggml.sampling.penalty_repeat"] === "number"
        ? (metadata["tokenizer.ggml.sampling.penalty_repeat"] as number)
        : typeof metadata?.["general.sampling.penalty_repeat"] === "number"
          ? (metadata["general.sampling.penalty_repeat"] as number)
          : undefined,
    chatTemplate,
  };
}
