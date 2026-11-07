/**
 * @packageDocumentation
 * Persisted vision and audio token budgets for attachments that will be sent.
 *
 * The text half of a prompt is measured with `/apply-template` and `/tokenize`.
 * Encoder tokens are not in that string, so each sent image, audio file, and
 * video stores an integer `virBudget` that is added to the text count.
 */

import fs from "node:fs/promises";
import path from "node:path";
import { spawn } from "bun";
import { gguf } from "@huggingface/gguf";
import { clampVideoFps, DEFAULT_VIDEO_FPS } from "../shared/defaults";
import { isExtractedVideoAudioAttachment } from "../shared/extractedAudio";
import {
  DEFAULT_IMAGE_MAX_TOKENS,
  DEFAULT_IMAGE_MIN_TOKENS,
  resolveImageMinTokens,
} from "../shared/imageTokens";
import type { Attachment, ChatMessage, ModelLoadConfig } from "../shared/types";
import { logDebug, logWarn } from "./logger";
import { getDb } from "./persistence/db";
import { resolveStoredAttachmentPath } from "./multimodal";
import { ffprobeCommandFromFfmpeg } from "./videoAudio";
import { resolveFfmpegPath } from "./videoFrames";
import { loadSettings } from "./persistence/settingsRepo";

/**
 * Projector and load-preset values that decide a media token budget.
 */
export interface MediaBudgetFactors {
  /** Absolute mmproj path, or an empty string when no projector is loaded. */
  mmprojPath: string;
  /** Millisecond mtime of that projector file, or `0` when there is none. */
  mmprojMtime: number;
  /** Running `--image-min-tokens`. */
  imageMinTokens: number;
  /** Running `--image-max-tokens`. */
  imageMaxTokens: number;
  /** Running `--video-fps`. */
  videoFps: number;
  /** Vision patch size read from the projector, in pixels. */
  patchSize: number;
  /** Spatial merge factor read from the projector. */
  mergeSize: number;
  /**
   * Frames fused into one vision embedding.
   *
   * llama.cpp b12024 `clip_model_n_temporal_merge` returns 2 for Qwen-VL,
   * LFM3-VL, Ling3-VL, and Nemotron Omni projectors.
   */
  temporalMerge: number;
  /** Audio encoder sample rate in hertz. */
  audioSampleRate: number;
  /** Audio samples represented by one encoder token. */
  audioHopLength: number;
  /** Loaded GGUF `general.architecture`, compared case-insensitively. */
  architecture: string | undefined;
  /** Whether the loaded model accepts image or video input. */
  hasVisionEncoder: boolean;
  /** Whether the loaded model accepts audio input. */
  hasAudioEncoder: boolean;
}

/** Default vision patch when the projector metadata does not name one. */
const DEFAULT_PATCH_SIZE = 14;

/** Default spatial merge when the projector metadata does not name one. */
const DEFAULT_MERGE_SIZE = 1;

/**
 * Projector type strings whose video frames llama.cpp counts in pairs.
 *
 * b12024 `clip_model_n_temporal_merge` returns 2 for these types, and
 * `mtmd_image_tokens::n_tokens` then uses `ceil(frameCount / 2)`.
 */
const TEMPORAL_MERGE_TWO = new Set([
  "qwen2vl_merger",
  "qwen2.5vl_merger",
  "qwen3vl_merger",
  "lfm3vl",
  "nemotron_omni",
  "ling3vl",
]);

/** Whisper-style samples per encoder token when the projector omits a hop. */
const DEFAULT_AUDIO_HOP = 320;

/** Whisper-style sample rate when the projector omits one. */
const DEFAULT_AUDIO_SAMPLE_RATE = 16_000;

/** Last successful projector read, reused if a later read fails while the file is mapped. */
let cachedProjectorRates: {
  path: string;
  rates: {
    patchSize: number;
    mergeSize: number;
    temporalMerge: number;
    audioSampleRate: number;
    audioHopLength: number;
    imageMinTokens?: number | undefined;
    imageMaxTokens?: number | undefined;
  };
} | null = null;

/**
 * Thrown when a media budget cannot be measured for a file that will be sent.
 */
export class MediaBudgetError extends Error {
  /**
   * @param message - Why the budget could not be computed.
   */
  constructor(message: string) {
    super(message);
    this.name = "MediaBudgetError";
  }
}

/**
 * Rounds a length up to a positive multiple of `factor`.
 *
 * @param value - Unaligned length.
 * @param factor - Alignment in pixels.
 * @returns The aligned length, at least `factor`.
 */
function ceilByFactor(value: number, factor: number): number {
  return Math.max(factor, Math.ceil(value / factor) * factor);
}

/**
 * Rounds a length down to a positive multiple of `factor`.
 *
 * @param value - Unaligned length.
 * @param factor - Alignment in pixels.
 * @returns The aligned length, at least `factor`.
 */
function floorByFactor(value: number, factor: number): number {
  return Math.max(factor, Math.floor(value / factor) * factor);
}

/**
 * Rounds a length to the nearest positive multiple of `factor`.
 *
 * @param value - Unaligned length.
 * @param factor - Alignment in pixels.
 * @returns The aligned length, at least `factor`.
 */
function roundByFactor(value: number, factor: number): number {
  return Math.max(factor, Math.round(value / factor) * factor);
}

/**
 * Counts dynamic-resolution image tokens for one frame and clamps them.
 *
 * The resize matches llama.cpp `smart_resize`: dimensions stay on a
 * patch-merge grid and the pixel area stays inside the min and max token
 * budgets. The returned count is that grid's token count, clamped again to
 * the same token bounds.
 *
 * @param width - Source width in pixels.
 * @param height - Source height in pixels.
 * @param factors - Patch size, merge, and the running token bounds.
 * @returns Integer token count for one image or video frame.
 */
export function dynamicResolutionImageTokens(
  width: number,
  height: number,
  factors: Pick<
    MediaBudgetFactors,
    "patchSize" | "mergeSize" | "imageMinTokens" | "imageMaxTokens"
  >,
): number {
  const patch = Math.max(1, Math.floor(factors.patchSize));
  const merge = Math.max(1, Math.floor(factors.mergeSize));
  const align = patch * merge;
  const minTokens = Math.max(1, Math.floor(factors.imageMinTokens));
  const maxTokens = Math.max(minTokens, Math.floor(factors.imageMaxTokens));
  const safeWidth = Math.max(1, Math.floor(width));
  const safeHeight = Math.max(1, Math.floor(height));
  const patchArea = align * align;
  const minPixels = minTokens * patchArea;
  const maxPixels = maxTokens * patchArea;

  let widthBar = roundByFactor(safeWidth, align);
  let heightBar = roundByFactor(safeHeight, align);
  const area = heightBar * widthBar;
  if (area > maxPixels) {
    const beta = Math.sqrt((safeHeight * safeWidth) / maxPixels);
    heightBar = floorByFactor(safeHeight / beta, align);
    widthBar = floorByFactor(safeWidth / beta, align);
  } else if (area < minPixels) {
    const beta = Math.sqrt(minPixels / (safeHeight * safeWidth));
    heightBar = ceilByFactor(safeHeight * beta, align);
    widthBar = ceilByFactor(safeWidth * beta, align);
  }

  const tokens = Math.round((widthBar / align) * (heightBar / align));
  return Math.min(maxTokens, Math.max(minTokens, tokens));
}

/**
 * Counts encoder tokens for an audio duration at the projector's audio rate.
 *
 * @param durationSeconds - Decoded duration in seconds.
 * @param factors - Sample rate and samples per encoder token.
 * @returns Integer token count, or `0` when the duration is empty.
 */
export function audioEncoderTokens(
  durationSeconds: number,
  factors: Pick<MediaBudgetFactors, "audioSampleRate" | "audioHopLength">,
): number {
  if (!Number.isFinite(durationSeconds) || durationSeconds <= 0) return 0;
  const sampleRate =
    factors.audioSampleRate > 0 ? factors.audioSampleRate : DEFAULT_AUDIO_SAMPLE_RATE;
  const hop = factors.audioHopLength > 0 ? factors.audioHopLength : DEFAULT_AUDIO_HOP;
  return Math.max(1, Math.ceil((durationSeconds * sampleRate) / hop));
}

/**
 * Counts tokens for a video from its frame grid and, for `lfm3`, its soundtrack.
 *
 * Other architectures keep soundtrack tokens on the extracted wav attachment.
 * Projectors in {@link TEMPORAL_MERGE_TWO} contribute one frame grid per
 * pair of sampled frames, matching llama.cpp `n_tokens()`.
 *
 * @param durationSeconds - Video duration in seconds.
 * @param width - Frame width in pixels.
 * @param height - Frame height in pixels.
 * @param soundtrackSeconds - Container audio duration, used only for `lfm3`.
 * @param factors - Running video rate, image bounds, and architecture.
 * @returns Integer token count for the video attachment.
 */
export function videoEncoderTokens(
  durationSeconds: number,
  width: number,
  height: number,
  soundtrackSeconds: number,
  factors: MediaBudgetFactors,
): number {
  const frames = Math.max(0, Math.round(Math.max(0, durationSeconds) * factors.videoFps));
  const temporalMerge = Math.max(1, Math.floor(factors.temporalMerge));
  const groups =
    temporalMerge <= 1 ? frames : Math.floor((frames + temporalMerge - 1) / temporalMerge);
  const perFrame = dynamicResolutionImageTokens(width, height, factors);
  let tokens = groups * perFrame;
  if ((factors.architecture ?? "").toLowerCase() === "lfm3") {
    tokens += audioEncoderTokens(soundtrackSeconds, factors);
  }
  return Math.max(0, tokens);
}

/**
 * Builds the cache key stored beside `virBudget`.
 *
 * A later send reuses the integer only when this key still matches.
 *
 * @param factors - Projector identity, sampling values, and temporal merge.
 * @returns Stable key text.
 */
export function virBudgetCacheKey(factors: MediaBudgetFactors): string {
  return [
    factors.mmprojPath,
    String(factors.mmprojMtime),
    String(factors.imageMinTokens),
    String(factors.imageMaxTokens),
    String(factors.videoFps),
    String(factors.temporalMerge),
  ].join("\0");
}

/**
 * Reads the first finite number stored under any of the candidate GGUF keys.
 *
 * @param metadata - Projector metadata map.
 * @param keys - Keys to try, in order.
 * @returns The number, or `undefined` when every key is missing.
 */
function readMetaNumber(
  metadata: Record<string, unknown>,
  keys: readonly string[],
): number | undefined {
  for (const key of keys) {
    const value = metadata[key];
    if (typeof value === "number" && Number.isFinite(value)) return value;
    if (typeof value === "bigint") return Number(value);
  }
  return undefined;
}

/**
 * Reads vision and audio encoder rates from a projector GGUF.
 *
 * Missing keys fall back to the defaults used by the token formulas.
 *
 * @param mmprojPath - Absolute projector path, or empty when none is loaded.
 * @returns Patch, merge, temporal merge, sample rate, and hop length.
 */
export async function readMmprojBudgetRates(mmprojPath: string): Promise<{
  patchSize: number;
  mergeSize: number;
  temporalMerge: number;
  audioSampleRate: number;
  audioHopLength: number;
  imageMinTokens?: number | undefined;
  imageMaxTokens?: number | undefined;
}> {
  const defaults = {
    patchSize: DEFAULT_PATCH_SIZE,
    mergeSize: DEFAULT_MERGE_SIZE,
    temporalMerge: 1,
    audioSampleRate: DEFAULT_AUDIO_SAMPLE_RATE,
    audioHopLength: DEFAULT_AUDIO_HOP,
  };
  if (!mmprojPath) return defaults;
  try {
    const parsed = (await gguf(mmprojPath, { allowLocalFile: true })) as {
      metadata?: Record<string, unknown>;
    };
    const metadata = parsed.metadata ?? {};
    const imageMinTokens = readMetaNumber(metadata, [
      "clip.vision.image_min_tokens",
      "vision.image_min_tokens",
    ]);
    const imageMaxTokens = readMetaNumber(metadata, [
      "clip.vision.image_max_tokens",
      "vision.image_max_tokens",
    ]);
    const projectorType = String(metadata["clip.projector_type"] ?? "").toLowerCase();
    const rates = {
      patchSize:
        readMetaNumber(metadata, [
          "clip.vision.patch_size",
          "vision.patch_size",
          "clip.patch_size",
        ]) ?? defaults.patchSize,
      mergeSize:
        readMetaNumber(metadata, [
          "clip.vision.spatial_merge_size",
          "clip.vision.n_merge",
          "vision.spatial_merge_size",
        ]) ?? defaults.mergeSize,
      temporalMerge: TEMPORAL_MERGE_TWO.has(projectorType) ? 2 : 1,
      audioSampleRate:
        readMetaNumber(metadata, [
          "clip.audio.sample_rate",
          "audio.sample_rate",
          "clip.audio_sample_rate",
        ]) ?? defaults.audioSampleRate,
      audioHopLength:
        readMetaNumber(metadata, [
          "clip.audio.hop_length",
          "audio.hop_length",
          "clip.audio_hop_length",
        ]) ?? defaults.audioHopLength,
      ...(imageMinTokens !== undefined ? { imageMinTokens } : {}),
      ...(imageMaxTokens !== undefined ? { imageMaxTokens } : {}),
    };
    cachedProjectorRates = { path: mmprojPath, rates };
    return rates;
  } catch (err: unknown) {
    logWarn("Could not read projector budget metadata", {
      mmprojPath,
      message: err instanceof Error ? err.message : String(err),
    });
    if (cachedProjectorRates?.path === mmprojPath) return cachedProjectorRates.rates;
    return defaults;
  }
}

/**
 * Builds the budget factors for the model that is loaded right now.
 *
 * @param config - Running load configuration.
 * @param architecture - GGUF architecture of the text model.
 * @param capabilities - Encoder flags from the loaded model metadata.
 * @returns Factors used to compute and cache `virBudget`.
 */
export async function budgetFactorsForLoadedModel(
  config: ModelLoadConfig | null | undefined,
  architecture: string | undefined,
  capabilities: { hasVisionEncoder?: boolean | undefined; hasAudioEncoder?: boolean | undefined },
): Promise<MediaBudgetFactors> {
  const mmprojPath = config?.mmProjPath ?? "";
  let mmprojMtime = 0;
  if (mmprojPath) {
    try {
      const stat = await fs.stat(mmprojPath);
      mmprojMtime = Math.trunc(stat.mtimeMs);
    } catch {
      mmprojMtime = 0;
    }
  }
  const rates = await readMmprojBudgetRates(mmprojPath);
  const imageMaxTokens =
    config?.imageMaxTokens !== undefined
      ? config.imageMaxTokens
      : (rates.imageMaxTokens ?? DEFAULT_IMAGE_MAX_TOKENS);
  const imageMinTokens =
    config?.imageMaxTokens !== undefined
      ? resolveImageMinTokens(config.imageMaxTokens, config.imageMinTokens)
      : Math.max(
          1,
          Math.min(rates.imageMinTokens ?? DEFAULT_IMAGE_MIN_TOKENS, Math.ceil(imageMaxTokens)),
        );
  return {
    mmprojPath,
    mmprojMtime,
    imageMinTokens,
    imageMaxTokens: Math.max(imageMinTokens, Math.ceil(imageMaxTokens)),
    videoFps: clampVideoFps(config?.videoFps ?? DEFAULT_VIDEO_FPS),
    patchSize: rates.patchSize,
    mergeSize: rates.mergeSize,
    temporalMerge: rates.temporalMerge,
    audioSampleRate: rates.audioSampleRate,
    audioHopLength: rates.audioHopLength,
    architecture,
    hasVisionEncoder: capabilities.hasVisionEncoder !== false,
    hasAudioEncoder: capabilities.hasAudioEncoder !== false,
  };
}

/**
 * Reports whether this attachment will be placed in the completion body.
 *
 * @param attachment - Attachment on the outgoing message.
 * @param factors - Encoder flags for the loaded model.
 * @returns `true` when the attachment contributes a `virBudget`.
 */
function attachmentWillBeSent(attachment: Attachment, factors: MediaBudgetFactors): boolean {
  if (attachment.mimeType.startsWith("image/")) return factors.hasVisionEncoder;
  if (attachment.mimeType.startsWith("video/")) return factors.hasVisionEncoder;
  if (attachment.mimeType.startsWith("audio/")) return factors.hasAudioEncoder;
  return false;
}

/**
 * Reads width and height from a PNG, GIF, JPEG, or WEBP header.
 *
 * @param bytes - Leading bytes of the file. A full small file is accepted.
 * @returns Pixel size, or `null` when the header is not one of those formats.
 */
export function readRasterSize(bytes: Uint8Array): { width: number; height: number } | null {
  if (bytes.length >= 24 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e) {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    return { width: view.getUint32(16), height: view.getUint32(20) };
  }
  if (bytes.length >= 10 && bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46) {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    return { width: view.getUint16(6, true), height: view.getUint16(8, true) };
  }
  if (bytes.length >= 4 && bytes[0] === 0xff && bytes[1] === 0xd8) {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    let offset = 2;
    while (offset + 8 < bytes.length) {
      if (bytes[offset] !== 0xff) break;
      const marker = bytes[offset + 1] ?? 0;
      if (marker === 0xd8 || marker === 0xd9) {
        offset += 2;
        continue;
      }
      const length = view.getUint16(offset + 2);
      if (length < 2) break;
      const isStartOfFrame =
        marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
      if (isStartOfFrame && offset + 9 < bytes.length) {
        return { height: view.getUint16(offset + 5), width: view.getUint16(offset + 7) };
      }
      offset += 2 + length;
    }
  }
  if (
    bytes.length >= 30 &&
    bytes[0] === 0x52 &&
    bytes[1] === 0x49 &&
    bytes[2] === 0x46 &&
    bytes[3] === 0x46
  ) {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const fourcc = String.fromCharCode(
      bytes[12] ?? 0,
      bytes[13] ?? 0,
      bytes[14] ?? 0,
      bytes[15] ?? 0,
    );
    if (fourcc === "VP8X" && bytes.length >= 30) {
      const width = 1 + (bytes[24] ?? 0) + ((bytes[25] ?? 0) << 8) + ((bytes[26] ?? 0) << 16);
      const height = 1 + (bytes[27] ?? 0) + ((bytes[28] ?? 0) << 8) + ((bytes[29] ?? 0) << 16);
      return { width, height };
    }
    if (fourcc === "VP8 " && bytes.length >= 30) {
      return {
        width: view.getUint16(26, true) & 0x3fff,
        height: view.getUint16(28, true) & 0x3fff,
      };
    }
    if (fourcc === "VP8L" && bytes.length >= 25) {
      const bits = view.getUint32(21, true);
      return { width: (bits & 0x3fff) + 1, height: ((bits >> 14) & 0x3fff) + 1 };
    }
  }
  return null;
}

/**
 * Reads a PCM WAV duration from its `fmt` and `data` chunks.
 *
 * @param bytes - File bytes. The data chunk size is enough; samples are not decoded.
 * @returns Duration in seconds, or `null` when the file is not a PCM WAV.
 */
export function readWavDurationSeconds(bytes: Uint8Array): number | null {
  if (bytes.length < 44) return null;
  if (String.fromCharCode(...bytes.subarray(0, 4)) !== "RIFF") return null;
  if (String.fromCharCode(...bytes.subarray(8, 12)) !== "WAVE") return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let offset = 12;
  let sampleRate = 0;
  let channels = 0;
  let bitsPerSample = 0;
  let dataBytes = 0;
  while (offset + 8 <= bytes.length) {
    const id = String.fromCharCode(...bytes.subarray(offset, offset + 4));
    const size = view.getUint32(offset + 4, true);
    if (id === "fmt " && offset + 16 <= bytes.length) {
      channels = view.getUint16(offset + 10, true);
      sampleRate = view.getUint32(offset + 12, true);
      bitsPerSample = view.getUint16(offset + 22, true);
    } else if (id === "data") {
      dataBytes = size;
      break;
    }
    offset += 8 + size + (size % 2);
  }
  if (sampleRate <= 0 || channels <= 0 || bitsPerSample <= 0 || dataBytes <= 0) return null;
  const bytesPerSecond = sampleRate * channels * (bitsPerSample / 8);
  if (bytesPerSecond <= 0) return null;
  return dataBytes / bytesPerSecond;
}

/**
 * Container timing and pixel size reported by ffprobe.
 */
interface ProbeMediaInfo {
  /** Duration in seconds, or `0` when the container does not report one. */
  durationSeconds: number;
  /** Pixel width, or `0` when the probed stream is audio-only. */
  width: number;
  /** Pixel height, or `0` when the probed stream is audio-only. */
  height: number;
  /** Audio-stream duration in seconds, or `0` when no audio stream is present. */
  audioDurationSeconds: number;
}

/**
 * Runs ffprobe for duration, pixel size, and audio-stream duration.
 *
 * @param absolutePath - Media file to inspect.
 * @returns Probe measurements.
 */
async function probeMedia(absolutePath: string): Promise<ProbeMediaInfo> {
  const settings = await loadSettings();
  const ffmpeg = await resolveFfmpegPath(settings);
  if (!ffmpeg) {
    throw new MediaBudgetError(`ffmpeg is required to measure ${path.basename(absolutePath)}.`);
  }
  const proc = spawn({
    cmd: [
      ffprobeCommandFromFfmpeg(ffmpeg),
      "-hide_banner",
      "-loglevel",
      "error",
      "-show_entries",
      "format=duration:stream=codec_type,width,height,duration",
      "-of",
      "json",
      absolutePath,
    ],
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  if (exitCode !== 0) {
    throw new MediaBudgetError(
      `ffprobe failed for ${path.basename(absolutePath)}: ${stderr.trim() || `exit ${exitCode}`}`,
    );
  }
  let parsed: {
    format?: { duration?: string };
    streams?: { codec_type?: string; width?: number; height?: number; duration?: string }[];
  };
  try {
    parsed = JSON.parse(stdout) as typeof parsed;
  } catch {
    throw new MediaBudgetError(`ffprobe returned invalid JSON for ${path.basename(absolutePath)}.`);
  }
  const streams = parsed.streams ?? [];
  const video = streams.find((stream) => stream.codec_type === "video");
  const audio = streams.find((stream) => stream.codec_type === "audio");
  const duration = Number(video?.duration ?? parsed.format?.duration ?? audio?.duration ?? 0);
  return {
    durationSeconds: Number.isFinite(duration) ? duration : 0,
    width: video?.width ?? 0,
    height: video?.height ?? 0,
    audioDurationSeconds: Number(audio?.duration ?? (audio ? duration : 0)) || 0,
  };
}

/**
 * Measures one attachment and returns its encoder token count.
 *
 * @param attachment - Image, audio, or video that will be sent.
 * @param factors - Running projector and sampling values.
 * @returns Integer `virBudget`.
 */
async function measureAttachmentBudget(
  attachment: Attachment,
  factors: MediaBudgetFactors,
): Promise<number> {
  const absolutePath = resolveStoredAttachmentPath(attachment.filePath);
  if (!absolutePath) {
    throw new MediaBudgetError(`Attachment path is not stored locally: ${attachment.filePath}`);
  }
  if (attachment.mimeType.startsWith("image/")) {
    const header = new Uint8Array(await Bun.file(absolutePath).slice(0, 65_536).arrayBuffer());
    const raster = readRasterSize(header);
    const size = raster ?? (await probeMedia(absolutePath));
    if (size.width <= 0 || size.height <= 0) {
      throw new MediaBudgetError(`Could not read pixel size for ${attachment.fileName}.`);
    }
    return dynamicResolutionImageTokens(size.width, size.height, factors);
  }
  if (attachment.mimeType.startsWith("audio/")) {
    const header = new Uint8Array(await Bun.file(absolutePath).slice(0, 65_536).arrayBuffer());
    const duration =
      readWavDurationSeconds(header) ?? (await probeMedia(absolutePath)).durationSeconds;
    return audioEncoderTokens(duration, factors);
  }
  const probed = await probeMedia(absolutePath);
  if (probed.width <= 0 || probed.height <= 0) {
    throw new MediaBudgetError(`Could not read video frame size for ${attachment.fileName}.`);
  }
  return videoEncoderTokens(
    probed.durationSeconds,
    probed.width,
    probed.height,
    probed.audioDurationSeconds,
    factors,
  );
}

/**
 * Reads a stored budget when the projector and sampling values are unchanged.
 *
 * @param attachmentId - Attachment row id.
 * @param cacheKey - Key from {@link virBudgetCacheKey}.
 * @returns The stored integer, or `null` when it must be recomputed.
 */
function readCachedVirBudget(attachmentId: string, cacheKey: string): number | null {
  try {
    const row = getDb()
      .query<{ vir_budget: number | null; vir_key: string | null }, [string]>(
        "SELECT vir_budget, vir_key FROM attachments WHERE id = ?",
      )
      .get(attachmentId);
    if (!row || row.vir_key !== cacheKey || !Number.isInteger(row.vir_budget)) return null;
    return row.vir_budget;
  } catch {
    return null;
  }
}

/**
 * Writes a budget and the cache key onto the attachment row when the row exists.
 *
 * @param attachmentId - Attachment row id.
 * @param budget - Integer encoder token count.
 * @param cacheKey - Key that produced `budget`.
 * @returns No return value.
 */
function writeVirBudget(attachmentId: string, budget: number, cacheKey: string): void {
  try {
    getDb()
      .prepare("UPDATE attachments SET vir_budget = ?, vir_key = ? WHERE id = ?")
      .run(budget, cacheKey, attachmentId);
  } catch (err: unknown) {
    logDebug("Could not persist attachment virBudget", {
      attachmentId,
      message: err instanceof Error ? err.message : String(err),
    });
  }
}

/**
 * Assigns `virBudget` on every image, audio, and video attachment that will be sent.
 *
 * Unchanged projector path, projector mtime, image bounds, and video rate reuse
 * the stored integer. Any change recomputes and overwrites it.
 *
 * @param messages - Transcript that is about to be serialized once.
 * @param factors - Running model and projector values.
 * @returns No return value.
 */
export async function assignOutgoingVirBudgets(
  messages: readonly ChatMessage[],
  factors: MediaBudgetFactors,
): Promise<void> {
  const cacheKey = virBudgetCacheKey(factors);
  for (const message of messages) {
    for (const attachment of message.attachments ?? []) {
      if (!attachmentWillBeSent(attachment, factors)) {
        continue;
      }
      if (isExtractedVideoAudioAttachment(attachment) && !factors.hasAudioEncoder) {
        continue;
      }
      const cached = readCachedVirBudget(attachment.id, cacheKey);
      if (cached !== null) {
        attachment.virBudget = cached;
        continue;
      }
      const budget = await measureAttachmentBudget(attachment, factors);
      attachment.virBudget = budget;
      writeVirBudget(attachment.id, budget, cacheKey);
    }
  }
}

/**
 * Sums stored encoder tokens for one outgoing message.
 *
 * @param message - Message whose sent attachments already have `virBudget`.
 * @returns Non-negative integer.
 */
export function sumMessageVirBudget(message: ChatMessage): number {
  let total = 0;
  for (const attachment of message.attachments ?? []) {
    if (Number.isInteger(attachment.virBudget) && (attachment.virBudget ?? 0) > 0) {
      total += attachment.virBudget ?? 0;
    }
  }
  return total;
}
