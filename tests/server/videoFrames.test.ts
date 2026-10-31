/**
 * @packageDocumentation
 * Tests for ffmpeg frame-extraction helpers.
 */

import { describe, expect, it } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  buildFfmpegFrameArgs,
  extractVideoFrames,
  MAX_VIDEO_FRAMES,
  videoFrameFileName,
  videoFrameOutputPattern,
} from "../../src/server/videoFrames";

describe("videoFrames", () => {
  it("builds ffmpeg arguments that cap sampled JPEG stills", () => {
    const args = buildFfmpegFrameArgs("/tmp/clip.mp4", "/tmp/video-frame-%03d.jpg");
    expect(args).toContain("-i");
    expect(args[args.indexOf("-i") + 1]).toBe("/tmp/clip.mp4");
    expect(args).toContain("-frames:v");
    expect(args[args.indexOf("-frames:v") + 1]).toBe(String(MAX_VIDEO_FRAMES));
    expect(args.at(-1)).toBe("/tmp/video-frame-%03d.jpg");
  });

  it("names extracted frames with a stable zero-padded prefix", () => {
    expect(videoFrameFileName("clip", 1)).toBe("clip.frame-001.jpg");
    expect(videoFrameFileName("clip", 16)).toBe("clip.frame-016.jpg");
    expect(videoFrameOutputPattern("100%")).toBe("100%%.frame-%03d.jpg");
  });

  it("keeps each video's frames separate, including a stem with regex characters", async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "llamaforge-frames-"));
    try {
      const clip = path.join(directory, "clip.frame-001.jpg");
      const special = path.join(directory, "a+b (1).frame-001.jpg");
      const specialNext = path.join(directory, "a+b (1).frame-002.jpg");
      const neighbor = path.join(directory, "a+b (12).frame-001.jpg");
      await Bun.write(clip, "clip");
      await Bun.write(special, "special");
      await Bun.write(specialNext, "special-2");
      await Bun.write(neighbor, "neighbor");

      const clipFrames = await extractVideoFrames(path.join(directory, "clip.mp4"), directory);
      const specialFrames = await extractVideoFrames(
        path.join(directory, "a+b (1).mp4"),
        directory,
      );

      expect(clipFrames).toEqual([clip]);
      expect(specialFrames).toEqual([special, specialNext]);
    } finally {
      await fs.rm(directory, { recursive: true, force: true });
    }
  });
});
