/**
 * @packageDocumentation
 * Tests for HTTP Range parsing, inline media disposition, and real MP4 serving.
 */

import { describe, expect, it } from "bun:test";
import { fileURLToPath } from "node:url";
import {
  attachmentContentDisposition,
  isInlineMediaMime,
  parseByteRange,
  resolveAttachmentMime,
  serveAttachmentFile,
} from "../../src/server/attachmentServe";

const TEST_VID_PATH = fileURLToPath(new URL("../data/test_vid.mp4", import.meta.url));

describe("attachmentServe", () => {
  it("parses inclusive byte ranges including suffix form", () => {
    expect(parseByteRange("bytes=0-499", 1000)).toEqual({ start: 0, end: 499 });
    expect(parseByteRange("bytes=500-", 1000)).toEqual({ start: 500, end: 999 });
    expect(parseByteRange("bytes=-200", 1000)).toEqual({ start: 800, end: 999 });
    expect(parseByteRange("bytes=1000-1200", 1000)).toBeNull();
    expect(parseByteRange(null, 1000)).toBeNull();
  });

  it("serves video and audio inline so HTML media elements can play them", () => {
    expect(isInlineMediaMime("video/mp4")).toBe(true);
    expect(isInlineMediaMime("audio/wav")).toBe(true);
    expect(isInlineMediaMime("application/pdf")).toBe(false);
    expect(attachmentContentDisposition("clip.mp4", "video/mp4")).toContain("inline");
    expect(attachmentContentDisposition("notes.pdf", "application/pdf")).toContain("attachment");
  });

  it("serves the real tests/data/test_vid.mp4 fixture as inline video/mp4 with Range slices", async () => {
    const file = Bun.file(TEST_VID_PATH);
    expect(await file.exists()).toBe(true);
    expect(file.size).toBeGreaterThan(32);
    expect(resolveAttachmentMime(TEST_VID_PATH, "application/octet-stream")).toBe("video/mp4");

    const ftyp = new Uint8Array(await file.slice(4, 8).arrayBuffer());
    expect(String.fromCharCode(...ftyp)).toBe("ftyp");

    const ranged = await serveAttachmentFile(
      TEST_VID_PATH,
      new Request("http://localhost/test_vid.mp4", { headers: { Range: "bytes=4-7" } }),
    );
    expect(ranged.status).toBe(206);
    expect(ranged.headers.get("Content-Type")).toBe("video/mp4");
    expect(ranged.headers.get("Content-Disposition")).toContain("inline");
    expect(ranged.headers.get("Accept-Ranges")).toBe("bytes");
    expect(ranged.headers.get("Content-Range")).toBe(`bytes 4-7/${file.size}`);
    expect(new Uint8Array(await ranged.arrayBuffer())).toEqual(ftyp);

    const full = await serveAttachmentFile(
      TEST_VID_PATH,
      new Request("http://localhost/test_vid.mp4"),
    );
    expect(full.status).toBe(200);
    expect(full.headers.get("Content-Type")).toBe("video/mp4");
    expect(Number(full.headers.get("Content-Length"))).toBe(file.size);
    expect((await full.arrayBuffer()).byteLength).toBe(file.size);
  });
});
