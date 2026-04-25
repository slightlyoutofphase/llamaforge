/**
 * @packageDocumentation
 * Handles multimodal data processing including attachment file storage, file URL construction, and PDF text extraction.
 */

import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import type { Attachment, GgufDisplayMetadata } from "@shared/types.js";
import { getDb } from "./persistence/db";

const APP_ROOT = path.join(os.homedir(), ".llamaforge");

function resolveStoredAttachmentPath(relativePath: string): string | null {
  if (!relativePath || typeof relativePath !== "string") return null;
  if (path.isAbsolute(relativePath)) return null;
  const normalized = path.normalize(relativePath);
  if (normalized.startsWith(`..${path.sep}`) || normalized === "..") return null;

  const absPath = path.join(APP_ROOT, normalized);
  const relative = path.relative(APP_ROOT, absPath);
  if (relative.startsWith("..") || path.isAbsolute(relative)) return null;
  return absPath;
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

  await fs.writeFile(filePath, Buffer.from(buffer));

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
    try {
      const pdfjs = await import("pdfjs-dist");
      const doc = await pdfjs.getDocument({ data: new Uint8Array(buffer) }).promise;
      let fullText = "";
      for (let i = 1; i <= doc.numPages; i++) {
        const page = await doc.getPage(i);
        const content = await page.getTextContent();
        fullText += `${content.items.map((item: any) => item.str).join(" ")}\n`;
      }
      attachment.extractedText = fullText;
    } catch (e) {
      console.warn("PDF extraction failed", e);
      attachment.extractedText = `[Error extracting PDF text: ${e instanceof Error ? e.message : String(e)}]`;
    }
  } else if (!mimeType.startsWith("image/") && !mimeType.startsWith("audio/")) {
    // text, markdown, csv, json, xml, code...
    attachment.extractedText = Buffer.from(buffer).toString("utf-8");
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
  const hasImages = attachments.some((a) => a.mimeType.startsWith("image/"));
  const hasAudio = attachments.some((a) => a.mimeType.startsWith("audio/"));

  if (hasImages && metadata && !metadata.hasVisionEncoder) {
    // We let the caller decide how to handle this, but for internal building we filter out what the model can't handle
    // or we throw. The current streamProxy filters them.
  }
  if (hasAudio && metadata && !metadata.hasAudioEncoder) {
    // Similarly, we let caller handle it, but buildContentParts skips what it can't handle.
  }

  let finalString = "";
  const parts: any[] = [];

  const alreadyEmbeddedAttachmentText = (attachment: Attachment): boolean => {
    return text.includes(`--- Attached file: ${attachment.fileName} ---`);
  };

  async function resolveAttachmentText(attachment: Attachment): Promise<string | undefined> {
    const casted = attachment as ProcessedAttachment;
    if (casted.extractedText) return casted.extractedText;

    if (attachment.mimeType === "application/pdf") {
      const absPath = resolveStoredAttachmentPath(attachment.filePath);
      if (!absPath) return undefined;
      try {
        const pdfjs = await import("pdfjs-dist");
        const buffer = await fs.readFile(absPath);
        const doc = await pdfjs.getDocument({ data: new Uint8Array(buffer) }).promise;
        let fullText = "";
        for (let i = 1; i <= doc.numPages; i++) {
          const page = await doc.getPage(i);
          const content = await page.getTextContent();
          fullText += `${content.items.map((item: any) => item.str).join(" ")}\n`;
        }
        return fullText;
      } catch (e) {
        console.warn("PDF extraction failed", e);
        return undefined;
      }
    }

    if (!attachment.mimeType.startsWith("image/") && !attachment.mimeType.startsWith("audio/")) {
      const absPath = resolveStoredAttachmentPath(attachment.filePath);
      if (!absPath) return undefined;
      try {
        return (await fs.readFile(absPath)).toString("utf-8");
      } catch (e) {
        console.warn(`Failed reading attachment file: ${attachment.filePath}`, e);
      }
    }
    return undefined;
  }

  // Append extracted text attachments to prompt text, but avoid doubling text already embedded in the stored message.
  for (const a of attachments) {
    const extracted = await resolveAttachmentText(a);
    if (extracted && !alreadyEmbeddedAttachmentText(a)) {
      finalString += `\n--- Attached file: ${a.fileName} ---\n${extracted}\n--- End of file ---\n`;
      continue;
    }

    if (a.mimeType.startsWith("image/") || a.mimeType.startsWith("audio/")) {
      try {
        const absPath = resolveStoredAttachmentPath(a.filePath);
        if (!absPath) {
          console.warn(`Invalid attachment path: ${a.filePath}`);
          continue;
        }
        try {
          await fs.access(absPath);
        } catch {
          console.warn(`Attachment file missing: ${absPath}`);
          continue;
        }

        if (a.mimeType.startsWith("image/") && metadata && !metadata.hasVisionEncoder) continue;
        if (a.mimeType.startsWith("audio/") && metadata && !metadata.hasAudioEncoder) continue;

        const mediaPart: any = {
          type: "image_url",
          image_url: { url: pathToFileURL(absPath).toString() },
        };
        parts.push(mediaPart);
      } catch (e) {
        console.warn(`Failed resolving attachment file: ${a.filePath}`, e);
      }
    }
  }

  finalString += (finalString ? "\n" : "") + text;

  if (parts.length > 0) {
    parts.push({ type: "text", text: finalString });
    return parts;
  }

  return finalString;
}
