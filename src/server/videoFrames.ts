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
 * Builds the JPEG filename used for an extracted video frame.
 *
 * @param index - 1-based frame index.
 * @returns File name such as `video-frame-001.jpg`.
 */
export function videoFrameFileName(index: number): string {
  return `video-frame-${String(index).padStart(3, "0")}.jpg`;
}

/**
 * Lists existing extracted JPEG frames in a directory.
 *
 * @param directory - Directory that may already contain `video-frame-*.jpg` files.
 * @returns Absolute paths sorted by frame index.
 */
export async function listExistingVideoFrames(directory: string): Promise<string[]> {
  try {
    const entries = await fs.readdir(directory);
    return entries
      .filter((name) => /^video-frame-\d{3}\.jpg$/i.test(name))
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
 * Existing `video-frame-*.jpg` files in `outputDir` are reused so regeneration
 * does not spawn ffmpeg again.
 *
 * @param inputPath - Absolute path of the source video.
 * @param outputDir - Directory that will receive JPEG frames.
 * @returns Absolute JPEG paths, or an empty array when extraction fails.
 */
export async function extractVideoFrames(inputPath: string, outputDir: string): Promise<string[]> {
  const existing = await listExistingVideoFrames(outputDir);
  if (existing.length > 0) return existing;

  const settings = await loadSettings();
  const ffmpeg = await resolveFfmpegPath(settings);
  if (!ffmpeg) {
    logWarn("[videoFrames] ffmpeg was not found; video attachments cannot be sampled into stills.");
    return [];
  }

  await fs.mkdir(outputDir, { recursive: true });
  const outputPattern = path.join(outputDir, "video-frame-%03d.jpg");
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

  return listExistingVideoFrames(outputDir);
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
