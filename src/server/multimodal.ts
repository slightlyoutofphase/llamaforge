/**
 * @packageDocumentation
 * Handles multimodal data processing including attachment file storage, file URL construction, and PDF text extraction.
 */

import fs from "node:fs/promises";
import path from "node:path";
import type { Attachment, ChatMessage, GgufDisplayMetadata } from "../shared/types";
import { logInfo, logWarn } from "./logger";
import { getAppDataDir, getDb, resolveAppDataPath } from "./persistence/db";
import { loadSettings } from "./persistence/settingsRepo";
import {
  EXTRACTED_AUDIO_SUFFIX,
  isExtractedVideoAudioAttachment,
  resolveVideoAudioSidecar,
  videoAudioSidecarPaths,
} from "./videoAudio";
import { extractVideoFrames } from "./videoFrames";

const MAX_EXTRACTED_TEXT_CHARS_PER_ATTACHMENT = 12_000;
const MAX_EXTRACTED_TEXT_CHARS_PER_MESSAGE = 24_000;
const ATTACHMENT_TEXT_BUDGET_EXHAUSTED_NOTICE =
  "[Attachment text omitted: message attachment text budget exhausted.]";

let extractVideoFramesImpl: typeof extractVideoFrames = extractVideoFrames;
let resolveVideoAudioSidecarImpl: typeof resolveVideoAudioSidecar = resolveVideoAudioSidecar;
let allowPipedVideoOverride: boolean | null = null;
/**
 * When true, video attachments are sent as llama.cpp `input_video` parts,
 * matching `input_audio` / `image_url`. Set false to restore JPEG still
 * sampling (workaround for an older Windows mtmd ffmpeg-stdin deadlock).
 */
let preferNativeInputVideo = true;

/**
 * Overrides video-frame extraction for tests.
 *
 * @param impl - Replacement extractor, or `null` to restore the default.
 * @returns No return value.
 * @internal
 */
export function __setExtractVideoFrames(impl: typeof extractVideoFrames | null): void {
  extractVideoFramesImpl = impl ?? extractVideoFrames;
}

/**
 * Overrides video-soundtrack sidecar resolution for tests.
 *
 * @param impl - Replacement resolver, or `null` to restore the default.
 * @returns No return value.
 * @internal
 */
export function __setResolveVideoAudioSidecar(impl: typeof resolveVideoAudioSidecar | null): void {
  resolveVideoAudioSidecarImpl = impl ?? resolveVideoAudioSidecar;
}

/**
 * Overrides whether `input_video` piped-ffmpeg fallback is allowed.
 *
 * @param allow - Replacement flag, or `null` to restore the platform default.
 * @returns No return value.
 * @internal
 */
export function __setAllowPipedVideo(allow: boolean | null): void {
  allowPipedVideoOverride = allow;
}

/**
 * Overrides whether video attachments use native `input_video` instead of stills.
 *
 * @param value - Replacement flag, or `null` to restore the default (`true`).
 * @returns No return value.
 * @internal
 */
export function __setPreferNativeInputVideo(value: boolean | null): void {
  preferNativeInputVideo = value ?? true;
}

/**
 * Returns whether llama.cpp `input_video` may be used as a stills-path fallback.
 *
 * @returns `true` when a raw `input_video` part is a safe fallback.
 */
export function allowPipedVideoInput(): boolean {
  if (allowPipedVideoOverride !== null) return allowPipedVideoOverride;
  return process.platform !== "win32";
}

/**
 * Returns whether video attachments should be forwarded as `input_video` parts.
 *
 * @returns `true` when still-frame sampling is skipped.
 */
export function prefersNativeInputVideo(): boolean {
  return preferNativeInputVideo;
}

// S8 fix: in-memory cache for extracted PDF text to avoid re-parsing on every generation
type ResolvedAttachmentText = {
  text: string;
  originalLength: number;
  truncated: boolean;
};

const _attachmentTextCache = new Map<string, ResolvedAttachmentText>();
const _ATTACHMENT_CACHE_MAX_SIZE = 50;
const MAX_PDF_EXTRACTION_BYTES = 50 * 1024 * 1024;

function rememberAttachmentText(
  key: string,
  value: ResolvedAttachmentText,
): ResolvedAttachmentText {
  _attachmentTextCache.set(key, value);
  if (_attachmentTextCache.size > _ATTACHMENT_CACHE_MAX_SIZE) {
    const firstKey = _attachmentTextCache.keys().next().value;
    if (firstKey) _attachmentTextCache.delete(firstKey);
  }
  return value;
}

/**
 * Reads the major brand and compatible brands from an ISO BMFF `ftyp` box.
 *
 * @param bytes - File prefix that begins with a box size and `ftyp`.
 * @returns Brand strings, including the trailing space on brands such as `M4A `.
 */
function isoBmffBrands(bytes: Uint8Array): string[] {
  if (bytes.length < 12) return [];
  if (bytes[4] !== 0x66 || bytes[5] !== 0x74 || bytes[6] !== 0x79 || bytes[7] !== 0x70) {
    return [];
  }
  const brands = [
    String.fromCharCode(bytes[8] ?? 0, bytes[9] ?? 0, bytes[10] ?? 0, bytes[11] ?? 0),
  ];
  const declaredSize =
    ((bytes[0] ?? 0) << 24) | ((bytes[1] ?? 0) << 16) | ((bytes[2] ?? 0) << 8) | (bytes[3] ?? 0);
  const boxEnd = declaredSize >= 16 ? Math.min(bytes.length, declaredSize) : bytes.length;
  for (let offset = 16; offset + 4 <= boxEnd; offset += 4) {
    brands.push(
      String.fromCharCode(
        bytes[offset] ?? 0,
        bytes[offset + 1] ?? 0,
        bytes[offset + 2] ?? 0,
        bytes[offset + 3] ?? 0,
      ),
    );
  }
  return brands;
}

/**
 * Maps an ISO BMFF `ftyp` brand list to an image, audio, or video MIME type.
 *
 * @param bytes - File prefix containing the `ftyp` box.
 * @returns A specific MIME type, or `undefined` when the prefix is not `ftyp`.
 */
function mimeFromFtyp(bytes: Uint8Array): string | undefined {
  const brands = isoBmffBrands(bytes).map((brand) => brand.trim().toLowerCase());
  if (brands.length === 0) return undefined;
  if (brands.some((brand) => brand === "avif" || brand === "avis")) return "image/avif";
  if (
    brands.some((brand) => ["heic", "heix", "hevc", "hevx", "heif", "mif1", "msf1"].includes(brand))
  ) {
    return "image/heic";
  }
  if (brands.some((brand) => brand === "m4a" || brand === "m4b" || brand === "m4p")) {
    return "audio/mp4";
  }
  return "video/mp4";
}

/**
 * Reports whether a buffer is text that can be embedded in a prompt.
 *
 * NUL bytes and invalid UTF-8 are treated as binary so zip and office files
 * are not decoded into replacement characters.
 *
 * @param bytes - Full file contents.
 * @returns `true` when the buffer is empty or valid UTF-8 without NUL bytes.
 */
/**
 * Reads a stored attachment as bytes, including from test doubles that only
 * implement `arrayBuffer` or `text`.
 *
 * @param filePath - Absolute path of the stored file.
 * @returns The file contents.
 */
async function readStoredFileBytes(filePath: string): Promise<Uint8Array> {
  const file = Bun.file(filePath) as Blob & {
    bytes?: () => Promise<Uint8Array>;
    arrayBuffer: () => Promise<ArrayBuffer>;
    text: () => Promise<string>;
  };
  if (typeof file.bytes === "function") return file.bytes();
  try {
    return new Uint8Array(await file.arrayBuffer());
  } catch {
    return new TextEncoder().encode(await file.text());
  }
}

function isUtf8Text(bytes: Uint8Array): boolean {
  if (bytes.includes(0)) return false;
  try {
    new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    return true;
  } catch {
    return false;
  }
}

interface PdfTextDocument {
  numPages: number;
  getPage: (pageNumber: number) => Promise<{
    getTextContent: () => Promise<{ items: readonly { str?: string }[] }>;
  }>;
  destroy?: (() => void | Promise<void>) | undefined;
}

/**
 * Extracts text from a PDF and always releases the pdf.js document.
 *
 * @param data - PDF bytes.
 * @returns Concatenated page text.
 */
async function extractPdfText(data: Uint8Array): Promise<string> {
  const pdfjs = await import("pdfjs-dist");
  const doc = (await pdfjs.getDocument({ data }).promise) as PdfTextDocument;
  try {
    let fullText = "";
    for (let pageNumber = 1; pageNumber <= doc.numPages; pageNumber++) {
      const page = await doc.getPage(pageNumber);
      const content = await page.getTextContent();
      fullText += `${content.items
        .map((item) => (typeof item.str === "string" ? item.str : ""))
        .join(" ")}\n`;
    }
    return fullText;
  } finally {
    await releasePdfDocument(doc);
  }
}

/**
 * Releases a pdf.js document after text extraction.
 *
 * @param doc - Document returned by `getDocument`, which may not expose `destroy` in tests.
 * @returns A promise that resolves once cleanup finishes or is skipped.
 */
async function releasePdfDocument(doc: {
  destroy?: (() => void | Promise<void>) | undefined;
}): Promise<void> {
  if (typeof doc.destroy !== "function") return;
  try {
    await doc.destroy();
  } catch (err: unknown) {
    logWarn("PDF document cleanup failed", err);
  }
}

/**
 * Infers a MIME type from magic bytes, falling back to the client-supplied type.
 *
 * @param bytes - File prefix used for signature detection.
 * @param fallback - Client-supplied MIME type.
 * @returns Detected or fallback MIME type.
 */
function detectMimeFromMagic(bytes: Uint8Array, fallback: string): string {
  if (bytes.length >= 4) {
    if (bytes[0] === 0x25 && bytes[1] === 0x50 && bytes[2] === 0x44 && bytes[3] === 0x46) {
      return "application/pdf";
    }
    if (bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) {
      return "image/png";
    }
    if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
      return "image/jpeg";
    }
    if (bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46) {
      return "image/gif";
    }
    if (
      bytes.length >= 12 &&
      bytes[0] === 0x52 &&
      bytes[1] === 0x49 &&
      bytes[2] === 0x46 &&
      bytes[3] === 0x46
    ) {
      const brand = String.fromCharCode(
        bytes[8] ?? 0,
        bytes[9] ?? 0,
        bytes[10] ?? 0,
        bytes[11] ?? 0,
      );
      if (brand === "WEBP") return "image/webp";
      if (brand === "WAVE") return "audio/wav";
    }
    const ftypMime = mimeFromFtyp(bytes);
    if (ftypMime) return ftypMime;
    if (bytes[0] === 0x1a && bytes[1] === 0x45 && bytes[2] === 0xdf && bytes[3] === 0xa3) {
      return "video/webm";
    }
  }
  return fallback || "application/octet-stream";
}

/**
 * Normalizes an attachment path stored in persistence into a safe POSIX-relative path.
 *
 * @param relativePath - Attachment path as stored in the database.
 * @returns A normalized relative path, or `null` when the path is unsafe.
 */
function normalizeStoredAttachmentPath(relativePath: string): string | null {
  if (!relativePath || typeof relativePath !== "string") return null;
  if (path.isAbsolute(relativePath)) return null;
  const normalized = path.posix.normalize(relativePath.replace(/\\/g, "/"));
  if (normalized === ".." || normalized.startsWith("../") || normalized.startsWith("/")) {
    return null;
  }

  return normalized;
}

/**
 * Resolves a stored attachment path back to an absolute filesystem path under the app root.
 *
 * @param relativePath - Persisted attachment path relative to `.llamaforge`.
 * @returns The absolute attachment path, or `null` when the path escapes the app root.
 */
export function resolveStoredAttachmentPath(relativePath: string): string | null {
  const normalized = normalizeStoredAttachmentPath(relativePath);
  if (!normalized) return null;

  const appRoot = getAppDataDir();
  const absPath = path.join(appRoot, ...normalized.split("/"));
  const relative = path.relative(appRoot, absPath);
  if (relative.startsWith("..") || path.isAbsolute(relative)) return null;
  return absPath;
}

/**
 * Converts a stored attachment path into the `file://` URL form accepted by llama-server media loading.
 *
 * @param relativePath - Persisted attachment path relative to `.llamaforge`.
 * @returns A relative `file://` URL, or `null` when the stored path is unsafe.
 */
function toLocalMediaUrl(relativePath: string): string | null {
  const normalized = normalizeStoredAttachmentPath(relativePath);
  return normalized ? `file://${normalized}` : null;
}

/**
 * Converts an absolute path under the app data root into a `file://` URL relative
 * to llama-server's `--media-path`.
 *
 * @param absPath - Absolute filesystem path.
 * @returns Relative `file://` URL, or `null` when the path escapes the app root.
 */
function toMediaPathUrlFromAbsolute(absPath: string): string | null {
  const appRoot = getAppDataDir();
  const relative = path.relative(appRoot, absPath).split(path.sep).join("/");
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) return null;
  return toLocalMediaUrl(relative);
}

/**
 * Interface for internal attachment processing.
 *
 * Attachments are stored by reference to their persisted filesystem path.
 * Binary data is only read transiently when building request payloads.
 */
export interface ProcessedAttachment extends Attachment {
  /** The text extracted from the file (for PDF and text files). */
  extractedText?: string;
  /** Original extracted character count before any budgeting. */
  extractedTextOriginalLength?: number;
  /** Whether the extracted text was truncated before or during prompt assembly. */
  extractedTextWasTruncated?: boolean;
}

/**
 * Applies the per-attachment extraction length cap to attachment text.
 *
 * @param text - Raw extracted attachment text.
 * @returns Normalized extraction text together with truncation metadata.
 */
function clampExtractedText(text: string): ResolvedAttachmentText {
  const normalized = text.replace(/\r\n/g, "\n").replace(/\0/g, "");
  const originalLength = normalized.length;
  if (originalLength <= MAX_EXTRACTED_TEXT_CHARS_PER_ATTACHMENT) {
    return {
      text: normalized,
      originalLength,
      truncated: false,
    };
  }

  return {
    text: normalized.slice(0, MAX_EXTRACTED_TEXT_CHARS_PER_ATTACHMENT).trimEnd(),
    originalLength,
    truncated: true,
  };
}

/**
 * Stores normalized extracted text metadata on a processed attachment.
 *
 * @param attachment - Attachment object that should receive extraction metadata.
 * @param extractedText - Raw extracted text prior to clamping.
 * @returns No return value.
 */
function assignExtractedText(attachment: ProcessedAttachment, extractedText: string): void {
  const clamped = clampExtractedText(extractedText);
  attachment.extractedText = clamped.text;
  attachment.extractedTextOriginalLength = clamped.originalLength;
  attachment.extractedTextWasTruncated = clamped.truncated;
  attachment.textTruncated = clamped.truncated;
}

/**
 * Wraps extracted attachment text in the textual block format appended to prompts.
 *
 * @param fileName - Original attachment filename.
 * @param body - Extracted text body to embed.
 * @param truncated - Whether the embedded text was truncated.
 * @param includedLength - Number of characters included in the prompt.
 * @param originalLength - Original extracted character count before truncation.
 * @returns A formatted attachment block ready to append to the prompt text.
 */
function formatAttachmentTextBlock(
  fileName: string,
  body: string,
  truncated: boolean,
  includedLength: number,
  originalLength: number,
): string {
  const truncationNote = truncated
    ? `\n[Attachment text truncated: kept ${includedLength} of ${originalLength} characters.]`
    : "";
  return `\n--- Attached file: ${fileName} ---\n${body}${truncationNote}\n--- End of file ---\n`;
}

/**
 * Appends attachment-derived text to a message using fixed per-attachment and per-message budgets.
 *
 * @param baseText - Existing message body.
 * @param attachments - Attachments with extracted text populated.
 * @returns Message text augmented with bounded attachment summaries.
 */
export function mergeExtractedAttachmentText(
  baseText: string,
  attachments: Array<Pick<Attachment, "fileName"> & Partial<ProcessedAttachment>>,
): string {
  let nextText = baseText;
  let remainingBudget = MAX_EXTRACTED_TEXT_CHARS_PER_MESSAGE;

  for (const attachment of attachments) {
    if (!attachment.extractedText) {
      continue;
    }

    if (remainingBudget <= 0) {
      nextText += formatAttachmentTextBlock(
        attachment.fileName,
        ATTACHMENT_TEXT_BUDGET_EXHAUSTED_NOTICE,
        false,
        0,
        attachment.extractedTextOriginalLength ?? attachment.extractedText.length,
      );
      continue;
    }

    const excerpt = attachment.extractedText.slice(0, remainingBudget);
    const includedLength = excerpt.length;
    const originalLength =
      attachment.extractedTextOriginalLength ?? attachment.extractedText.length;
    const truncated =
      Boolean(attachment.extractedTextWasTruncated) ||
      includedLength < attachment.extractedText.length;

    nextText += formatAttachmentTextBlock(
      attachment.fileName,
      excerpt,
      truncated,
      includedLength,
      originalLength,
    );
    remainingBudget = Math.max(0, remainingBudget - includedLength);
  }

  return nextText;
}

/**
 * Saves an uploaded file to the local attachments directory and extracts its content.
 *
 * @param chatId - The ID of the parent chat.
 * @param messageId - The ID of the message this attachment belongs to.
 * @param fileName - Original filename.
 * @param mimeType - Document MIME type.
 * @param buffer - File contents.
 * @returns A promise resolving to the {@link ProcessedAttachment}.
 * @throws {Error} If the file cannot be persisted or the attachment metadata cannot be stored.
 */
export async function processUpload(
  chatId: string,
  messageId: string,
  fileName: string,
  suppliedMimeType: string,
  buffer: ArrayBuffer,
): Promise<ProcessedAttachment> {
  const bytes = new Uint8Array(buffer);
  const mimeType = detectMimeFromMagic(bytes, suppliedMimeType);
  const appData = resolveAppDataPath("attachments", chatId, messageId);
  await fs.mkdir(appData, { recursive: true });

  const ext = path.extname(fileName) || "";
  const safeName = Bun.randomUUIDv7() + ext;
  const filePath = path.join(appData, safeName);

  await Bun.write(filePath, buffer);

  const relPath = path.relative(getAppDataDir(), filePath).split(path.sep).join("/");

  const attachment: ProcessedAttachment = {
    id: Bun.randomUUIDv7(),
    messageId,
    mimeType,
    filePath: relPath,
    fileName,
    createdAt: Date.now(),
  };

  // Convert/extract based on mime type
  if (mimeType === "application/pdf") {
    // M8 fix: skip extraction for very large PDFs to prevent OOM
    if (buffer.byteLength > MAX_PDF_EXTRACTION_BYTES) {
      logWarn(
        `[multimodal] PDF exceeds ${MAX_PDF_EXTRACTION_BYTES / (1024 * 1024)}MB limit for text extraction, skipping: ${fileName} (${(buffer.byteLength / (1024 * 1024)).toFixed(1)}MB)`,
      );
      assignExtractedText(
        attachment,
        `[PDF text extraction skipped: file size (${(buffer.byteLength / (1024 * 1024)).toFixed(1)}MB) exceeds the ${MAX_PDF_EXTRACTION_BYTES / (1024 * 1024)}MB extraction limit]`,
      );
    } else {
      try {
        assignExtractedText(attachment, await extractPdfText(new Uint8Array(buffer)));
      } catch (e) {
        logWarn("PDF extraction failed", e);
        assignExtractedText(
          attachment,
          `[Error extracting PDF text: ${e instanceof Error ? e.message : String(e)}]`,
        );
      }
    }
  } else if (
    !mimeType.startsWith("image/") &&
    !mimeType.startsWith("audio/") &&
    !mimeType.startsWith("video/")
  ) {
    if (isUtf8Text(bytes)) {
      assignExtractedText(attachment, new TextDecoder("utf-8").decode(buffer));
    } else {
      logWarn(`[multimodal] Skipping text extraction for non-UTF-8 file: ${fileName}`);
      if (!mimeType || mimeType === "application/octet-stream" || mimeType.startsWith("text/")) {
        attachment.mimeType = "application/octet-stream";
      }
    }
  }

  // NOTE: We no longer store base64Data in the attachment object permanently to save RAM.
  // Instead, the server will read the file from `relPath` when it needs to send it to the LLM.

  // Save to DB
  const stmt = getDb().prepare(
    "INSERT INTO attachments (id, message_id, mime_type, file_path, file_name, vir_budget, created_at, text_truncated) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
  );
  stmt.run(
    attachment.id,
    attachment.messageId,
    attachment.mimeType,
    attachment.filePath,
    attachment.fileName,
    attachment.virBudget || null,
    attachment.createdAt,
    attachment.textTruncated ? 1 : 0,
  );

  return attachment;
}

/**
 * Relative soundtrack path that sits beside a stored video attachment.
 *
 * @param videoRelativePath - Video `filePath` stored on the attachment row.
 * @returns Relative WAV path, or `null` when the video path is unsafe.
 */
function expectedSoundtrackRelativePath(videoRelativePath: string): string | null {
  const abs = resolveStoredAttachmentPath(videoRelativePath);
  if (!abs) return null;
  const audioAbs = videoAudioSidecarPaths(abs).audioPath;
  const rel = path.relative(getAppDataDir(), audioAbs).split(path.sep).join("/");
  if (!rel || rel.startsWith("..") || path.isAbsolute(rel)) return null;
  return rel;
}

/**
 * Finds a soundtrack attachment that already belongs to a video on the same message.
 *
 * @param attachments - Attachments currently associated with the message.
 * @param video - Video whose soundtrack should be located.
 * @returns Matching audio attachment, or `undefined` when none exists yet.
 */
function findExistingSoundtrack(
  attachments: readonly Attachment[],
  video: Attachment,
): Attachment | undefined {
  const expectedRel = expectedSoundtrackRelativePath(video.filePath);
  if (!expectedRel) return undefined;
  return attachments.find((attachment) => attachment.filePath === expectedRel);
}

/**
 * Inserts a cached video soundtrack as a real `attachments` row when missing.
 * The WAV file is not copied; the row points at the existing sidecar path.
 *
 * @param video - Parent video attachment.
 * @param audioAbs - Absolute path of the cached WAV.
 * @returns Attachment metadata for the soundtrack.
 */
function persistVideoSoundtrackAttachment(video: Attachment, audioAbs: string): Attachment {
  const relPath = path.relative(getAppDataDir(), audioAbs).split(path.sep).join("/");
  if (!relPath || relPath.startsWith("..") || path.isAbsolute(relPath)) {
    throw new Error(`Soundtrack path escaped the app data directory: ${audioAbs}`);
  }

  const videoStem = path.parse(video.fileName).name || path.parse(video.filePath).name;
  const fileName = `${videoStem}${EXTRACTED_AUDIO_SUFFIX}`;
  const db = getDb();
  const existing = db
    .query<
      {
        id: string;
        messageId: string;
        mimeType: string;
        filePath: string;
        fileName: string;
        virBudget: number | null;
        createdAt: number;
      },
      [string, string]
    >(
      "SELECT id, message_id as messageId, mime_type as mimeType, file_path as filePath, file_name as fileName, vir_budget as virBudget, created_at as createdAt FROM attachments WHERE message_id = ? AND file_path = ?",
    )
    .get(video.messageId, relPath);
  if (existing) {
    return {
      id: existing.id,
      messageId: existing.messageId,
      mimeType: existing.mimeType,
      filePath: existing.filePath,
      fileName: existing.fileName,
      createdAt: existing.createdAt,
      ...(existing.virBudget != null ? { virBudget: existing.virBudget } : {}),
    };
  }

  const attachment: Attachment = {
    id: Bun.randomUUIDv7(),
    messageId: video.messageId,
    mimeType: "audio/wav",
    filePath: relPath,
    fileName,
    createdAt: Date.now(),
  };

  const messageExists = db
    .query<{ id: string }, [string]>("SELECT id FROM messages WHERE id = ?")
    .get(video.messageId);
  if (!messageExists) {
    logWarn("Skipping soundtrack attachment persist because the parent message is missing", {
      messageId: video.messageId,
      filePath: relPath,
    });
    return attachment;
  }

  db.prepare(
    "INSERT INTO attachments (id, message_id, mime_type, file_path, file_name, vir_budget, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
  ).run(
    attachment.id,
    attachment.messageId,
    attachment.mimeType,
    attachment.filePath,
    attachment.fileName,
    null,
    attachment.createdAt,
  );
  logInfo(`Persisted extracted video soundtrack attachment ${relPath}`);
  return attachment;
}

/**
 * Extracts a video soundtrack and appends it to the in-memory message before
 * the single content-part build for this send.
 *
 * `buildContentParts` only reads attachments that are already present. This
 * function is the only caller that probes and inserts the soundtrack row.
 *
 * @param messages - Transcript that will be serialized once.
 * @param includeVideoAudio - Whether the loaded model should receive the wav.
 * @returns No return value.
 */
export async function attachPendingVideoSoundtracks(
  messages: readonly ChatMessage[],
  includeVideoAudio: boolean,
): Promise<void> {
  if (!includeVideoAudio) return;
  for (const message of messages) {
    const attachments = message.attachments;
    if (!attachments) continue;
    for (const video of attachments) {
      if (!video.mimeType.startsWith("video/")) continue;
      if (findExistingSoundtrack(attachments, video)) continue;
      const absolutePath = resolveStoredAttachmentPath(video.filePath);
      if (!absolutePath) continue;
      try {
        const audioAbsolute = await resolveVideoAudioSidecarImpl(absolutePath);
        if (!audioAbsolute) continue;
        attachments.push(persistVideoSoundtrackAttachment(video, audioAbsolute));
      } catch (err: unknown) {
        logWarn(`Failed resolving extracted audio for video: ${video.filePath}`, err);
      }
    }
  }
}

type ChatContentPart =
  | { type: "text"; text: string }
  | { type: "image_url"; image_url: { url: string } }
  | { type: "input_audio"; input_audio: { url: string } }
  | { type: "input_video"; input_video: { url: string } };

/**
 * Builds the content parts array for a multimodal LLM API request.
 * Converts mixed text and attachment objects into the appropriate nested JSON objects required by completions.
 *
 * @param text - The main message text payload.
 * @param attachments - A list of successfully verified and stored attachments.
 * @param metadata - Projecting boundaries like supported capabilities via the server config.
 * @returns The complex content parts array or a simple string if no supported attachments exist.
 */
export async function buildContentParts(
  text: string,
  attachments: Attachment[],
  metadata?: GgufDisplayMetadata,
): Promise<ChatContentPart[] | string> {
  // Multimodal guard

  let finalString = "";
  const parts: ChatContentPart[] = [];
  const extractedTextAttachments: ProcessedAttachment[] = [];
  const emittedSoundtrackPaths = new Set<string>();
  /**
   * Index where the next autoextracted soundtrack is inserted.
   * Gemma 4 ignores `input_audio` that follows an image or video in the same
   * user turn, so extracted soundtracks stay in a block at the front.
   */
  let extractedAudioInsertAt = 0;
  let includeVideoAudio: boolean | undefined;

  /**
   * Inserts an autoextracted soundtrack before any image or video part.
   *
   * @param part - `input_audio` part for the soundtrack.
   * @param filePath - Stored attachment path, used to avoid sending it twice.
   * @returns No return value.
   */
  function pushExtractedAudio(part: ChatContentPart, filePath: string): void {
    if (emittedSoundtrackPaths.has(filePath)) return;
    emittedSoundtrackPaths.add(filePath);
    parts.splice(extractedAudioInsertAt, 0, part);
    extractedAudioInsertAt += 1;
  }

  /**
   * Resolves whether extracted video soundtracks should be sent with `input_video`.
   * Skips settings I/O when the loaded model has no audio encoder.
   *
   * @returns `true` when the global toggle is on and the model can consume audio.
   */
  async function shouldIncludeVideoAudio(): Promise<boolean> {
    if (includeVideoAudio !== undefined) return includeVideoAudio;
    if (metadata && !metadata.hasAudioEncoder) {
      includeVideoAudio = false;
      return false;
    }
    const settings = await loadSettings();
    includeVideoAudio = settings.includeVideoAudio === true;
    return includeVideoAudio;
  }

  /**
   * Checks whether attachment text has already been embedded into the stored message body.
   *
   * @param attachment - Attachment whose extracted-text marker should be checked.
   * @returns `true` when the message text already contains this attachment block.
   */
  const alreadyEmbeddedAttachmentText = (attachment: Attachment): boolean => {
    return text.includes(`--- Attached file: ${attachment.fileName} ---`);
  };

  /**
   * Resolves extracted prompt text for a persisted attachment when available.
   *
   * @param attachment - Attachment to inspect or lazily re-read from disk.
   * @returns Extraction text metadata, or `undefined` when no text should be embedded.
   */
  async function resolveAttachmentText(
    attachment: Attachment,
  ): Promise<ResolvedAttachmentText | undefined> {
    const casted = attachment as ProcessedAttachment;
    if (casted.extractedText) {
      return {
        text: casted.extractedText,
        originalLength: casted.extractedTextOriginalLength ?? casted.extractedText.length,
        truncated: casted.extractedTextWasTruncated ?? false,
      };
    }

    if (attachment.mimeType === "application/pdf") {
      const absPath = resolveStoredAttachmentPath(attachment.filePath);
      if (!absPath) return undefined;
      // S8 fix: check in-memory cache before re-parsing
      const cached = _attachmentTextCache.get(absPath);
      if (cached !== undefined) return cached;
      // M8 fix: check file size before extraction to prevent OOM
      try {
        const fileSize = Bun.file(absPath).size;
        if (fileSize > MAX_PDF_EXTRACTION_BYTES) {
          const sizeMsg = clampExtractedText(
            `[PDF text extraction skipped: file size (${(fileSize / (1024 * 1024)).toFixed(1)}MB) exceeds the ${MAX_PDF_EXTRACTION_BYTES / (1024 * 1024)}MB extraction limit]`,
          );
          rememberAttachmentText(absPath, sizeMsg);
          return sizeMsg;
        }
      } catch {
        // stat failed — let the downstream read attempt fail
      }
      try {
        const buffer = await Bun.file(absPath).arrayBuffer();
        const clamped = clampExtractedText(await extractPdfText(new Uint8Array(buffer)));
        rememberAttachmentText(absPath, clamped);
        return clamped;
      } catch (e) {
        logWarn("PDF extraction failed", e);
        return undefined;
      }
    }

    if (
      !attachment.mimeType.startsWith("image/") &&
      !attachment.mimeType.startsWith("audio/") &&
      !attachment.mimeType.startsWith("video/")
    ) {
      const absPath = resolveStoredAttachmentPath(attachment.filePath);
      if (!absPath) return undefined;
      const cached = _attachmentTextCache.get(absPath);
      if (cached !== undefined) return cached;
      try {
        const bytes = await readStoredFileBytes(absPath);
        if (!isUtf8Text(bytes)) return undefined;
        const extracted = clampExtractedText(new TextDecoder("utf-8").decode(bytes));
        return rememberAttachmentText(absPath, extracted);
      } catch (e) {
        logWarn(`Failed reading attachment file: ${attachment.filePath}`, e);
      }
    }
    return undefined;
  }

  // Append extracted text attachments to prompt text, but avoid doubling text already embedded in the stored message.
  for (const a of attachments) {
    const extracted = await resolveAttachmentText(a);
    if (extracted && !alreadyEmbeddedAttachmentText(a)) {
      extractedTextAttachments.push({
        ...a,
        extractedText: extracted.text,
        extractedTextOriginalLength: extracted.originalLength,
        extractedTextWasTruncated: extracted.truncated,
      });
      continue;
    }

    if (
      a.mimeType.startsWith("image/") ||
      a.mimeType.startsWith("audio/") ||
      a.mimeType.startsWith("video/")
    ) {
      try {
        const absPath = resolveStoredAttachmentPath(a.filePath);
        if (!absPath) {
          logWarn(`Invalid attachment path: ${a.filePath}`);
          continue;
        }
        if (!(await Bun.file(absPath).exists())) {
          logWarn(`Attachment file missing: ${absPath}`);
          continue;
        }

        if (a.mimeType.startsWith("image/") && metadata && !metadata.hasVisionEncoder) continue;
        if (a.mimeType.startsWith("audio/") && metadata && !metadata.hasAudioEncoder) continue;
        if (a.mimeType.startsWith("video/") && metadata && !metadata.hasVisionEncoder) continue;
        if (isExtractedVideoAudioAttachment(a) && !(await shouldIncludeVideoAudio())) continue;

        const url = toLocalMediaUrl(a.filePath);
        if (!url) {
          logWarn(`Invalid attachment media URL path: ${a.filePath}`);
          continue;
        }
        const isAudio = a.mimeType.startsWith("audio/");
        const isVideo = a.mimeType.startsWith("video/");
        if (isAudio && isExtractedVideoAudioAttachment(a)) {
          if (emittedSoundtrackPaths.has(a.filePath)) continue;
          logInfo(`Pushing extracted video audio URL path: ${url}`);
          pushExtractedAudio({ type: "input_audio", input_audio: { url } }, a.filePath);
          continue;
        }
        if (isVideo && !preferNativeInputVideo) {
          const frames = await extractVideoFramesImpl(absPath, path.dirname(absPath));
          if (frames.length > 0) {
            for (const framePath of frames) {
              const frameUrl = toMediaPathUrlFromAbsolute(framePath);
              if (!frameUrl) continue;
              parts.push({ type: "image_url", image_url: { url: frameUrl } });
            }
            logInfo(`Sampled ${frames.length} video frames from ${url}`);
            continue;
          }
          if (!allowPipedVideoInput()) {
            logWarn(
              `Skipping piped input_video for ${a.filePath} because ffmpeg frame extraction failed. Installing ffmpeg and retrying avoids a llama.cpp video-probe deadlock on Windows.`,
            );
            continue;
          }
        }
        const mediaPart: ChatContentPart = isAudio
          ? { type: "input_audio", input_audio: { url } }
          : isVideo
            ? { type: "input_video", input_video: { url } }
            : { type: "image_url", image_url: { url } };
        if (mediaPart.type === "input_video" && (await shouldIncludeVideoAudio())) {
          const existing = findExistingSoundtrack(attachments, a);
          if (existing && !emittedSoundtrackPaths.has(existing.filePath)) {
            const audioUrl = toLocalMediaUrl(existing.filePath);
            if (!audioUrl) {
              logWarn(`Invalid extracted video audio path: ${existing.filePath}`);
            } else {
              logInfo(`Pushing extracted video audio URL path: ${audioUrl}`);
              pushExtractedAudio(
                { type: "input_audio", input_audio: { url: audioUrl } },
                existing.filePath,
              );
            }
          }
        }
        logInfo(`Pushing media URL path: ${url}`);
        parts.push(mediaPart);
      } catch (e) {
        logWarn(`Failed resolving attachment file: ${a.filePath}`, e);
      }
    }
  }

  finalString = mergeExtractedAttachmentText(finalString, extractedTextAttachments);
  finalString += (finalString ? "\n" : "") + text;

  if (parts.length > 0) {
    parts.push({ type: "text", text: finalString });
    return parts;
  }

  return finalString;
}
