/**
 * @packageDocumentation
 * Handles multimodal data processing including attachment file storage, file URL construction, and PDF text extraction.
 */

import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { Attachment, GgufDisplayMetadata } from "../shared/types";
import { logInfo, logWarn } from "./logger";
import { getDb } from "./persistence/db";

const APP_ROOT = path.join(os.homedir(), ".llamaforge");
const MAX_EXTRACTED_TEXT_CHARS_PER_ATTACHMENT = 12_000;
const MAX_EXTRACTED_TEXT_CHARS_PER_MESSAGE = 24_000;
const ATTACHMENT_TEXT_BUDGET_EXHAUSTED_NOTICE =
  "[Attachment text omitted: message attachment text budget exhausted.]";

// S8 fix: in-memory cache for extracted PDF text to avoid re-parsing on every generation
type ResolvedAttachmentText = {
  text: string;
  originalLength: number;
  truncated: boolean;
};

const _pdfTextCache = new Map<string, ResolvedAttachmentText>();
const _PDF_CACHE_MAX_SIZE = 50;
// M8 fix: max PDF file size for text extraction (50MB) to prevent OOM on low-memory machines
const MAX_PDF_EXTRACTION_BYTES = 50 * 1024 * 1024;

function normalizeStoredAttachmentPath(relativePath: string): string | null {
  if (!relativePath || typeof relativePath !== "string") return null;
  if (path.isAbsolute(relativePath)) return null;
  const normalized = path.posix.normalize(relativePath.replace(/\\/g, "/"));
  if (normalized === ".." || normalized.startsWith("../") || normalized.startsWith("/")) {
    return null;
  }

  return normalized;
}

function resolveStoredAttachmentPath(relativePath: string): string | null {
  const normalized = normalizeStoredAttachmentPath(relativePath);
  if (!normalized) return null;

  const absPath = path.join(APP_ROOT, ...normalized.split("/"));
  const relative = path.relative(APP_ROOT, absPath);
  if (relative.startsWith("..") || path.isAbsolute(relative)) return null;
  return absPath;
}

function toLocalMediaUrl(relativePath: string): string | null {
  const normalized = normalizeStoredAttachmentPath(relativePath);
  return normalized ? `file://${normalized}` : null;
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

function assignExtractedText(attachment: ProcessedAttachment, extractedText: string): void {
  const clamped = clampExtractedText(extractedText);
  attachment.extractedText = clamped.text;
  attachment.extractedTextOriginalLength = clamped.originalLength;
  attachment.extractedTextWasTruncated = clamped.truncated;
}

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
 */
export async function processUpload(
  chatId: string,
  messageId: string,
  fileName: string,
  mimeType: string,
  buffer: ArrayBuffer,
): Promise<ProcessedAttachment> {
  const appData = path.join(os.homedir(), ".llamaforge", "attachments", chatId, messageId);
  await fs.mkdir(appData, { recursive: true });

  const ext = path.extname(fileName) || "";
  const safeName = Bun.randomUUIDv7() + ext;
  const filePath = path.join(appData, safeName);

  await Bun.write(filePath, buffer);

  const relPath = path
    .relative(path.join(os.homedir(), ".llamaforge"), filePath)
    .split(path.sep)
    .join("/");

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
        const pdfjs = await import("pdfjs-dist");
        const doc = await pdfjs.getDocument({ data: new Uint8Array(buffer) }).promise;
        let fullText = "";
        for (let i = 1; i <= doc.numPages; i++) {
          const page = await doc.getPage(i);
          const content = await page.getTextContent();
          fullText += `${content.items.map((item: any) => item.str).join(" ")}\n`;
        }
        assignExtractedText(attachment, fullText);
      } catch (e) {
        logWarn("PDF extraction failed", e);
        assignExtractedText(
          attachment,
          `[Error extracting PDF text: ${e instanceof Error ? e.message : String(e)}]`,
        );
      }
    }
  } else if (!mimeType.startsWith("image/") && !mimeType.startsWith("audio/")) {
    // text, markdown, csv, json, xml, code...
    assignExtractedText(attachment, Buffer.from(buffer).toString("utf-8"));
  }

  // NOTE: We no longer store base64Data in the attachment object permanently to save RAM.
  // Instead, the server will read the file from `relPath` when it needs to send it to the LLM.

  // Save to DB
  const stmt = getDb().prepare(
    "INSERT INTO attachments (id, message_id, mime_type, file_path, file_name, vir_budget, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
  );
  stmt.run(
    attachment.id,
    attachment.messageId,
    attachment.mimeType,
    attachment.filePath,
    attachment.fileName,
    attachment.virBudget || null,
    attachment.createdAt,
  );

  return attachment;
}

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
): Promise<any[] | string> {
  // Multimodal guard

  let finalString = "";
  const parts: any[] = [];
  const extractedTextAttachments: ProcessedAttachment[] = [];

  const alreadyEmbeddedAttachmentText = (attachment: Attachment): boolean => {
    return text.includes(`--- Attached file: ${attachment.fileName} ---`);
  };

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
      const cached = _pdfTextCache.get(absPath);
      if (cached !== undefined) return cached;
      // M8 fix: check file size before extraction to prevent OOM
      try {
        const fileSize = Bun.file(absPath).size;
        if (fileSize > MAX_PDF_EXTRACTION_BYTES) {
          const sizeMsg = clampExtractedText(
            `[PDF text extraction skipped: file size (${(fileSize / (1024 * 1024)).toFixed(1)}MB) exceeds the ${MAX_PDF_EXTRACTION_BYTES / (1024 * 1024)}MB extraction limit]`,
          );
          _pdfTextCache.set(absPath, sizeMsg);
          return sizeMsg;
        }
      } catch {
        // stat failed — let the downstream read attempt fail
      }
      try {
        const pdfjs = await import("pdfjs-dist");
        const buffer = await Bun.file(absPath).arrayBuffer();
        const doc = await pdfjs.getDocument({ data: new Uint8Array(buffer) }).promise;
        let fullText = "";
        for (let i = 1; i <= doc.numPages; i++) {
          const page = await doc.getPage(i);
          const content = await page.getTextContent();
          fullText += `${content.items.map((item: any) => item.str).join(" ")}\n`;
        }
        const clamped = clampExtractedText(fullText);
        // S8 fix: store in cache with LRU eviction
        _pdfTextCache.set(absPath, clamped);
        if (_pdfTextCache.size > _PDF_CACHE_MAX_SIZE) {
          const firstKey = _pdfTextCache.keys().next().value;
          if (firstKey) _pdfTextCache.delete(firstKey);
        }
        return clamped;
      } catch (e) {
        logWarn("PDF extraction failed", e);
        return undefined;
      }
    }

    if (!attachment.mimeType.startsWith("image/") && !attachment.mimeType.startsWith("audio/")) {
      const absPath = resolveStoredAttachmentPath(attachment.filePath);
      if (!absPath) return undefined;
      try {
        return clampExtractedText(await Bun.file(absPath).text());
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

    if (a.mimeType.startsWith("image/") || a.mimeType.startsWith("audio/")) {
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

        const url = toLocalMediaUrl(a.filePath);
        if (!url) {
          logWarn(`Invalid attachment media URL path: ${a.filePath}`);
          continue;
        }
        const mediaPart: any = {
          type: "image_url",
          image_url: { url },
        };
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
