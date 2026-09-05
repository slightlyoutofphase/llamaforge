/**
 * @packageDocumentation
 * Tests for extracted-video soundtrack attachment identity helpers.
 */

import { describe, expect, it } from "bun:test";
import {
  EXTRACTED_AUDIO_SUFFIX,
  isExtractedVideoAudioAttachment,
  videoAudioSidecarOwnerStem,
} from "../../src/shared/extractedAudio";

describe("extractedAudio", () => {
  it("recognizes soundtrack rows by path or original filename", () => {
    expect(
      isExtractedVideoAudioAttachment({
        mimeType: "audio/wav",
        filePath: `attachments/c/m/clip${EXTRACTED_AUDIO_SUFFIX}`,
        fileName: `clip${EXTRACTED_AUDIO_SUFFIX}`,
      }),
    ).toBe(true);
    expect(
      isExtractedVideoAudioAttachment({
        mimeType: "audio/wav",
        filePath: "attachments/c/m/random.wav",
        fileName: `clip${EXTRACTED_AUDIO_SUFFIX}`,
      }),
    ).toBe(true);
    expect(
      isExtractedVideoAudioAttachment({
        mimeType: "audio/wav",
        filePath: "attachments/c/m/voice.wav",
        fileName: "voice.wav",
      }),
    ).toBe(false);
  });

  it("maps sidecar filenames back to the parent video stem", () => {
    expect(videoAudioSidecarOwnerStem(`clip${EXTRACTED_AUDIO_SUFFIX}`)).toBe("clip");
    expect(videoAudioSidecarOwnerStem("clip.no-audio")).toBe("clip");
    expect(videoAudioSidecarOwnerStem("clip.mp4")).toBeNull();
  });
});
