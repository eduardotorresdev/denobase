import { assert, assertEquals } from "@std/assert";
import { detectBytes, detectFile, mimeIs, READ_LIMIT } from "./mimetype.ts";

const enc = new TextEncoder();
const b = (...parts: (string | number[])[]) => {
  const chunks = parts.map((
    p,
  ) => (typeof p === "string" ? Uint8Array.from(p, (c) => c.charCodeAt(0)) : Uint8Array.from(p)));
  const out = new Uint8Array(chunks.reduce((n, c) => n + c.length, 0));
  let i = 0;
  for (const c of chunks) out.set(c, (i += c.length) - c.length);
  return out;
};
const mime = (raw: Uint8Array) => detectBytes(raw).mime;

/** A zip whose local file headers carry these names (stored, empty). */
function zip(...names: string[]): Uint8Array {
  return b(...names.flatMap((n) => ["PK\x03\x04", new Array(22).fill(0), [n.length, 0, 0, 0], n]));
}

Deno.test("images, pdf and archives are told by their signatures", () => {
  assertEquals(mime(b([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], "\0\0\0\rIHDR")), "image/png");
  assertEquals(mime(b([0xff, 0xd8, 0xff, 0xe0], "JFIF")), "image/jpeg");
  assertEquals(mime(b("GIF89a")), "image/gif");
  assertEquals(mime(b("RIFF\0\0\0\0WEBPVP8 ")), "image/webp");
  assertEquals(mime(b("BM", new Array(12).fill(0), [40, 0, 0, 0])), "image/bmp");
  assertEquals(mime(b("%PDF-1.7\n")), "application/pdf");
  assertEquals(mime(b([0x1f, 0x8b, 8, 0])), "application/gzip");
  assertEquals(mime(b("\0\0\0\x1cftypavif\0\0\0\0avifmif1miaf")), "image/avif");
  assertEquals(mime(b("\0\0\0\x18ftypheic\0\0\0\0mif1heic")), "image/heic");
});

Deno.test("zip children: office, odf, epub; a plain zip stays zip", () => {
  assertEquals(
    mime(zip("[Content_Types].xml", "word/document.xml")),
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  );
  assertEquals(
    mime(zip("[Content_Types].xml", "_rels/.rels", "xl/workbook.xml")),
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  );
  assertEquals(
    mime(zip("[Content_Types].xml", "ppt/presentation.xml")),
    "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  );
  assertEquals(
    mime(b("PK\x03\x04", new Array(26).fill(0), "mimetypeapplication/vnd.oasis.opendocument.text")),
    "application/vnd.oasis.opendocument.text",
  );
  assertEquals(mime(b("PK\x03\x04", new Array(26).fill(0), "mimetypeapplication/epub+zip")), "application/epub+zip");
  assertEquals(mime(zip("foto.jpg")), "application/zip");
});

Deno.test("audio and video", () => {
  assertEquals(mime(b("ID3\x04\0")), "audio/mpeg");
  assertEquals(mime(b([0xff, 0xfb, 0x90, 0x00])), "audio/mpeg");
  assertEquals(mime(b("RIFF\0\0\0\0WAVEfmt ")), "audio/wav");
  assertEquals(mime(b("fLaC")), "audio/flac");
  assertEquals(mime(b("OggS", new Array(24).fill(0), "OpusHead")), "audio/ogg");
  assertEquals(mime(b("\0\0\0\x20ftypisom\0\0\x02\0isomiso2mp41")), "video/mp4");
  assertEquals(mime(b("\0\0\0\x14ftypqt  \0\0\0\0qt  ")), "video/quicktime");
  assertEquals(mime(b("\0\0\0\x1cftypM4A \0\0\0\0M4A isom")), "audio/x-m4a");
  assertEquals(mime(b([0x1a, 0x45, 0xdf, 0xa3, 0x9f, 0x42, 0x86, 0x81, 0x01, 0x42, 0x82, 0x84], "webm")), "video/webm");
  assertEquals(mime(b("RIFF\0\0\0\0AVI LIST")), "video/x-msvideo");
});

Deno.test("text falls back to text/plain with charset; json, html, svg, xml and csv refine it", () => {
  assertEquals(mime(enc.encode("olá mundo")), "text/plain; charset=utf-8");
  assertEquals(mime(new Uint8Array()), "text/plain; charset=utf-8");
  assertEquals(mime(b("caf", [0xe9])), "text/plain; charset=iso-8859-1");
  assertEquals(mime(enc.encode('  {"a": [1, 2]}')), "application/json");
  assertEquals(mime(enc.encode("{not json")), "text/plain; charset=utf-8");
  assertEquals(mime(enc.encode(`{"a":"${"x".repeat(READ_LIMIT)}"}`)), "application/json");
  assertEquals(mime(enc.encode("<!DOCTYPE html><html>")), "text/html; charset=utf-8");
  assertEquals(mime(enc.encode("<p>oi</p>")), "text/html; charset=utf-8");
  assertEquals(
    mime(enc.encode('<?xml version="1.0"?>\n<!-- c --><svg xmlns="http://www.w3.org/2000/svg"/>')),
    "image/svg+xml",
  );
  assertEquals(mime(enc.encode('<?xml version="1.0"?><nota/>')), "text/xml; charset=utf-8");
  assertEquals(mime(enc.encode("a,b,c\n1,2,3\n")), "text/csv");
  assertEquals(mime(enc.encode("a\tb\n1\t2\n")), "text/tab-separated-values");
  assertEquals(mime(enc.encode("a,b\n1,2,3\n")), "text/plain; charset=utf-8");
});

Deno.test("binary that matches nothing is application/octet-stream", () => {
  assertEquals(mime(b([0x00, 0x01, 0x02, 0x03, 0x89])), "application/octet-stream");
});

Deno.test("mimeIs matches aliases and ignores parameters, like mt.Is", () => {
  assert(mimeIs(detectBytes(b("PK\x05\x06")), "application/x-zip-compressed"));
  assert(mimeIs(detectBytes(enc.encode("oi")), "text/plain"));
  assert(mimeIs(detectBytes(b("RIFF\0\0\0\0WAVE")), "audio/x-wav"));
  assert(!mimeIs(detectBytes(enc.encode("oi")), "image/png"));
});

Deno.test("detectFile reads only the leading bytes, whatever type the client claimed", async () => {
  const big = new Uint8Array(1 << 20);
  big.set(enc.encode("%PDF-1.4"));
  assertEquals((await detectFile(new File([big], "x.png", { type: "image/png" }))).mime, "application/pdf");
});
