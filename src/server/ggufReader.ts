/**
 * @packageDocumentation
 * GGUF metadata parsing using @huggingface/gguf.
 */
import { gguf } from "@huggingface/gguf";
import type { GgufDisplayMetadata } from "@shared/types.js";

const QUANT_NAMES: Record<number, string> = {
  0: "F32",
  1: "F16",
  2: "Q4_0",
  3: "Q4_1",
  6: "Q5_0",
  7: "Q5_1",
  8: "Q8_0",
  9: "Q8_1",
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
  27: "IQ2_S",
  28: "IQ4_XS",
  29: "IQ2_M",
  30: "IQ3_M",
  31: "IQ1_M",
};

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

  const hasVision = Boolean(metadata?.["clip.has_vision_encoder"] === true);
  const hasAudio = Boolean(metadata?.["clip.has_audio_encoder"] === true);

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
        ? QUANT_NAMES[metadata["general.file_type"] as number] ||
          `TYPE_${String(metadata["general.file_type"])}`
        : undefined,
    hasVisionEncoder: hasVision,
    hasAudioEncoder: hasAudio,
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
    chatTemplate:
      typeof metadata?.["tokenizer.chat_template"] === "string"
        ? (metadata["tokenizer.chat_template"] as string)
        : undefined,
    bosToken:
      typeof metadata?.["tokenizer.ggml.bos_token_id"] !== "undefined"
        ? String(metadata["tokenizer.ggml.bos_token_id"])
        : undefined,
    eosToken:
      typeof metadata?.["tokenizer.ggml.eos_token_id"] !== "undefined"
        ? String(metadata["tokenizer.ggml.eos_token_id"])
        : undefined,
  };
}
