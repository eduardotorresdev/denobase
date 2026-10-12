/**
 * Content sniffing as PB does it with github.com/gabriel-vasile/mimetype: the type of an upload comes from its first
 * bytes, never from the client's Content-Type or the name. The detection tree below ports the matchers PB's users rely
 * on (images, pdf, zip and office, audio/video, fonts, archives, text with its json/html/svg/xml/csv children) in the
 * library's order: a parent matches first and its children refine it; nothing matching falls back to text/plain when
 * the bytes are text, else application/octet-stream.
 */

/** mimetype's default read limit: only this many leading bytes are inspected. */
export const READ_LIMIT = 3072;

export interface MimeType {
  /** Full type as mimetype's String(): text types carry "; charset=…". */
  readonly mime: string;
  readonly extension: string;
  readonly aliases: readonly string[];
}

/** mt.Is(t): the type or one of its aliases, parameters ignored, case-insensitive. */
export function mimeIs(mt: MimeType, expected: string): boolean {
  const want = baseOf(expected);
  return baseOf(mt.mime) === want || mt.aliases.some((a) => a === want);
}

const baseOf = (t: string) => t.split(";")[0].trim().toLowerCase();

type Matcher = (raw: Uint8Array, limit: number) => boolean;

interface Node {
  mime: string;
  ext: string;
  aliases?: string[];
  match: Matcher;
  children?: Node[];
}

const ascii = (s: string) => Uint8Array.from(s, (c) => c.charCodeAt(0));

function startsWith(raw: Uint8Array, sig: Uint8Array, offset = 0): boolean {
  if (raw.length < offset + sig.length) return false;
  for (let i = 0; i < sig.length; i++) if (raw[offset + i] !== sig[i]) return false;
  return true;
}

const prefix = (...sigs: (string | number[])[]): Matcher => {
  const bytes = sigs.map((s) => (typeof s === "string" ? ascii(s) : Uint8Array.from(s)));
  return (raw) => bytes.some((b) => startsWith(raw, b));
};

const offset = (sig: string | number[], at: number): Matcher => {
  const b = typeof sig === "string" ? ascii(sig) : Uint8Array.from(sig);
  return (raw) => startsWith(raw, b, at);
};

function indexOf(raw: Uint8Array, sig: Uint8Array, from = 0): number {
  outer: for (let i = from; i <= raw.length - sig.length; i++) {
    for (let j = 0; j < sig.length; j++) if (raw[i + j] !== sig[j]) continue outer;
    return i;
  }
  return -1;
}

const u16le = (raw: Uint8Array, i: number) => raw[i] | (raw[i + 1] << 8);
const u32le = (raw: Uint8Array, i: number) =>
  (raw[i] | (raw[i + 1] << 8) | (raw[i + 2] << 16) | (raw[i + 3] << 24)) >>> 0;
const u32be = (raw: Uint8Array, i: number) =>
  ((raw[i] << 24) | (raw[i + 1] << 16) | (raw[i + 2] << 8) | raw[i + 3]) >>> 0;

// --- zip and its children --------------------------------------------------------------------------------------

/** Names of the local file headers within the read bytes, in order (mimetype's zip tokenizer). */
function zipEntries(raw: Uint8Array): string[] {
  const names: string[] = [];
  const sig = ascii("PK\x03\x04");
  let i = 0;
  while ((i = indexOf(raw, sig, i)) !== -1) {
    if (i + 30 > raw.length) break;
    const len = u16le(raw, i + 26);
    const end = Math.min(raw.length, i + 30 + len);
    names.push(String.fromCharCode(...raw.subarray(i + 30, end)));
    i += 30;
  }
  return names;
}

/** OOXML: "[Content_Types].xml", "_rels/.rels" or "docProps" first, then a part under the format's directory. */
const ooxml = (dir: string): Matcher => (raw) => {
  const names = zipEntries(raw);
  if (!names.length) return false;
  const first = names[0];
  if (!(first === "[Content_Types].xml" || first === "_rels/.rels" || first.startsWith("docProps"))) {
    return false;
  }
  return names.some((n) => n.startsWith(dir));
};

/** ODF and EPUB: an uncompressed "mimetype" entry first, its contents the type. */
const zipMimetype = (mime: string): Matcher => offset(`mimetype${mime}`, 30);

const jar: Matcher = (raw) => zipEntries(raw).some((n) => n === "META-INF/MANIFEST.MF" || n === "META-INF/");

// --- ole and its children --------------------------------------------------------------------------------------

/** The CLSID of the root directory entry, when it falls within the read bytes. */
const oleClsid = (clsid: number[]): Matcher => (raw) => {
  if (raw.length < 52) return false;
  const sectorLength = 1 << u16le(raw, 30);
  const firstSecId = u32le(raw, 48);
  const at = sectorLength * (1 + firstSecId) + 80;
  return startsWith(raw, Uint8Array.from(clsid), at);
};

const ole = (clsids: number[][], sigs: [number[], number][] = []): Matcher => (raw) =>
  clsids.some((c) => oleClsid(c)(raw, READ_LIMIT)) || sigs.some(([s, at]) => startsWith(raw, Uint8Array.from(s), at));

// --- images ----------------------------------------------------------------------------------------------------

const jpeg = prefix([0xff, 0xd8, 0xff]);
const png = prefix([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const apng: Matcher = (raw) => startsWith(raw, ascii("acTL"), 37);
const gif = prefix("GIF87a", "GIF89a");
const webp: Matcher = (raw) => startsWith(raw, ascii("RIFF")) && startsWith(raw, ascii("WEBP"), 8);
const bmp: Matcher = (raw) => {
  if (raw.length < 18 || !startsWith(raw, ascii("BM"))) return false;
  // The DIB header size must be one of the known versions, as mimetype checks.
  const dib = u32le(raw, 14);
  return [12, 40, 52, 56, 64, 108, 124].includes(dib);
};
const tiff = prefix([0x49, 0x49, 0x2a, 0x00], [0x4d, 0x4d, 0x00, 0x2a]);
const ico = prefix([0x00, 0x00, 0x01, 0x00], [0x00, 0x00, 0x02, 0x00]);
const psd = prefix("8BPS");

/** ISO-BMFF: "ftyp" at 4, then the major brand and the compatible brands. */
function ftypBrands(raw: Uint8Array): string[] {
  if (raw.length < 12 || !startsWith(raw, ascii("ftyp"), 4)) return [];
  const size = Math.min(u32be(raw, 0), raw.length);
  const brands = [String.fromCharCode(...raw.subarray(8, 12))];
  for (let i = 16; i + 4 <= size; i += 4) brands.push(String.fromCharCode(...raw.subarray(i, i + 4)));
  return brands;
}
const ftyp = (...want: string[]): Matcher => (raw) => {
  const b = ftypBrands(raw);
  return b.length > 0 && want.includes(b[0]);
};
const anyFtyp: Matcher = (raw) => ftypBrands(raw).length > 0;

// --- audio and video -------------------------------------------------------------------------------------------

const mp3: Matcher = (raw) => {
  if (startsWith(raw, ascii("ID3"))) return true;
  if (raw.length < 2) return false;
  const v = ((raw[0] << 8) | raw[1]) & 0xfffe;
  // MPEG-1, -2 and -2.5 layer III frame syncs.
  return v === 0xfffa || v === 0xfff2 || v === 0xffe2;
};
const aac = prefix([0xff, 0xf1], [0xff, 0xf9]);
const riff = (form: string): Matcher => (raw) => startsWith(raw, ascii("RIFF")) && startsWith(raw, ascii(form), 8);
const aiff: Matcher = (raw) => startsWith(raw, ascii("FORM")) && startsWith(raw, ascii("AIFF"), 8);
const ebml = (doctype: string): Matcher => (raw) => {
  if (!startsWith(raw, Uint8Array.from([0x1a, 0x45, 0xdf, 0xa3]))) return false;
  // DocType element (0x4282) followed by its size and value.
  const i = indexOf(raw.subarray(0, 4096), Uint8Array.from([0x42, 0x82]));
  if (i === -1 || i + 3 > raw.length) return false;
  const n = raw[i + 2] & 0x7f;
  return String.fromCharCode(...raw.subarray(i + 3, i + 3 + n)) === doctype;
};
const mpegPS = prefix([0x00, 0x00, 0x01, 0xba], [0x00, 0x00, 0x01, 0xb3]);
const flv = prefix([0x46, 0x4c, 0x56, 0x01]);
const asf = prefix([0x30, 0x26, 0xb2, 0x75, 0x8e, 0x66, 0xcf, 0x11, 0xa6, 0xd9, 0x00, 0xaa, 0x00, 0x62, 0xce, 0x6c]);
const quicktime: Matcher = (raw) => {
  if (ftypBrands(raw)[0] === "qt  ") return true;
  if (raw.length < 12) return false;
  const atom = String.fromCharCode(...raw.subarray(4, 8));
  return ["moov", "mdat", "free", "wide", "skip", "pnot"].includes(atom);
};

// --- text and its children -------------------------------------------------------------------------------------

const BOMS: [number[], string][] = [
  [[0xef, 0xbb, 0xbf], "utf-8"],
  [[0xfe, 0xff], "utf-16be"],
  [[0xff, 0xfe], "utf-16le"],
];

function bomCharset(raw: Uint8Array): string {
  for (const [b, cs] of BOMS) if (startsWith(raw, Uint8Array.from(b))) return cs;
  return "";
}

/** WHATWG binary data bytes; text is anything without them, or anything with a BOM. */
const text: Matcher = (raw) => {
  if (bomCharset(raw)) return true;
  for (const b of raw) {
    if (b <= 0x08 || b === 0x0b || (b >= 0x0e && b <= 0x1a) || (b >= 0x1c && b <= 0x1f)) return false;
  }
  return true;
};

/** mimetype's charset.FromPlain: BOM, else utf-8 when valid (a cut sequence at the end allowed), else latin-1. */
function plainCharset(raw: Uint8Array, limit: number): string {
  const bom = bomCharset(raw);
  if (bom) return bom;
  let body = raw;
  if (raw.length >= limit) {
    // A multi-byte sequence cut at the read limit is not invalid utf-8.
    let i = raw.length - 1;
    while (i > raw.length - 4 && i > 0 && (raw[i] & 0xc0) === 0x80) i--;
    if (raw[i] >= 0xc0) body = raw.subarray(0, i);
  }
  try {
    new TextDecoder("utf-8", { fatal: true }).decode(body);
    return "utf-8";
  } catch {
    return "iso-8859-1";
  }
}

const isWs = (b: number) => b === 0x20 || b === 0x09 || b === 0x0a || b === 0x0d || b === 0x0c;

function trimStart(raw: Uint8Array): Uint8Array {
  let i = 0;
  if (startsWith(raw, Uint8Array.from([0xef, 0xbb, 0xbf]))) i = 3;
  while (i < raw.length && isWs(raw[i])) i++;
  return raw.subarray(i);
}

/** Case-insensitive prefix followed by a tag-terminating byte, WHATWG's HTML sniff. */
const HTML_SIGS = [
  "<!DOCTYPE HTML",
  "<HTML",
  "<HEAD",
  "<SCRIPT",
  "<IFRAME",
  "<H1",
  "<DIV",
  "<FONT",
  "<TABLE",
  "<A",
  "<STYLE",
  "<TITLE",
  "<B",
  "<BODY",
  "<BR",
  "<P",
  "<!--",
];
const html: Matcher = (raw) => {
  const t = trimStart(raw);
  return HTML_SIGS.some((s) => {
    if (t.length <= s.length) return false;
    for (let i = 0; i < s.length; i++) {
      let b = t[i];
      if (b >= 0x61 && b <= 0x7a) b -= 0x20;
      if (b !== s.charCodeAt(i)) return false;
    }
    const end = t[s.length];
    return end === 0x20 || end === 0x3e;
  });
};

const xml: Matcher = (raw) => startsWith(trimStart(raw), ascii("<?xml"));

/** An <svg root, after an optional xml declaration, comments and a doctype. */
const svg: Matcher = (raw) => {
  let s = new TextDecoder().decode(trimStart(raw));
  for (;;) {
    s = s.trimStart();
    if (s.startsWith("<?xml")) {
      const e = s.indexOf("?>");
      if (e === -1) return false;
      s = s.slice(e + 2);
    } else if (s.startsWith("<!--")) {
      const e = s.indexOf("-->");
      if (e === -1) return false;
      s = s.slice(e + 3);
    } else if (/^<!doctype/i.test(s)) {
      const e = s.indexOf(">");
      if (e === -1) return false;
      s = s.slice(e + 1);
    } else break;
  }
  return /^<svg[\s>]/i.test(s);
};

/** An object or array that parses, or a valid prefix of one when the bytes were cut at the read limit. */
const json: Matcher = (raw, limit) => {
  const t = trimStart(raw);
  if (t[0] !== 0x7b && t[0] !== 0x5b) return false;
  const s = new TextDecoder().decode(t);
  try {
    JSON.parse(s);
    return true;
  } catch {
    if (raw.length < limit) return false;
    return jsonPrefixOk(s);
  }
};

/** A tokenizer that accepts a JSON text cut short: every token so far is valid and the nesting is consistent. */
function jsonPrefixOk(s: string): boolean {
  const stack: string[] = [];
  // What may come next: "value", "key", "colon", "comma" (or a close).
  let want: "value" | "key" | "colon" | "after" = "value";
  let i = 0;
  const n = s.length;
  const close = (c: string) => {
    if (stack.pop() !== c) return false;
    want = "after";
    return true;
  };
  while (i < n) {
    const c = s[i];
    if (c === " " || c === "\t" || c === "\n" || c === "\r") {
      i++;
      continue;
    }
    if (want === "after") {
      if (!stack.length) return false;
      if (c === ",") want = stack.at(-1) === "{" ? "key" : "value";
      else if (c === "}" || c === "]") {
        if (!close(c === "}" ? "{" : "[")) return false;
      } else return false;
      i++;
      continue;
    }
    if (want === "colon") {
      if (c !== ":") return false;
      want = "value";
      i++;
      continue;
    }
    if (c === '"') {
      let j = i + 1;
      while (j < n && s[j] !== '"') j += s[j] === "\\" ? 2 : 1;
      if (j >= n) return true;
      want = want === "key" ? "colon" : "after";
      i = j + 1;
      continue;
    }
    if (want === "key") {
      if (c === "}" && stack.at(-1) === "{" && s.slice(0, i).trimEnd().endsWith("{")) {
        if (!close("{")) return false;
        i++;
        continue;
      }
      return false;
    }
    if (c === "{" || c === "[") {
      stack.push(c);
      want = c === "{" ? "key" : "value";
      i++;
      continue;
    }
    if (c === "]" && stack.at(-1) === "[" && s.slice(0, i).trimEnd().endsWith("[")) {
      if (!close("[")) return false;
      i++;
      continue;
    }
    const m = s.slice(i).match(/^(-?\d+(\.\d+)?([eE][+-]?\d+)?|true|false|null)/);
    if (!m) {
      // A literal or number cut at the end.
      return /^(-?\d*\.?\d*([eE][+-]?\d*)?|t(r(ue?)?)?|f(a(l(se?)?)?)?|n(u(ll?)?)?)$/.test(s.slice(i));
    }
    i += m[0].length;
    want = "after";
  }
  return true;
}

/** mimetype's sv(): encoding/csv over at most 10 records, consistent field counts, more than 1 field and 1 line. */
const sv = (sep: string): Matcher => (raw, limit) => {
  let s = new TextDecoder().decode(raw);
  const cut = raw.length >= limit;
  if (cut) {
    // The last line may be cut; mimetype drops it.
    const nl = s.lastIndexOf("\n");
    if (nl === -1) return false;
    s = s.slice(0, nl);
  }
  const records: number[] = [];
  let fields = 1;
  let quoted = false;
  let lineHasData = false;
  for (let i = 0; i < s.length && records.length < 10; i++) {
    const c = s[i];
    if (quoted) {
      if (c === '"') {
        if (s[i + 1] === '"') i++;
        else quoted = false;
      }
      continue;
    }
    if (c === '"') {
      quoted = true;
      lineHasData = true;
    } else if (c === sep) {
      fields++;
      lineHasData = true;
    } else if (c === "\n") {
      if (lineHasData) records.push(fields);
      fields = 1;
      lineHasData = false;
    } else if (c !== "\r") lineHasData = true;
  }
  if (lineHasData && records.length < 10) records.push(fields);
  if (records.length < 2) return false;
  return records[0] > 1 && records.every((r) => r === records[0]);
};

// --- tree ------------------------------------------------------------------------------------------------------

const zipChildren: Node[] = [
  {
    mime: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    ext: ".docx",
    match: ooxml("word/"),
  },
  { mime: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", ext: ".xlsx", match: ooxml("xl/") },
  {
    mime: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    ext: ".pptx",
    match: ooxml("ppt/"),
  },
  { mime: "application/vnd.ms-visio.drawing.main+xml", ext: ".vsdx", match: ooxml("visio/") },
  { mime: "application/epub+zip", ext: ".epub", match: zipMimetype("application/epub+zip") },
  {
    mime: "application/vnd.oasis.opendocument.text",
    ext: ".odt",
    aliases: ["application/x-vnd.oasis.opendocument.text"],
    match: zipMimetype("application/vnd.oasis.opendocument.text"),
  },
  {
    mime: "application/vnd.oasis.opendocument.spreadsheet",
    ext: ".ods",
    aliases: ["application/x-vnd.oasis.opendocument.spreadsheet"],
    match: zipMimetype("application/vnd.oasis.opendocument.spreadsheet"),
  },
  {
    mime: "application/vnd.oasis.opendocument.presentation",
    ext: ".odp",
    aliases: ["application/x-vnd.oasis.opendocument.presentation"],
    match: zipMimetype("application/vnd.oasis.opendocument.presentation"),
  },
  {
    mime: "application/vnd.oasis.opendocument.graphics",
    ext: ".odg",
    aliases: ["application/x-vnd.oasis.opendocument.graphics"],
    match: zipMimetype("application/vnd.oasis.opendocument.graphics"),
  },
  { mime: "application/jar", ext: ".jar", aliases: ["application/java-archive"], match: jar },
];

const WORD_CLSIDS = [
  [0x06, 0x09, 0x02, 0x00, 0x00, 0x00, 0x00, 0x00, 0xc0, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x46],
  [0x00, 0x09, 0x02, 0x00, 0x00, 0x00, 0x00, 0x00, 0xc0, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x46],
];
const EXCEL_CLSIDS = [
  [0x10, 0x08, 0x02, 0x00, 0x00, 0x00, 0x00, 0x00, 0xc0, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x46],
  [0x20, 0x08, 0x02, 0x00, 0x00, 0x00, 0x00, 0x00, 0xc0, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x46],
];
const PPT_CLSIDS = [
  [0x10, 0x8d, 0x81, 0x64, 0x9b, 0x4f, 0xcf, 0x11, 0x86, 0xea, 0x00, 0xaa, 0x00, 0xb9, 0x29, 0xe8],
  [0x70, 0xae, 0x7b, 0xea, 0x3b, 0xfb, 0xcd, 0x11, 0xa9, 0x03, 0x00, 0xaa, 0x00, 0x51, 0x0e, 0xa3],
];

const textChildren: Node[] = [
  { mime: "text/html; charset=utf-8", ext: ".html", match: html },
  { mime: "image/svg+xml", ext: ".svg", match: svg },
  { mime: "text/xml; charset=utf-8", ext: ".xml", aliases: ["application/xml"], match: xml },
  { mime: "text/x-php", ext: ".php", match: (raw) => /^<\?php/i.test(new TextDecoder().decode(trimStart(raw))) },
  { mime: "application/json", ext: ".json", match: json },
  { mime: "text/rtf", ext: ".rtf", aliases: ["application/rtf"], match: prefix("{\\rtf") },
  { mime: "text/csv", ext: ".csv", match: sv(",") },
  { mime: "text/tab-separated-values", ext: ".tsv", match: sv("\t") },
  { mime: "text/vcard", ext: ".vcf", match: (raw) => /^BEGIN:VCARD\r?\n/i.test(new TextDecoder().decode(raw)) },
  {
    mime: "text/calendar",
    ext: ".ics",
    match: (raw) => /^BEGIN:VCALENDAR\r?\n/i.test(new TextDecoder().decode(raw)),
  },
  { mime: "text/vtt", ext: ".vtt", match: (raw) => /^(﻿)?WEBVTT([ \t\r\n]|$)/.test(new TextDecoder().decode(raw)) },
];

const ROOT: Node[] = [
  { mime: "application/x-7z-compressed", ext: ".7z", match: prefix([0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c]) },
  {
    mime: "application/zip",
    ext: ".zip",
    aliases: ["application/x-zip", "application/x-zip-compressed"],
    match: prefix("PK\x03\x04", "PK\x05\x06", "PK\x07\x08"),
    children: zipChildren,
  },
  { mime: "application/pdf", ext: ".pdf", aliases: ["application/x-pdf"], match: prefix("%PDF-") },
  {
    mime: "application/x-ole-storage",
    ext: "",
    match: prefix([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]),
    children: [
      { mime: "application/msword", ext: ".doc", aliases: ["application/vnd.ms-word"], match: ole(WORD_CLSIDS) },
      {
        mime: "application/vnd.ms-excel",
        ext: ".xls",
        aliases: ["application/msexcel"],
        match: ole(EXCEL_CLSIDS, [
          [[0x09, 0x08, 0x10, 0x00, 0x00, 0x06, 0x05, 0x00], 512],
          [[0xfd, 0xff, 0xff, 0xff, 0x10], 512],
          [[0xfd, 0xff, 0xff, 0xff, 0x1f], 512],
          [[0xfd, 0xff, 0xff, 0xff, 0x22], 512],
          [[0xfd, 0xff, 0xff, 0xff, 0x23], 512],
          [[0xfd, 0xff, 0xff, 0xff, 0x28], 512],
          [[0xfd, 0xff, 0xff, 0xff, 0x29], 512],
        ]),
      },
      {
        mime: "application/vnd.ms-powerpoint",
        ext: ".ppt",
        aliases: ["application/mspowerpoint"],
        match: ole(PPT_CLSIDS, [
          [[0xa0, 0x46, 0x1d, 0xf0], 512],
          [[0x00, 0x6e, 0x1e, 0xf0], 512],
          [[0x0f, 0x00, 0xe8, 0x03], 512],
        ]),
      },
    ],
  },
  { mime: "application/postscript", ext: ".ps", match: prefix("%!PS-Adobe-") },
  { mime: "image/vnd.adobe.photoshop", ext: ".psd", aliases: ["image/x-psd", "application/photoshop"], match: psd },
  {
    mime: "application/ogg",
    ext: ".ogg",
    aliases: ["application/x-ogg"],
    match: prefix("OggS"),
    children: [
      {
        mime: "audio/ogg",
        ext: ".oga",
        match: (raw) =>
          startsWith(raw, ascii("\x7fFLAC"), 28) || startsWith(raw, ascii("\x01vorbis"), 28) ||
          startsWith(raw, ascii("OpusHead"), 28) || startsWith(raw, ascii("Speex   "), 28),
      },
      {
        mime: "video/ogg",
        ext: ".ogv",
        match: (raw) =>
          startsWith(raw, ascii("\x80theora"), 28) || startsWith(raw, ascii("fishead\0"), 28) ||
          startsWith(raw, ascii("\x01video\0\0\0"), 28),
      },
    ],
  },
  {
    mime: "image/png",
    ext: ".png",
    match: png,
    children: [{ mime: "image/vnd.mozilla.apng", ext: ".png", match: apng }],
  },
  { mime: "image/jpeg", ext: ".jpg", match: jpeg },
  {
    mime: "image/jxl",
    ext: ".jxl",
    match: prefix([0xff, 0x0a], [0, 0, 0, 0x0c, 0x4a, 0x58, 0x4c, 0x20, 0x0d, 0x0a, 0x87, 0x0a]),
  },
  {
    mime: "image/jp2",
    ext: ".jp2",
    match: (raw) => startsWith(raw, ascii("\0\0\0\x0cjP  \r\n\x87\n")) && startsWith(raw, ascii("jp2 "), 20),
  },
  { mime: "image/gif", ext: ".gif", match: gif },
  { mime: "image/webp", ext: ".webp", match: webp },
  { mime: "image/tiff", ext: ".tiff", match: tiff },
  { mime: "image/bmp", ext: ".bmp", aliases: ["image/x-bmp", "image/x-ms-bmp"], match: bmp },
  { mime: "image/x-icon", ext: ".ico", match: ico },
  { mime: "image/x-icns", ext: ".icns", match: prefix("icns") },
  {
    mime: "audio/mpeg",
    ext: ".mp3",
    aliases: ["audio/x-mpeg", "audio/mp3"],
    match: mp3,
  },
  { mime: "audio/flac", ext: ".flac", match: prefix("fLaC") },
  { mime: "audio/midi", ext: ".midi", aliases: ["audio/mid", "audio/x-midi"], match: prefix("MThd") },
  { mime: "audio/ape", ext: ".ape", match: prefix("MAC \x96\x0f\0\0\x34\0\0\0\x18\0\0\0\x90\xe3") },
  { mime: "audio/musepack", ext: ".mpc", match: prefix("MPCK") },
  { mime: "audio/amr", ext: ".amr", aliases: ["audio/amr-nb"], match: prefix("#!AMR") },
  { mime: "audio/wav", ext: ".wav", aliases: ["audio/x-wav", "audio/vnd.wave", "audio/wave"], match: riff("WAVE") },
  { mime: "audio/aiff", ext: ".aiff", aliases: ["audio/x-aiff"], match: aiff },
  { mime: "audio/basic", ext: ".au", match: prefix(".snd") },
  { mime: "video/mpeg", ext: ".mpeg", match: mpegPS },
  { mime: "video/quicktime", ext: ".mov", match: quicktime },
  { mime: "image/avif", ext: ".avif", match: ftyp("avif", "avis") },
  {
    mime: "video/3gpp",
    ext: ".3gp",
    aliases: ["video/3gp", "audio/3gpp"],
    match: ftyp("3gp1", "3gp2", "3gp3", "3gp4", "3gp5", "3gp6", "3gs7", "3ge6", "3ge7", "3gg6"),
  },
  {
    mime: "video/3gpp2",
    ext: ".3g2",
    aliases: ["video/3g2", "audio/3gpp2"],
    match: ftyp("3g24", "3g25", "3g26", "3g2a", "3g2b", "3g2c", "KDDI"),
  },
  { mime: "audio/x-m4a", ext: ".m4a", match: ftyp("M4A ") },
  { mime: "video/x-m4v", ext: ".m4v", match: ftyp("M4V ", "M4VH", "M4VP") },
  { mime: "image/heic", ext: ".heic", match: ftyp("heic", "heix") },
  { mime: "image/heic-sequence", ext: ".heic", match: ftyp("hevc", "hevx") },
  { mime: "image/heif", ext: ".heif", match: ftyp("mif1", "heim", "heis", "avic") },
  { mime: "image/heif-sequence", ext: ".heif", match: ftyp("msf1", "hevm", "hevs", "avcs") },
  { mime: "video/mp4", ext: ".mp4", match: anyFtyp },
  { mime: "video/webm", ext: ".webm", aliases: ["audio/webm"], match: ebml("webm") },
  { mime: "video/x-matroska", ext: ".mkv", match: ebml("matroska") },
  { mime: "video/x-msvideo", ext: ".avi", aliases: ["video/avi", "video/msvideo"], match: riff("AVI LIST") },
  { mime: "video/x-flv", ext: ".flv", match: flv },
  { mime: "video/x-ms-asf", ext: ".asf", aliases: ["video/asf", "video/x-ms-wmv"], match: asf },
  { mime: "audio/aac", ext: ".aac", match: aac },
  {
    mime: "application/gzip",
    ext: ".gz",
    aliases: [
      "application/x-gzip",
      "application/x-gunzip",
      "application/gzipped",
      "application/gzip-compressed",
      "application/x-gzip-compressed",
      "gzip/document",
    ],
    match: prefix([0x1f, 0x8b]),
  },
  { mime: "application/x-bzip2", ext: ".bz2", match: prefix("BZh") },
  { mime: "application/x-xz", ext: ".xz", match: prefix([0xfd, 0x37, 0x7a, 0x58, 0x5a, 0x00]) },
  { mime: "application/zstd", ext: ".zst", match: prefix([0x28, 0xb5, 0x2f, 0xfd]) },
  {
    mime: "application/x-rar-compressed",
    ext: ".rar",
    aliases: ["application/x-rar"],
    match: prefix("Rar!\x1a\x07\x00", "Rar!\x1a\x07\x01\x00"),
  },
  { mime: "application/x-tar", ext: ".tar", match: offset("ustar", 257) },
  {
    mime: "font/ttf",
    ext: ".ttf",
    aliases: ["font/sfnt", "application/x-font-ttf", "application/font-sfnt"],
    match: prefix([0x00, 0x01, 0x00, 0x00, 0x00]),
  },
  { mime: "font/woff", ext: ".woff", match: prefix("wOFF") },
  { mime: "font/woff2", ext: ".woff2", match: prefix("wOF2") },
  { mime: "font/otf", ext: ".otf", match: prefix([0x4f, 0x54, 0x54, 0x4f, 0x00]) },
  { mime: "application/wasm", ext: ".wasm", match: prefix([0x00, 0x61, 0x73, 0x6d]) },
  { mime: "application/vnd.microsoft.portable-executable", ext: ".exe", match: prefix("MZ") },
  { mime: "application/x-elf", ext: "", match: prefix("\x7fELF") },
  {
    mime: "application/vnd.sqlite3",
    ext: ".sqlite",
    aliases: ["application/x-sqlite3"],
    match: prefix("SQLite format 3\x00"),
  },
  { mime: "text/plain", ext: ".txt", match: text, children: textChildren },
];

const OCTET: MimeType = { mime: "application/octet-stream", extension: "", aliases: [] };

function walk(nodes: Node[], raw: Uint8Array, limit: number): Node | null {
  for (const n of nodes) {
    if (!n.match(raw, limit)) continue;
    return (n.children && walk(n.children, raw, limit)) || n;
  }
  return null;
}

/** mimetype.Detect over the first READ_LIMIT bytes. */
export function detectBytes(bytes: Uint8Array, limit = READ_LIMIT): MimeType {
  const raw = bytes.subarray(0, limit);
  const n = walk(ROOT, raw, limit);
  if (!n) return OCTET;
  let mime = n.mime;
  // text/plain carries the charset of what was read, as mimetype's String() does.
  if (mime === "text/plain") mime = `text/plain; charset=${plainCharset(raw, limit)}`;
  return { mime, extension: n.ext, aliases: n.aliases ?? [] };
}

/** mimetype.DetectReader on a File: reads only the leading bytes (a SpooledFile reads them from disk). */
export async function detectFile(file: Blob, limit = READ_LIMIT): Promise<MimeType> {
  const reader = file.stream().getReader();
  const chunks: Uint8Array[] = [];
  let got = 0;
  try {
    while (got < limit) {
      const { value, done } = await reader.read();
      if (done) break;
      chunks.push(value);
      got += value.length;
    }
  } finally {
    await reader.cancel().catch(() => {});
  }
  const buf = new Uint8Array(Math.min(got, limit));
  let at = 0;
  for (const c of chunks) {
    if (at >= buf.length) break;
    const part = c.subarray(0, buf.length - at);
    buf.set(part, at);
    at += part.length;
  }
  return detectBytes(buf, limit);
}
