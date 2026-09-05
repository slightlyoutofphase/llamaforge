/**
 * @packageDocumentation
 * HTTP helpers for serving persisted chat attachments, including media Range requests.
 */

import path from "node:path";

const EXTENSION_MIME: Record<string, string> = {
  ".mp4": "video/mp4",
  ".webm": "video/webm",
  ".mkv": "video/x-matroska",
  ".mov": "video/quicktime",
  ".avi": "video/x-msvideo",
  ".mp3": "audio/mpeg",
  ".wav": "audio/wav",
  ".flac": "audio/flac",
  ".ogg": "audio/ogg",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
};

/**
 * Resolves a MIME type from Bun's file probe, falling back to a well-known extension map.
 *
 * @param absPath - Absolute attachment path.
 * @param probedType - MIME type reported by `Bun.file`.
 * @returns MIME type suitable for Content-Type.
 */
export function resolveAttachmentMime(absPath: string, probedType: string): string {
  if (probedType && probedType !== "application/octet-stream") return probedType;
  return (
    EXTENSION_MIME[path.extname(absPath).toLowerCase()] ?? probedType ?? "application/octet-stream"
  );
}

/**
 * Parsed HTTP `Range: bytes=` request.
 */
export interface ByteRange {
  /** Inclusive start offset. */
  start: number;
  /** Inclusive end offset. */
  end: number;
}

/**
 * Parses a single `bytes=` Range header against a known file size.
 *
 * @param rangeHeader - Raw `Range` header value.
 * @param size - Total file size in bytes.
 * @returns Inclusive start/end offsets, or `null` when the header is absent or unsatisfiable.
 */
export function parseByteRange(rangeHeader: string | null, size: number): ByteRange | null {
  if (!rangeHeader || size <= 0) return null;
  const match = rangeHeader.trim().match(/^bytes=(\d*)-(\d*)$/i);
  if (!match) return null;
  const startToken = match[1] ?? "";
  const endToken = match[2] ?? "";
  if (!startToken && !endToken) return null;

  let start: number;
  let end: number;
  if (!startToken) {
    const suffix = Number.parseInt(endToken, 10);
    if (!Number.isInteger(suffix) || suffix <= 0) return null;
    start = Math.max(0, size - suffix);
    end = size - 1;
  } else {
    start = Number.parseInt(startToken, 10);
    end = endToken ? Number.parseInt(endToken, 10) : size - 1;
  }

  if (!Number.isInteger(start) || !Number.isInteger(end) || start < 0 || end < start) {
    return null;
  }
  if (start >= size) return null;
  return { start, end: Math.min(end, size - 1) };
}

/**
 * Returns whether a MIME type should be presented inline in the chat UI.
 *
 * @param mimeType - Detected or stored attachment MIME type.
 * @returns `true` for image, audio, and video attachments.
 */
export function isInlineMediaMime(mimeType: string): boolean {
  return (
    mimeType.startsWith("image/") || mimeType.startsWith("audio/") || mimeType.startsWith("video/")
  );
}

/**
 * Builds a `Content-Disposition` header for an attachment response.
 *
 * Video and audio elements refuse to play when the resource is forced as an
 * attachment download, so media types are served `inline`.
 *
 * @param fileName - Original or stored filename.
 * @param mimeType - Attachment MIME type.
 * @returns Content-Disposition header value.
 */
export function attachmentContentDisposition(fileName: string, mimeType: string): string {
  const safeName = fileName.replace(/["\r\n]/g, "");
  const kind = isInlineMediaMime(mimeType) ? "inline" : "attachment";
  return `${kind}; filename="${safeName}"`;
}

/**
 * Serves a local attachment file, honouring `Range` requests for media playback.
 *
 * @param absPath - Absolute path of a file already verified to be inside the attachments root.
 * @param request - Incoming HTTP request (Range header is read when present).
 * @returns HTTP response with the file body or a 206 slice.
 */
export async function serveAttachmentFile(absPath: string, request: Request): Promise<Response> {
  const file = Bun.file(absPath);
  if (!(await file.exists())) {
    return new Response("Not Found", { status: 404 });
  }

  const fileName = path.basename(absPath);
  const mimeType = resolveAttachmentMime(absPath, file.type || "application/octet-stream");
  const size = file.size;
  const disposition = attachmentContentDisposition(fileName, mimeType);
  const baseHeaders: Record<string, string> = {
    "Content-Type": mimeType,
    "Accept-Ranges": "bytes",
    "X-Content-Type-Options": "nosniff",
    "Content-Security-Policy": "default-src 'none'",
    "Content-Disposition": disposition,
  };

  const range = isInlineMediaMime(mimeType)
    ? parseByteRange(request.headers.get("Range"), size)
    : null;
  if (range) {
    const length = range.end - range.start + 1;
    return new Response(file.slice(range.start, range.end + 1), {
      status: 206,
      headers: {
        ...baseHeaders,
        "Content-Range": `bytes ${range.start}-${range.end}/${size}`,
        "Content-Length": String(length),
      },
    });
  }

  return new Response(file, {
    headers: {
      ...baseHeaders,
      "Content-Length": String(size),
    },
  });
}
