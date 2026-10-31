/**
 * @packageDocumentation
 * Tests for video soundtrack probing, WAV sidecar caching, and path helpers.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { initDb, resetDb } from "../../src/server/persistence/db";
import {
  __expireFfprobeMissForTests,
  __ffprobeSearchCount,
  __resetVideoAudioState,
  __setFfprobeAvailabilityForTests,
  __setVideoAudioExtract,
  __setVideoAudioProbe,
  buildFfmpegExtractAudioArgs,
  buildFfprobeHasAudioArgs,
  EXTRACTED_AUDIO_SUFFIX,
  ffprobeCommandFromFfmpeg,
  ffprobeStdoutIndicatesAudio,
  isExtractedVideoAudioAttachment,
  NO_AUDIO_MARKER_SUFFIX,
  resolveVideoAudioSidecar,
  videoAudioSidecarCopyPlan,
  videoProbeFailedMarkerPath,
  videoAudioSidecarOwnerStem,
  videoAudioSidecarPaths,
} from "../../src/server/videoAudio";

describe("videoAudio", () => {
  let tmpDir: string;

  beforeEach(async () => {
    await initDb(":memory:");
    __resetVideoAudioState();
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "llamaforge-video-audio-"));
  });

  afterEach(async () => {
    __resetVideoAudioState();
    resetDb();
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it("identifies extracted soundtrack attachments by path or original filename", () => {
    expect(
      isExtractedVideoAudioAttachment({
        mimeType: "audio/wav",
        filePath: "attachments/c/m/clip.extracted-audio.wav",
        fileName: "clip.extracted-audio.wav",
      }),
    ).toBe(true);
    expect(
      isExtractedVideoAudioAttachment({
        mimeType: "audio/wav",
        filePath: "attachments/c/m/uuid.wav",
        fileName: "clip.extracted-audio.wav",
      }),
    ).toBe(true);
    expect(
      isExtractedVideoAudioAttachment({
        mimeType: "audio/wav",
        filePath: "attachments/c/m/voice.wav",
        fileName: "voice.wav",
      }),
    ).toBe(false);
    expect(
      isExtractedVideoAudioAttachment({
        mimeType: "video/mp4",
        filePath: "attachments/c/m/clip.extracted-audio.wav",
        fileName: "clip.extracted-audio.wav",
      }),
    ).toBe(false);
  });

  it("maps sidecar filenames back to the parent video stem", () => {
    expect(videoAudioSidecarOwnerStem("clip.extracted-audio.wav")).toBe("clip");
    expect(videoAudioSidecarOwnerStem("clip.no-audio")).toBe("clip");
    expect(videoAudioSidecarOwnerStem("clip.mp4")).toBeNull();
    expect(videoAudioSidecarOwnerStem("voice.wav")).toBeNull();
  });

  it("derives WAV and no-audio marker paths from the video stem", () => {
    const videoPath = path.join(tmpDir, "clip.mp4");
    const sidecars = videoAudioSidecarPaths(videoPath);
    expect(sidecars.audioPath).toBe(path.join(tmpDir, `clip${EXTRACTED_AUDIO_SUFFIX}`));
    expect(sidecars.markerPath).toBe(path.join(tmpDir, `clip${NO_AUDIO_MARKER_SUFFIX}`));
  });

  it("plans sidecar copies that follow a renamed video stem", () => {
    const oldVideo = path.join(tmpDir, "old", "uuid-a.mp4");
    const newVideo = path.join(tmpDir, "new", "uuid-b.mp4");
    const plan = videoAudioSidecarCopyPlan(oldVideo, newVideo);
    expect(plan).toEqual([
      {
        oldPath: path.join(tmpDir, "old", `uuid-a${EXTRACTED_AUDIO_SUFFIX}`),
        newPath: path.join(tmpDir, "new", `uuid-b${EXTRACTED_AUDIO_SUFFIX}`),
      },
      {
        oldPath: path.join(tmpDir, "old", `uuid-a${NO_AUDIO_MARKER_SUFFIX}`),
        newPath: path.join(tmpDir, "new", `uuid-b${NO_AUDIO_MARKER_SUFFIX}`),
      },
    ]);
  });

  it("maps a PATH ffmpeg command to a PATH ffprobe command", () => {
    const expected = process.platform === "win32" ? "ffprobe.exe" : "ffprobe";
    expect(ffprobeCommandFromFfmpeg("ffmpeg")).toBe(expected);
    expect(ffprobeCommandFromFfmpeg("ffmpeg.exe")).toBe(expected);
  });

  it("maps an absolute ffmpeg path to a sibling ffprobe binary", () => {
    const ffmpegPath = process.platform === "win32" ? "C:\\tools\\ffmpeg.exe" : "/opt/bin/ffmpeg";
    const expected = process.platform === "win32" ? "C:\\tools\\ffprobe.exe" : "/opt/bin/ffprobe";
    expect(ffprobeCommandFromFfmpeg(ffmpegPath)).toBe(expected);
  });

  it("builds a metadata-only ffprobe invocation for the first audio stream", () => {
    const args = buildFfprobeHasAudioArgs("/tmp/clip.mp4");
    expect(args).toContain("-select_streams");
    expect(args[args.indexOf("-select_streams") + 1]).toBe("a:0");
    expect(args).toContain("stream=codec_type");
    expect(args.at(-1)).toBe("/tmp/clip.mp4");
    expect(args.includes("-i")).toBe(false);
  });

  it("builds an ffmpeg extract that writes PCM WAV without video", () => {
    const args = buildFfmpegExtractAudioArgs("/tmp/clip.mp4", "/tmp/clip.extracted-audio.wav");
    expect(args[args.indexOf("-i") + 1]).toBe("/tmp/clip.mp4");
    expect(args).toContain("-vn");
    expect(args).toContain("0:a:0");
    expect(args).toContain("pcm_s16le");
    expect(args.at(-1)).toBe("/tmp/clip.extracted-audio.wav");
  });

  it("treats ffprobe codec_type output as audio only when a stream is reported", () => {
    expect(ffprobeStdoutIndicatesAudio("")).toBe(false);
    expect(ffprobeStdoutIndicatesAudio("\n")).toBe(false);
    expect(ffprobeStdoutIndicatesAudio("video")).toBe(false);
    expect(ffprobeStdoutIndicatesAudio("audio")).toBe(true);
    expect(ffprobeStdoutIndicatesAudio("audio\n")).toBe(true);
    expect(ffprobeStdoutIndicatesAudio("AUDIO")).toBe(true);
  });

  it("reuses an existing non-empty WAV sidecar without probing", async () => {
    const videoPath = path.join(tmpDir, "cached.mp4");
    await Bun.write(videoPath, "video");
    const { audioPath } = videoAudioSidecarPaths(videoPath);
    await Bun.write(audioPath, "wav-bytes");

    let probed = 0;
    __setVideoAudioProbe(async () => {
      probed += 1;
      return true;
    });
    __setVideoAudioExtract(async () => {
      throw new Error("extract should not run when a sidecar already exists");
    });

    expect(await resolveVideoAudioSidecar(videoPath)).toBe(audioPath);
    expect(probed).toBe(0);
  });

  it("does not reuse an empty WAV sidecar and extracts again", async () => {
    const videoPath = path.join(tmpDir, "empty.mp4");
    await Bun.write(videoPath, "video");
    const { audioPath } = videoAudioSidecarPaths(videoPath);
    await Bun.write(audioPath, "");
    __setVideoAudioProbe(async () => true);
    __setVideoAudioExtract(async (_input, output) => {
      await Bun.write(output, "wav-bytes");
      return true;
    });

    expect(await resolveVideoAudioSidecar(videoPath)).toBe(audioPath);
    expect(await Bun.file(audioPath).text()).toBe("wav-bytes");
  });

  it("skips probing when a no-audio marker already exists", async () => {
    const videoPath = path.join(tmpDir, "silent.mp4");
    await Bun.write(videoPath, "video");
    const { markerPath } = videoAudioSidecarPaths(videoPath);
    await Bun.write(markerPath, "");

    __setVideoAudioProbe(async () => {
      throw new Error("probe should not run when a no-audio marker exists");
    });

    expect(await resolveVideoAudioSidecar(videoPath)).toBeNull();
  });

  it("writes a no-audio marker after a negative probe and does not extract", async () => {
    const videoPath = path.join(tmpDir, "no-track.mp4");
    await Bun.write(videoPath, "video");
    let extracted = 0;
    __setVideoAudioProbe(async () => false);
    __setVideoAudioExtract(async () => {
      extracted += 1;
      return false;
    });

    expect(await resolveVideoAudioSidecar(videoPath)).toBeNull();
    expect(extracted).toBe(0);
    expect(await Bun.file(videoAudioSidecarPaths(videoPath).markerPath).exists()).toBe(true);

    __setVideoAudioProbe(async () => {
      throw new Error("second resolve should use the marker instead of probing");
    });
    expect(await resolveVideoAudioSidecar(videoPath)).toBeNull();
  });

  it("does not write a no-audio marker when the probe fails", async () => {
    const videoPath = path.join(tmpDir, "unknown.mp4");
    await Bun.write(videoPath, "video");
    __setVideoAudioProbe(async () => null);
    __setVideoAudioExtract(async () => {
      throw new Error("extract should not run after a failed probe");
    });

    expect(await resolveVideoAudioSidecar(videoPath)).toBeNull();
    expect(await Bun.file(videoAudioSidecarPaths(videoPath).markerPath).exists()).toBe(false);
  });

  it("writes a probe-failed marker and does not probe that file again", async () => {
    const videoPath = path.join(tmpDir, "broken.mp4");
    await Bun.write(videoPath, "video");
    __setFfprobeAvailabilityForTests("present");
    let probed = 0;
    __setVideoAudioProbe(async () => {
      probed += 1;
      return null;
    });

    expect(await resolveVideoAudioSidecar(videoPath)).toBeNull();
    expect(probed).toBe(1);
    expect(await Bun.file(videoProbeFailedMarkerPath(videoPath)).exists()).toBe(true);

    __setVideoAudioProbe(async () => {
      throw new Error("probe should not run while the failure marker is current");
    });
    expect(await resolveVideoAudioSidecar(videoPath)).toBeNull();
  });

  it("searches for a missing ffprobe again only after the miss expires", async () => {
    const videoPath = path.join(tmpDir, "unprobed.mp4");
    await Bun.write(videoPath, "video");
    __setFfprobeAvailabilityForTests("missing");

    expect(await resolveVideoAudioSidecar(videoPath)).toBeNull();
    const searches = __ffprobeSearchCount();
    expect(searches).toBeGreaterThan(0);
    expect(await resolveVideoAudioSidecar(videoPath)).toBeNull();
    expect(__ffprobeSearchCount()).toBe(searches);

    __expireFfprobeMissForTests();
    expect(await resolveVideoAudioSidecar(videoPath)).toBeNull();
    expect(__ffprobeSearchCount()).toBeGreaterThan(searches);
    expect(await Bun.file(videoProbeFailedMarkerPath(videoPath)).exists()).toBe(false);
  });

  it("extracts a WAV sidecar once after a positive probe", async () => {
    const videoPath = path.join(tmpDir, "talking.mp4");
    await Bun.write(videoPath, "video");
    const { audioPath } = videoAudioSidecarPaths(videoPath);
    let probed = 0;
    let extracted = 0;
    __setVideoAudioProbe(async () => {
      probed += 1;
      return true;
    });
    __setVideoAudioExtract(async (_input, output) => {
      extracted += 1;
      await Bun.write(output, "wav-bytes");
      return true;
    });

    expect(await resolveVideoAudioSidecar(videoPath)).toBe(audioPath);
    expect(await Bun.file(audioPath).text()).toBe("wav-bytes");
    expect(await resolveVideoAudioSidecar(videoPath)).toBe(audioPath);
    expect(probed).toBe(1);
    expect(extracted).toBe(1);
  });

  it("coalesces concurrent resolves so the same file is probed only once", async () => {
    const videoPath = path.join(tmpDir, "race.mp4");
    await Bun.write(videoPath, "video");
    const { audioPath } = videoAudioSidecarPaths(videoPath);
    let probed = 0;
    __setVideoAudioProbe(async () => {
      probed += 1;
      await Bun.sleep(25);
      return true;
    });
    __setVideoAudioExtract(async (_input, output) => {
      await Bun.write(output, "wav-bytes");
      return true;
    });

    const [first, second] = await Promise.all([
      resolveVideoAudioSidecar(videoPath),
      resolveVideoAudioSidecar(videoPath),
    ]);
    expect(first).toBe(audioPath);
    expect(second).toBe(audioPath);
    expect(probed).toBe(1);
  });
});
