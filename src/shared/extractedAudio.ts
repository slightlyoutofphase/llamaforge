/**
 * @packageDocumentation
 * Shared helpers for identifying video-extracted soundtrack attachments.
 */

/** Filename suffix for a PCM WAV soundtrack extracted from a video attachment. */
export const EXTRACTED_AUDIO_SUFFIX = ".extracted-audio.wav";

/** Filename suffix for a marker recording that a video has no audio stream. */
export const NO_AUDIO_MARKER_SUFFIX = ".no-audio";

/**
 * Returns whether an attachment is a cached video soundtrack rather than a
 * user-uploaded audio file.
 *
 * Matching uses the stored path or original filename so branched copies that
 * keep `{videoStem}.extracted-audio.wav` still count as soundtracks.
 *
 * @param attachment - Attachment metadata to inspect.
 * @returns `true` when this row is an extracted video soundtrack.
 */
export function isExtractedVideoAudioAttachment(attachment: {
  mimeType: string;
  filePath: string;
  fileName: string;
}): boolean {
  if (!attachment.mimeType.startsWith("audio/")) return false;
  const pathNorm = attachment.filePath.replaceAll("\\", "/");
  return (
    pathNorm.includes(EXTRACTED_AUDIO_SUFFIX) ||
    attachment.fileName.endsWith(EXTRACTED_AUDIO_SUFFIX)
  );
}

/**
 * Returns the video file stem a soundtrack sidecar or no-audio marker belongs to.
 *
 * `uuid.extracted-audio.wav` and `uuid.no-audio` both map to `uuid`, matching
 * the stored video `uuid.mp4`. `path.parse` is not used because it would treat
 * `.extracted-audio` as part of the stem.
 *
 * @param fileName - Basename of a file in an attachment directory.
 * @returns Video stem, or `null` when the name is not a video-audio sidecar.
 */
export function videoAudioSidecarOwnerStem(fileName: string): string | null {
  if (fileName.endsWith(EXTRACTED_AUDIO_SUFFIX)) {
    return fileName.slice(0, -EXTRACTED_AUDIO_SUFFIX.length);
  }
  if (fileName.endsWith(NO_AUDIO_MARKER_SUFFIX)) {
    return fileName.slice(0, -NO_AUDIO_MARKER_SUFFIX.length);
  }
  return null;
}
