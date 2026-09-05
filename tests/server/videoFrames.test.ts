/**
 * @packageDocumentation
 * Tests for ffmpeg frame-extraction helpers.
 */

import { describe, expect, it } from "bun:test";
import {
  buildFfmpegFrameArgs,
  MAX_VIDEO_FRAMES,
  videoFrameFileName,
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
    expect(videoFrameFileName(1)).toBe("video-frame-001.jpg");
    expect(videoFrameFileName(16)).toBe("video-frame-016.jpg");
  });
});
