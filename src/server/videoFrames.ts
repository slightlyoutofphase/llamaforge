/**
 * @packageDocumentation
 * Extracts still frames from uploaded videos so inference can avoid llama.cpp's
 * Windows ffmpeg-pipe deadlock on `input_video`.
 */

import fs from "node:fs/promises";
import path from "node:path";
import { spawn } from "bun";
import type { AppSettings } from "../shared/types";
import { logWarn } from "./logger";
import { loadSettings } from "./persistence/settingsRepo";

/** Maximum number of JPEG frames sampled from a single video attachment. */
export const MAX_VIDEO_FRAMES = 16;

let cachedFfmpegPath: string | null | undefined;

/**
 * Builds ffmpeg arguments that sample up to {@link MAX_VIDEO_FRAMES} JPEG stills.
 *
 * @param inputPath - Absolute path of the source video.
 * @param outputPattern - ffmpeg output pattern, e.g. `frame-%03d.jpg`.
 * @returns ffmpeg argv excluding the executable.
 */
export function buildFfmpegFrameArgs(inputPath: string, outputPattern: string): string[] {
  return [
    "-hide_banner",
    "-loglevel",
    "error",
    "-nostdin",
    "-y",
    "-i",
    inputPath,
    "-vf",
    `fps=1,scale='min(1280,iw)':-2`,
    "-q:v",
    "3",
    "-frames:v",
    String(MAX_VIDEO_FRAMES),
    outputPattern,
  ];
}

/**
 * Uses a non-empty file stem so a nameless video still gets a flat frame file.
 *
 * @param stem - `path.parse` name of the source video.
 * @returns The stem, or `video` when the source name is blank.
 */
function frameStem(stem: string): string {
  const trimmed = stem.trim();
  return trimmed.length > 0 ? trimmed : "video";
}

/**
 * Escapes a file stem so it can be matched literally in a regular expression.
 *
 * @param value - Stem that may contain characters such as `+` or `(`.
 * @returns The stem with regex metacharacters escaped.
 */
function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Builds the JPEG filename used for an extracted video frame.
 *
 * @param stem - File stem of the source video, without its extension.
 * @param index - 1-based frame index.
 * @returns File name such as `clip.frame-001.jpg`.
 */
export function videoFrameFileName(stem: string, index: number): string {
  return `${frameStem(stem)}.frame-${String(index).padStart(3, "0")}.jpg`;
}

/**
 * Builds the ffmpeg output pattern for one video's frames.
 *
 * Percent signs in the stem are doubled so ffmpeg treats them as literal characters.
 *
 * @param stem - File stem of the source video, without its extension.
 * @returns A pattern such as `clip.frame-%03d.jpg`.
 */
export function videoFrameOutputPattern(stem: string): string {
  return `${frameStem(stem).replaceAll("%", "%%")}.frame-%03d.jpg`;
}

/**
 * Lists existing extracted JPEG frames for one video in a directory.
 *
 * @param directory - Message folder that may already contain frame files.
 * @param stem - File stem of the source video, without its extension.
 * @returns Absolute paths for that video only, sorted by frame index.
 */
export async function listExistingVideoFrames(directory: string, stem: string): Promise<string[]> {
  const pattern = new RegExp(`^${escapeRegExp(frameStem(stem))}\\.frame-\\d{3}\\.jpg$`, "i");
  try {
    const entries = await fs.readdir(directory);
    return entries
      .filter((name) => pattern.test(name))
      .sort()
      .map((name) => path.join(directory, name));
  } catch {
    return [];
  }
}

/**
 * Resolves an ffmpeg executable from settings, PATH, or the llama-server directory.
 *
 * A missing executable is not cached, so installing ffmpeg is picked up on the next video.
 *
 * @param settings - Application settings that may include a llama-server path.
 * @returns Absolute or PATH-resolved ffmpeg command, or `null` when unavailable.
 */
export async function resolveFfmpegPath(settings: AppSettings): Promise<string | null> {
  if (cachedFfmpegPath) return cachedFfmpegPath;

  const exe = process.platform === "win32" ? "ffmpeg.exe" : "ffmpeg";
  const candidates: string[] = ["ffmpeg", exe];
  if (settings.llamaServerPath) {
    candidates.push(path.join(path.dirname(settings.llamaServerPath), exe));
  }

  for (const candidate of candidates) {
    if (await ffmpegExists(candidate)) {
      cachedFfmpegPath = candidate;
      return candidate;
    }
  }

  return null;
}

/**
 * Probes whether an ffmpeg executable can be launched.
 *
 * @param command - Candidate ffmpeg path.
 * @returns `true` when `ffmpeg -version` exits successfully.
 */
async function ffmpegExists(command: string): Promise<boolean> {
  try {
    const proc = spawn([command, "-hide_banner", "-version"], {
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
    }, 4000);
    try {
      const [, exitCode] = await Promise.all([
        new Response(proc.stdout).text(),
        proc.exited,
        new Response(proc.stderr).text(),
      ]);
      return exitCode === 0;
    } finally {
      clearTimeout(timeout);
    }
  } catch {
    return false;
  }
}

/**
 * Extracts evenly paced JPEG frames from a video file using ffmpeg.
 *
 * Frames already extracted for this video's stem are reused. Another video in the
 * same folder keeps its own `stem.frame-NNN.jpg` files.
 *
 * @param inputPath - Absolute path of the source video.
 * @param outputDir - Directory that will receive JPEG frames.
 * @returns Absolute JPEG paths, or an empty array when extraction fails.
 */
export async function extractVideoFrames(inputPath: string, outputDir: string): Promise<string[]> {
  const stem = path.parse(inputPath).name;
  const existing = await listExistingVideoFrames(outputDir, stem);
  if (existing.length > 0) return existing;

  const settings = await loadSettings();
  const ffmpeg = await resolveFfmpegPath(settings);
  if (!ffmpeg) {
    logWarn("[videoFrames] ffmpeg was not found; video attachments cannot be sampled into stills.");
    return [];
  }

  await fs.mkdir(outputDir, { recursive: true });
  const outputPattern = path.join(outputDir, videoFrameOutputPattern(stem));
  const proc = spawn({
    cmd: [ffmpeg, ...buildFfmpegFrameArgs(inputPath, outputPattern)],
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
  }, 60_000);
  try {
    const [, stderr, exitCode] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    if (exitCode !== 0) {
      logWarn("[videoFrames] ffmpeg frame extraction failed", {
        inputPath,
        exitCode,
        stderr: stderr.slice(0, 500),
      });
      return [];
    }
  } finally {
    clearTimeout(timeout);
  }

  return listExistingVideoFrames(outputDir, stem);
}

/**
 * Clears the cached ffmpeg path. Intended for tests.
 *
 * @returns No return value.
 * @internal
 */
export function __resetFfmpegCache(): void {
  cachedFfmpegPath = undefined;
}
