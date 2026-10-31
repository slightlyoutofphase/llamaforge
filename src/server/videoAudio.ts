/**
 * @packageDocumentation
 * Probes video attachments for audio streams and extracts a cached WAV sidecar
 * so inference can send `input_video` and `input_audio` as separate parts.
 * llama-server cannot consume muxed video+audio as a single file.
 */

import fs from "node:fs/promises";
import path from "node:path";
import { spawn } from "bun";
import {
  EXTRACTED_AUDIO_SUFFIX,
  NO_AUDIO_MARKER_SUFFIX,
  isExtractedVideoAudioAttachment,
  videoAudioSidecarOwnerStem,
} from "../shared/extractedAudio";
import type { AppSettings } from "../shared/types";
import { logInfo, logWarn } from "./logger";
import { loadSettings } from "./persistence/settingsRepo";
import { resolveFfmpegPath } from "./videoFrames";

export {
  EXTRACTED_AUDIO_SUFFIX,
  NO_AUDIO_MARKER_SUFFIX,
  isExtractedVideoAudioAttachment,
  videoAudioSidecarOwnerStem,
};

const PROBE_TIMEOUT_MS = 10_000;
const EXTRACT_TIMEOUT_MS = 120_000;
const VERSION_TIMEOUT_MS = 4_000;

let cachedFfprobePath: string | null | undefined;
const inFlightSidecars = new Map<string, Promise<string | null>>();

/**
 * Probes whether the container declares an audio stream.
 * `null` means the probe failed and the result must not be cached as silence.
 */
export type VideoAudioProbeFn = (inputPath: string) => Promise<boolean | null>;

/**
 * Extracts the first audio stream from a video into `outputPath`.
 *
 * @returns `true` when extraction wrote a usable file.
 */
export type VideoAudioExtractFn = (inputPath: string, outputPath: string) => Promise<boolean>;

let probeImpl: VideoAudioProbeFn = probeVideoHasAudioStream;
let extractImpl: VideoAudioExtractFn = extractVideoAudioTrack;

/**
 * Absolute sidecar paths derived from a stored video attachment path.
 */
export interface VideoAudioSidecarPaths {
  /** PCM WAV extracted from the video soundtrack, when present. */
  audioPath: string;
  /** Empty marker file written when ffprobe reports no audio stream. */
  markerPath: string;
}

/**
 * Result of a timed subprocess used for ffprobe/ffmpeg helpers.
 */
interface TimedCommandResult {
  /** Process exit code, or `null` when the process could not be started. */
  exitCode: number | null;
  /** Captured standard output. */
  stdout: string;
  /** Captured standard error. */
  stderr: string;
}

/**
 * Builds the WAV and no-audio marker paths that sit beside a video attachment.
 *
 * @param videoAbsPath - Absolute path of the stored video file.
 * @returns Sidecar paths that share the video's directory and basename stem.
 */
export function videoAudioSidecarPaths(videoAbsPath: string): VideoAudioSidecarPaths {
  const parsed = path.parse(videoAbsPath);
  return {
    audioPath: path.join(parsed.dir, `${parsed.name}${EXTRACTED_AUDIO_SUFFIX}`),
    markerPath: path.join(parsed.dir, `${parsed.name}${NO_AUDIO_MARKER_SUFFIX}`),
  };
}

/**
 * Builds copy pairs so a branched video keeps its extracted-audio cache.
 *
 * @param oldVideoPath - Absolute path of the source video.
 * @param newVideoPath - Absolute path of the copied video.
 * @returns Old-to-new sidecar path pairs (files may not exist yet).
 */
export function videoAudioSidecarCopyPlan(
  oldVideoPath: string,
  newVideoPath: string,
): Array<{ oldPath: string; newPath: string }> {
  const oldSide = videoAudioSidecarPaths(oldVideoPath);
  const newSide = videoAudioSidecarPaths(newVideoPath);
  return [
    { oldPath: oldSide.audioPath, newPath: newSide.audioPath },
    { oldPath: oldSide.markerPath, newPath: newSide.markerPath },
  ];
}

/**
 * Derives an ffprobe command from a resolved ffmpeg path.
 *
 * Bare PATH lookups (`ffmpeg` / `ffmpeg.exe`) stay as bare `ffprobe` commands.
 * Absolute ffmpeg paths use the sibling `ffprobe` binary in the same directory.
 *
 * @param ffmpegPath - Resolved ffmpeg command or absolute path.
 * @returns ffprobe command suitable for `spawn`.
 */
export function ffprobeCommandFromFfmpeg(ffmpegPath: string): string {
  const probeExe = process.platform === "win32" ? "ffprobe.exe" : "ffprobe";
  if (path.basename(ffmpegPath) === ffmpegPath) {
    return probeExe;
  }
  return path.join(path.dirname(ffmpegPath), probeExe);
}

/**
 * Builds ffprobe arguments that inspect only the first audio stream's codec type.
 *
 * This is a container-metadata read; it does not decode audio samples.
 *
 * @param inputPath - Absolute path of the video to probe.
 * @returns ffprobe argv excluding the executable.
 */
export function buildFfprobeHasAudioArgs(inputPath: string): string[] {
  return [
    "-hide_banner",
    "-loglevel",
    "error",
    "-select_streams",
    "a:0",
    "-show_entries",
    "stream=codec_type",
    "-of",
    "csv=p=0",
    inputPath,
  ];
}

/**
 * Builds ffmpeg arguments that extract the first audio stream to PCM WAV.
 *
 * Output is WAV because llama-server `input_audio` is decoded by miniaudio,
 * which accepts mp3, wav, and flac. Stream-copying AAC/Opus is not usable.
 *
 * @param inputPath - Absolute path of the source video.
 * @param outputPath - Absolute path of the WAV sidecar to write.
 * @returns ffmpeg argv excluding the executable.
 */
export function buildFfmpegExtractAudioArgs(inputPath: string, outputPath: string): string[] {
  return [
    "-hide_banner",
    "-loglevel",
    "error",
    "-nostdin",
    "-y",
    "-i",
    inputPath,
    "-vn",
    "-map",
    "0:a:0",
    "-c:a",
    "pcm_s16le",
    outputPath,
  ];
}

/**
 * Interprets ffprobe stdout from {@link buildFfprobeHasAudioArgs}.
 *
 * @param stdout - Raw ffprobe standard output.
 * @returns `true` when at least one audio stream was reported.
 */
export function ffprobeStdoutIndicatesAudio(stdout: string): boolean {
  return stdout.split(/\r?\n/).some((line) => {
    const trimmed = line.trim().toLowerCase();
    return trimmed === "audio" || trimmed.startsWith("audio,");
  });
}

/**
 * Resolves a cached WAV sidecar for a video, extracting at most once per file.
 *
 * Existing `{stem}.extracted-audio.wav` files are reused. Videos without an
 * audio stream write a `{stem}.no-audio` marker so later sends skip ffprobe.
 *
 * @param videoAbsPath - Absolute path of the stored video attachment.
 * @returns Absolute WAV path when audio exists, or `null` when it does not.
 */
export async function resolveVideoAudioSidecar(videoAbsPath: string): Promise<string | null> {
  const existing = inFlightSidecars.get(videoAbsPath);
  if (existing) return existing;

  const promise = resolveVideoAudioSidecarUncached(videoAbsPath).finally(() => {
    inFlightSidecars.delete(videoAbsPath);
  });
  inFlightSidecars.set(videoAbsPath, promise);
  return promise;
}

/**
 * Replaces the audio-stream probe used by {@link resolveVideoAudioSidecar}.
 *
 * @param impl - Replacement probe, or `null` to restore the ffprobe default.
 * @returns No return value.
 * @internal
 */
export function __setVideoAudioProbe(impl: VideoAudioProbeFn | null): void {
  probeImpl = impl ?? probeVideoHasAudioStream;
}

/**
 * Replaces the soundtrack extractor used by {@link resolveVideoAudioSidecar}.
 *
 * @param impl - Replacement extractor, or `null` to restore the ffmpeg default.
 * @returns No return value.
 * @internal
 */
export function __setVideoAudioExtract(impl: VideoAudioExtractFn | null): void {
  extractImpl = impl ?? extractVideoAudioTrack;
}

/**
 * Clears ffprobe path cache, in-flight sidecar work, and test overrides.
 *
 * @returns No return value.
 * @internal
 */
export function __resetVideoAudioState(): void {
  cachedFfprobePath = undefined;
  inFlightSidecars.clear();
  probeImpl = probeVideoHasAudioStream;
  extractImpl = extractVideoAudioTrack;
}

/**
 * Resolves one video's audio sidecar without coalescing concurrent callers.
 *
 * @param videoAbsPath - Absolute path of the stored video attachment.
 * @returns Absolute WAV path when audio exists, or `null` otherwise.
 */
async function resolveVideoAudioSidecarUncached(videoAbsPath: string): Promise<string | null> {
  const { audioPath, markerPath } = videoAudioSidecarPaths(videoAbsPath);

  if (await fileExistsNonEmpty(audioPath)) {
    logInfo(`[videoAudio] Reusing extracted soundtrack sidecar for ${videoAbsPath}`);
    return audioPath;
  }
  if (await fileExists(markerPath)) {
    return null;
  }

  const hasAudio = await probeImpl(videoAbsPath);
  if (hasAudio === false) {
    try {
      await Bun.write(markerPath, "");
    } catch (error) {
      logWarn("[videoAudio] Failed to write no-audio marker", {
        markerPath,
        error: error instanceof Error ? error.message : String(error),
      });
    }
    return null;
  }
  if (hasAudio !== true) {
    return null;
  }

  const extracted = await extractImpl(videoAbsPath, audioPath);
  if (!extracted) {
    await removeIfPresent(audioPath);
    return null;
  }
  if (await fileExistsNonEmpty(audioPath)) {
    logInfo(`[videoAudio] Extracted soundtrack sidecar for ${videoAbsPath}`);
    return audioPath;
  }
  return null;
}

/**
 * Probes a video container for an audio stream using ffprobe metadata.
 *
 * @param inputPath - Absolute path of the video to inspect.
 * @returns `true` when an audio stream exists, `false` when none exists, or `null` on probe failure.
 */
async function probeVideoHasAudioStream(inputPath: string): Promise<boolean | null> {
  const settings = await loadSettings();
  const ffprobe = await resolveFfprobePath(settings);
  if (!ffprobe) {
    logWarn("[videoAudio] ffprobe was not found; video soundtrack detection is unavailable.");
    return null;
  }

  const result = await runTimedCommand(
    [ffprobe, ...buildFfprobeHasAudioArgs(inputPath)],
    PROBE_TIMEOUT_MS,
  );
  if (result.exitCode === null) {
    return null;
  }
  if (result.exitCode !== 0) {
    logWarn("[videoAudio] ffprobe audio-stream probe failed", {
      inputPath,
      exitCode: result.exitCode,
      stderr: result.stderr.slice(0, 500),
    });
    return null;
  }
  return ffprobeStdoutIndicatesAudio(result.stdout);
}

/**
 * Extracts the first audio stream of a video to a PCM WAV sidecar.
 *
 * @param inputPath - Absolute path of the source video.
 * @param outputPath - Absolute path of the WAV file to write.
 * @returns `true` when ffmpeg exits successfully.
 */
async function extractVideoAudioTrack(inputPath: string, outputPath: string): Promise<boolean> {
  const settings = await loadSettings();
  const ffmpeg = await resolveFfmpegPath(settings);
  if (!ffmpeg) {
    logWarn("[videoAudio] ffmpeg was not found; video soundtrack extraction is unavailable.");
    return false;
  }

  await fs.mkdir(path.dirname(outputPath), { recursive: true });
  const result = await runTimedCommand(
    [ffmpeg, ...buildFfmpegExtractAudioArgs(inputPath, outputPath)],
    EXTRACT_TIMEOUT_MS,
  );
  if (result.exitCode === 0) {
    return true;
  }
  logWarn("[videoAudio] ffmpeg soundtrack extraction failed", {
    inputPath,
    outputPath,
    exitCode: result.exitCode,
    stderr: result.stderr.slice(0, 500),
  });
  return false;
}

/**
 * Resolves an ffprobe executable next to ffmpeg or on PATH.
 *
 * A missing executable is not cached, so installing ffprobe is picked up on the next video.
 *
 * @param settings - Application settings used to locate ffmpeg.
 * @returns Absolute or PATH-resolved ffprobe command, or `null` when unavailable.
 */
async function resolveFfprobePath(settings: AppSettings): Promise<string | null> {
  if (cachedFfprobePath) return cachedFfprobePath;

  const candidates: string[] = [];
  const ffmpeg = await resolveFfmpegPath(settings);
  if (ffmpeg) {
    candidates.push(ffprobeCommandFromFfmpeg(ffmpeg));
  }
  const exe = process.platform === "win32" ? "ffprobe.exe" : "ffprobe";
  candidates.push("ffprobe", exe);
  if (settings.llamaServerPath) {
    candidates.push(path.join(path.dirname(settings.llamaServerPath), exe));
  }

  const unique = [...new Set(candidates)];
  for (const candidate of unique) {
    if (await commandSupportsVersion(candidate)) {
      cachedFfprobePath = candidate;
      return candidate;
    }
  }

  return null;
}

/**
 * Probes whether a command understands `-hide_banner -version`.
 *
 * @param command - Candidate executable path or PATH name.
 * @returns `true` when the process exits successfully.
 */
async function commandSupportsVersion(command: string): Promise<boolean> {
  const result = await runTimedCommand([command, "-hide_banner", "-version"], VERSION_TIMEOUT_MS);
  return result.exitCode === 0;
}

/**
 * Spawns a process, captures stdio, and kills it if it exceeds `timeoutMs`.
 *
 * @param cmd - Executable and arguments.
 * @param timeoutMs - Kill timeout in milliseconds.
 * @returns Captured exit code and stdio, with `exitCode` null when spawn fails.
 */
async function runTimedCommand(cmd: string[], timeoutMs: number): Promise<TimedCommandResult> {
  try {
    const proc = spawn({
      cmd,
      stdout: "pipe",
      stderr: "pipe",
      windowsHide: true,
    });
    const timeout = setTimeout(() => {
      try {
        proc.kill();
      } catch {
        // Already exited.
      }
    }, timeoutMs);
    try {
      const [stdout, stderr, exitCode] = await Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
        proc.exited,
      ]);
      return { exitCode, stdout, stderr };
    } finally {
      clearTimeout(timeout);
    }
  } catch {
    return { exitCode: null, stdout: "", stderr: "" };
  }
}

/**
 * Returns whether a path exists on disk.
 *
 * @param absPath - Absolute filesystem path.
 * @returns `true` when the file exists.
 */
async function fileExists(absPath: string): Promise<boolean> {
  try {
    return await Bun.file(absPath).exists();
  } catch {
    return false;
  }
}

/**
 * Returns whether a path exists and contains at least one byte.
 *
 * @param absPath - Absolute filesystem path.
 * @returns `true` when the file exists and is non-empty.
 */
async function fileExistsNonEmpty(absPath: string): Promise<boolean> {
  try {
    const file = Bun.file(absPath);
    return (await file.exists()) && file.size > 0;
  } catch {
    return false;
  }
}

/**
 * Deletes a path when present, ignoring missing-file errors.
 *
 * @param absPath - Absolute filesystem path to remove.
 * @returns No return value.
 */
async function removeIfPresent(absPath: string): Promise<void> {
  try {
    await fs.unlink(absPath);
  } catch {
    // Missing output is the desired state after a failed extract.
  }
}
