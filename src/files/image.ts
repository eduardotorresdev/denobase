import { convertIndexedToRgb, decode as decodePng, encode as encodePng } from "fast-png";
import jpeg from "jpeg-js";
import { GifReader, GifWriter } from "omggif";
import { Unzlib, zlibSync } from "fflate";

/**
 * The image half of PB's filesystem.CreateThumb (disintegration/imaging): decode by magic bytes (first frame of a
 * GIF, EXIF orientation applied), Resize/Fit/Fill with imaging's Linear filter, encode back. Pure JS plus one WASM
 * decoder (WebP), so it runs wherever the package does, JSR included.
 */

/** Non-premultiplied RGBA, 8 bits per channel, like Go's image.NRGBA. */
export interface Rgba {
  width: number;
  height: number;
  data: Uint8Array;
}

export type ImageFormat = "png" | "jpeg" | "gif" | "webp";

/** A decode allocates width*height*4 bytes and a resize about as much again: past this the original is served. */
export const MAX_THUMB_SOURCE_PIXELS = 40_000_000;
export const MAX_THUMB_SOURCE_SIDE = 16_384;
/** Thumbs bigger than this would cost more than the original they replace. */
export const MAX_THUMB_SIDE = 8_192;

export function sniffFormat(b: Uint8Array): ImageFormat | null {
  if (b.length >= 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return "png";
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return "jpeg";
  if (b.length >= 6 && ascii(b, 0, 4) === "GIF8") return "gif";
  if (b.length >= 12 && ascii(b, 0, 4) === "RIFF" && ascii(b, 8, 4) === "WEBP") return "webp";
  return null;
}

const ascii = (b: Uint8Array, at: number, n: number) => String.fromCharCode(...b.subarray(at, at + n));
const u16be = (b: Uint8Array, at: number) => (b[at] << 8) | b[at + 1];
const u16le = (b: Uint8Array, at: number) => b[at] | (b[at + 1] << 8);
const u24le = (b: Uint8Array, at: number) => b[at] | (b[at + 1] << 8) | (b[at + 2] << 16);
const u32be = (b: Uint8Array, at: number) => ((b[at] << 24) | (b[at + 1] << 16) | (b[at + 2] << 8) | b[at + 3]) >>> 0;

/** Dimensions from the header alone, so an oversized image is refused before anything is allocated for it. */
export function imageSize(b: Uint8Array): { width: number; height: number } | null {
  switch (sniffFormat(b)) {
    case "png":
      return b.length >= 24 ? { width: u32be(b, 16), height: u32be(b, 20) } : null;
    case "gif":
      return b.length >= 10 ? { width: u16le(b, 6), height: u16le(b, 8) } : null;
    case "webp": {
      const chunk = ascii(b, 12, 4);
      if (chunk === "VP8X" && b.length >= 30) return { width: u24le(b, 24) + 1, height: u24le(b, 27) + 1 };
      if (chunk === "VP8L" && b.length >= 25) {
        const v = b[21] | (b[22] << 8) | (b[23] << 16) | (b[24] << 24);
        return { width: (v & 0x3fff) + 1, height: ((v >>> 14) & 0x3fff) + 1 };
      }
      if (chunk === "VP8 " && b.length >= 30) return { width: u16le(b, 26) & 0x3fff, height: u16le(b, 28) & 0x3fff };
      return null;
    }
    case "jpeg": {
      let at = 2;
      while (at + 9 < b.length) {
        if (b[at] !== 0xff) return null;
        const marker = b[at + 1];
        if (marker === 0xff) {
          at++;
          continue;
        }
        // SOF0..SOF15 except DHT (C4), JPG (C8) and DAC (CC) carry the frame size.
        if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
          return { width: u16be(b, at + 7), height: u16be(b, at + 5) };
        }
        at += 2 + u16be(b, at + 2);
      }
      return null;
    }
    default:
      return null;
  }
}

export class ImageTooLargeError extends Error {}

/** Decodes the first frame; throws on an unknown format, a broken file or one past the size guard. */
export async function decodeImage(b: Uint8Array): Promise<Rgba> {
  const format = sniffFormat(b);
  if (!format) throw new Error("unsupported image format");
  const size = imageSize(b);
  if (!size || !size.width || !size.height) throw new Error("unreadable image header");
  if (
    size.width > MAX_THUMB_SOURCE_SIDE || size.height > MAX_THUMB_SOURCE_SIDE ||
    size.width * size.height > MAX_THUMB_SOURCE_PIXELS
  ) {
    throw new ImageTooLargeError(`image ${size.width}x${size.height} is past the thumb size guard`);
  }
  switch (format) {
    case "png":
      return fromPng(b);
    case "jpeg": {
      const img = jpeg.decode(b, {
        useTArray: true,
        formatAsRGBA: true,
        maxResolutionInMP: MAX_THUMB_SOURCE_PIXELS / 1e6,
        maxMemoryUsageInMB: 1024,
      });
      return orient({ width: img.width, height: img.height, data: img.data }, exifOrientation(b));
    }
    case "gif": {
      const r = new GifReader(b);
      // omggif sizes its index buffer from the frame descriptor, not the screen the guard checked; Go's image/gif
      // refuses a frame past the screen bounds the same way.
      const f = r.frameInfo(0);
      if (f.x + f.width > r.width || f.y + f.height > r.height) {
        throw new Error("gif: frame bounds larger than image bounds");
      }
      const data = new Uint8Array(r.width * r.height * 4);
      r.decodeAndBlitFrameRGBA(0, data);
      return { width: r.width, height: r.height, data };
    }
    case "webp": {
      // Loaded on first use: the WASM decoder is the heaviest piece and most apps never see a WebP.
      const { default: decodeWebp } = await import("@jsquash/webp/decode.js");
      const img = await decodeWebp(b.slice().buffer);
      return { width: img.width, height: img.height, data: new Uint8Array(img.data.buffer) };
    }
  }
}

/** Chunks fast-png needs; the rest (iCCP above all, which it inflates with no limit) is dropped before decoding. */
const PNG_KEEP = new Set(["IHDR", "PLTE", "tRNS", "IDAT", "IEND"]);
const ADAM7 = [[0, 0, 8, 8], [4, 0, 8, 8], [0, 4, 4, 8], [2, 0, 4, 4], [0, 2, 2, 4], [1, 0, 2, 2], [0, 1, 1, 2]];
const PNG_CHANNELS: Record<number, number> = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 };

/**
 * Walks the chunks, keeps only what decoding needs and inflates the IDAT stream once with a cap at the size the
 * header implies, so a zlib bomb is refused before fast-png (which inflates without a limit) ever sees it.
 */
export function sanitizePng(b: Uint8Array): { png: Uint8Array; key: number[] | null } {
  if (b.length < 33) throw new Error("png: truncated");
  const width = u32be(b, 16), height = u32be(b, 20), depth = b[24], channels = PNG_CHANNELS[b[25]], interlace = b[28];
  if (!channels) throw new Error("png: invalid color type");
  const rowBytes = (w: number) => (w > 0 ? 1 + Math.ceil((w * channels * depth) / 8) : 0);
  let expected = 0;
  if (interlace === 1) {
    for (const [x, y, dx, dy] of ADAM7) {
      const pw = Math.ceil((width - x) / dx), ph = Math.ceil((height - y) / dy);
      if (pw > 0 && ph > 0) expected += ph * rowBytes(pw);
    }
  } else expected = height * rowBytes(width);
  // fast-png de-interlaces as if every sample were a byte, so a sub-byte Adam7 image is rewritten here as a plain one.
  const adam7Packed = interlace === 1 && depth < 8;
  const raw: Uint8Array[] = [];
  let inflated = 0;
  const z = new Unzlib((chunk) => {
    inflated += chunk.length;
    if (inflated > expected) throw new Error("png: image data larger than its header declares");
    if (adam7Packed) raw.push(chunk);
  });
  let idatAt = -1;
  const parts: Uint8Array[] = [b.subarray(0, 8)];
  let key: number[] | null = null;
  let at = 8;
  while (at + 12 <= b.length) {
    const len = u32be(b, at);
    const type = ascii(b, at + 4, 4);
    const end = at + 12 + len;
    if (end > b.length) throw new Error("png: truncated chunk");
    // A gray or truecolor tRNS is a color key read here: fast-png validates it as if it were per-pixel alpha.
    if (type === "tRNS" && (channels === 1 || channels === 3)) {
      if (len >= channels * 2) key = Array.from({ length: channels }, (_, k) => u16be(b, at + 8 + k * 2));
    } else if (type === "IDAT") {
      if (!adam7Packed) parts.push(b.subarray(at, end));
      else if (idatAt < 0) idatAt = parts.length;
      z.push(b.subarray(at + 8, at + 8 + len));
    } else if (PNG_KEEP.has(type)) parts.push(b.subarray(at, end));
    at = end;
    if (type === "IEND") break;
  }
  if (adam7Packed) {
    z.push(new Uint8Array(0), true);
    if (idatAt < 0) throw new Error("png: no image data");
    const plain = deinterlacePacked(concat(raw), width, height, channels * depth);
    if (ascii(b, 12, 4) !== "IHDR") throw new Error("png: IHDR must come first");
    const ihdr = b.slice(8, 33);
    ihdr[20] = 0; // the interlace method: 8 bytes of length and type, then its 13th data byte
    parts[1] = withCrc(ihdr);
    parts.splice(idatAt, 0, chunk("IDAT", zlibSync(plain)));
  }
  return { png: concat(parts), key };
}

function concat(parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) out.set(p, (o += p.length) - p.length);
  return out;
}

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

/** Rewrites the CRC of a whole chunk (length, type, data, crc) after its data changed. */
function withCrc(c: Uint8Array): Uint8Array {
  let crc = 0xffffffff;
  for (let i = 4; i < c.length - 4; i++) crc = CRC_TABLE[(crc ^ c[i]) & 0xff] ^ (crc >>> 8);
  new DataView(c.buffer, c.byteOffset).setUint32(c.length - 4, (crc ^ 0xffffffff) >>> 0);
  return c;
}

function chunk(type: string, data: Uint8Array): Uint8Array {
  const c = new Uint8Array(12 + data.length);
  new DataView(c.buffer).setUint32(0, data.length);
  for (let i = 0; i < 4; i++) c[4 + i] = type.charCodeAt(i);
  c.set(data, 8);
  return withCrc(c);
}

/** PNG's per-row unfilter; bpp is 1 for every sub-byte format. */
function unfilter(row: Uint8Array, prev: Uint8Array | null, filter: number, bpp: number): void {
  for (let i = 0; i < row.length; i++) {
    const a = i >= bpp ? row[i - bpp] : 0, up = prev ? prev[i] : 0, c = prev && i >= bpp ? prev[i - bpp] : 0;
    switch (filter) {
      case 0:
        break;
      case 1:
        row[i] = (row[i] + a) & 0xff;
        break;
      case 2:
        row[i] = (row[i] + up) & 0xff;
        break;
      case 3:
        row[i] = (row[i] + ((a + up) >> 1)) & 0xff;
        break;
      case 4: {
        const p = a + up - c, pa = Math.abs(p - a), pb = Math.abs(p - up), pc = Math.abs(p - c);
        row[i] = (row[i] + (pa <= pb && pa <= pc ? a : pb <= pc ? up : c)) & 0xff;
        break;
      }
      default:
        throw new Error("png: invalid filter type");
    }
  }
}

/**
 * Adam7 (sub-byte pixels) to the non-interlaced stream fast-png reads: each pass unfiltered, its pixels scattered to
 * their place in packed rows, every row then sent with filter 0.
 */
export function deinterlacePacked(data: Uint8Array, width: number, height: number, bits: number): Uint8Array {
  const stride = Math.ceil((width * bits) / 8);
  const out = new Uint8Array(height * (stride + 1));
  const mask = (1 << bits) - 1;
  let at = 0;
  for (const [x0, y0, dx, dy] of ADAM7) {
    const pw = Math.ceil((width - x0) / dx), ph = Math.ceil((height - y0) / dy);
    if (pw <= 0 || ph <= 0) continue;
    const rb = Math.ceil((pw * bits) / 8);
    let prev: Uint8Array | null = null;
    for (let j = 0; j < ph; j++) {
      if (at + 1 + rb > data.length) throw new Error("png: truncated image data");
      const row = data.subarray(at + 1, at + 1 + rb);
      unfilter(row, prev, data[at], 1);
      prev = row;
      at += 1 + rb;
      const y = y0 + j * dy;
      for (let i = 0; i < pw; i++) {
        const v = (row[(i * bits) >> 3] >> (8 - bits - ((i * bits) & 7))) & mask;
        const xb = (x0 + i * dx) * bits;
        out[y * (stride + 1) + 1 + (xb >> 3)] |= v << (8 - bits - (xb & 7));
      }
    }
  }
  return out;
}

function fromPng(b: Uint8Array): Rgba {
  const clean = sanitizePng(b);
  const png = decodePng(clean.png);
  const { width, height, depth } = png;
  const n = width * height;
  const data = new Uint8Array(n * 4);
  if (png.palette) {
    // convertIndexedToRgb unpacks sub-byte indices and applies tRNS itself.
    const src = convertIndexedToRgb(png);
    const ch = png.palette[0]?.length ?? 3;
    for (let i = 0, o = 0; o < data.length; i += ch, o += 4) {
      data[o] = src[i];
      data[o + 1] = src[i + 1];
      data[o + 2] = src[i + 2];
      data[o + 3] = ch === 4 ? src[i + 3] : 255;
    }
    return { width, height, data };
  }
  const channels = png.channels;
  // Raw samples at the stored depth: fast-png leaves rows of sub-byte samples packed, padded to a byte per row.
  const raw = png.data;
  const rowBits = width * channels * depth;
  const rowStride = Math.ceil(rowBits / 8);
  const sample = depth < 8
    ? (p: number, k: number) => {
      const bit = (p % width) * channels * depth + k * depth;
      const byte = raw[Math.floor(p / width) * rowStride + (bit >> 3)];
      return (byte >> (8 - depth - (bit & 7))) & ((1 << depth) - 1);
    }
    : (p: number, k: number) => raw[p * channels + k];
  const max = (1 << depth) - 1;
  const to8 = (v: number) => (depth === 16 ? v >> 8 : depth < 8 ? Math.round((v * 255) / max) : v);
  // tRNS on a gray or truecolor image keys one color (raw sample values) as fully transparent, as Go's image/png does.
  const key = clean.key;
  for (let p = 0, o = 0; p < n; p++, o += 4) {
    if (channels <= 2) {
      const g = sample(p, 0);
      data[o] = data[o + 1] = data[o + 2] = to8(g);
      data[o + 3] = channels === 2 ? to8(sample(p, 1)) : key && g === key[0] ? 0 : 255;
    } else {
      const r = sample(p, 0), g = sample(p, 1), bl = sample(p, 2);
      data[o] = to8(r);
      data[o + 1] = to8(g);
      data[o + 2] = to8(bl);
      data[o + 3] = channels === 4 ? to8(sample(p, 3)) : key && r === key[0] && g === key[1] && bl === key[2] ? 0 : 255;
    }
  }
  return { width, height, data };
}

/** The EXIF Orientation tag of a JPEG (1 when absent), what imaging.AutoOrientation reads. */
export function exifOrientation(b: Uint8Array): number {
  let at = 2;
  while (at + 4 < b.length && b[at] === 0xff) {
    const marker = b[at + 1];
    const len = u16be(b, at + 2);
    if (marker === 0xda) break;
    if (marker === 0xe1 && ascii(b, at + 4, 6) === "Exif\0\0") {
      const tiff = at + 10;
      const le = ascii(b, tiff, 2) === "II";
      const r16 = (p: number) => (le ? u16le(b, p) : u16be(b, p));
      const r32 = (p: number) => (le ? (u16le(b, p) | (u16le(b, p + 2) << 16)) >>> 0 : u32be(b, p));
      const ifd = tiff + r32(tiff + 4);
      if (ifd + 2 > b.length) return 1;
      const n = r16(ifd);
      for (let i = 0; i < n; i++) {
        const e = ifd + 2 + i * 12;
        if (e + 12 > b.length) return 1;
        if (r16(e) === 0x0112) {
          const o = r16(e + 8);
          return o >= 1 && o <= 8 ? o : 1;
        }
      }
      return 1;
    }
    at += 2 + len;
  }
  return 1;
}

/** Applies an EXIF orientation (2..8) so the pixels read upright, like imaging's fixOrientation. */
export function orient(img: Rgba, o: number): Rgba {
  if (o <= 1 || o > 8) return img;
  const { width: w, height: h, data } = img;
  const swap = o >= 5;
  const W = swap ? h : w;
  const H = swap ? w : h;
  const out = new Uint8Array(data.length);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let dx: number, dy: number;
      switch (o) {
        case 2: // flip horizontal
          [dx, dy] = [w - 1 - x, y];
          break;
        case 3: // rotate 180
          [dx, dy] = [w - 1 - x, h - 1 - y];
          break;
        case 4: // flip vertical
          [dx, dy] = [x, h - 1 - y];
          break;
        case 5: // transpose
          [dx, dy] = [y, x];
          break;
        case 6: // rotate 270 (90 clockwise)
          [dx, dy] = [h - 1 - y, x];
          break;
        case 7: // transverse
          [dx, dy] = [h - 1 - y, w - 1 - x];
          break;
        default: // 8: rotate 90 (counter-clockwise)
          [dx, dy] = [y, w - 1 - x];
      }
      out.set(data.subarray((y * w + x) * 4, (y * w + x) * 4 + 4), (dy * W + dx) * 4);
    }
  }
  return { width: W, height: H, data: out };
}

// --- imaging's resampling (Linear filter, alpha-weighted, separable) ---

const linear = (x: number) => {
  x = Math.abs(x);
  return x < 1 ? 1 - x : 0;
};

interface Weights {
  start: number;
  w: Float64Array;
}

function weights(dst: number, src: number): Weights[] {
  const du = src / dst;
  const scale = Math.max(du, 1);
  const ru = Math.ceil(scale); // Linear support is 1
  const out: Weights[] = [];
  for (let v = 0; v < dst; v++) {
    const fu = (v + 0.5) * du - 0.5;
    const begin = Math.max(0, Math.ceil(fu - ru));
    const end = Math.min(src - 1, Math.floor(fu + ru));
    const w = new Float64Array(Math.max(0, end - begin + 1));
    let sum = 0;
    for (let u = begin; u <= end; u++) {
      const k = linear((u - fu) / scale);
      w[u - begin] = k;
      sum += k;
    }
    if (sum > 0) { for (let i = 0; i < w.length; i++) w[i] /= sum; }
    out.push({ start: begin, w });
  }
  return out;
}

const clamp8 = (v: number) => (v <= 0 ? 0 : v >= 255 ? 255 : Math.round(v));

/** One pass along x (horizontal) or y; colors weighted by alpha so transparent pixels do not bleed. */
function pass(img: Rgba, dstW: number, dstH: number, horizontal: boolean): Rgba {
  const { width: sw, data } = img;
  const ws = horizontal ? weights(dstW, img.width) : weights(dstH, img.height);
  const out = new Uint8Array(dstW * dstH * 4);
  for (let y = 0; y < dstH; y++) {
    for (let x = 0; x < dstW; x++) {
      const { start, w } = ws[horizontal ? x : y];
      let r = 0, g = 0, b = 0, a = 0;
      for (let i = 0; i < w.length; i++) {
        const s = horizontal ? (y * sw + start + i) * 4 : ((start + i) * sw + x) * 4;
        const aw = data[s + 3] * w[i];
        r += data[s] * aw;
        g += data[s + 1] * aw;
        b += data[s + 2] * aw;
        a += aw;
      }
      const o = (y * dstW + x) * 4;
      if (a !== 0) {
        out[o] = clamp8(r / a);
        out[o + 1] = clamp8(g / a);
        out[o + 2] = clamp8(b / a);
        out[o + 3] = clamp8(a);
      }
    }
  }
  return { width: dstW, height: dstH, data: out };
}

/** imaging.Resize: a 0 side keeps the aspect ratio. */
export function resize(img: Rgba, w: number, h: number): Rgba {
  if (w === 0) w = Math.max(1, Math.floor((h * img.width) / img.height + 0.5));
  if (h === 0) h = Math.max(1, Math.floor((w * img.height) / img.width + 0.5));
  if (w === img.width && h === img.height) return { ...img, data: img.data.slice() };
  let out = img;
  if (w !== img.width) out = pass(out, w, out.height, true);
  if (h !== img.height) out = pass(out, out.width, h, false);
  return out;
}

/** imaging.Fit: shrink into a w x h box, never enlarge. */
export function fit(img: Rgba, w: number, h: number): Rgba {
  if (img.width <= w && img.height <= h) return { ...img, data: img.data.slice() };
  const srcAspect = img.width / img.height;
  const maxAspect = w / h;
  let nw: number, nh: number;
  if (srcAspect > maxAspect) {
    nw = w;
    nh = Math.max(1, Math.floor(w / srcAspect));
  } else {
    nh = h;
    nw = Math.max(1, Math.floor(h * srcAspect));
  }
  return resize(img, nw, nh);
}

export type Anchor = "center" | "top" | "bottom";

function crop(img: Rgba, w: number, h: number, anchor: Anchor): Rgba {
  w = Math.min(w, img.width);
  h = Math.min(h, img.height);
  const x0 = Math.floor((img.width - w) / 2);
  const y0 = anchor === "top" ? 0 : anchor === "bottom" ? img.height - h : Math.floor((img.height - h) / 2);
  const out = new Uint8Array(w * h * 4);
  for (let y = 0; y < h; y++) {
    const s = ((y0 + y) * img.width + x0) * 4;
    out.set(img.data.subarray(s, s + w * 4), y * w * 4);
  }
  return { width: w, height: h, data: out };
}

/** imaging.Fill: cover w x h, then crop the overflow at the anchor. */
export function fill(img: Rgba, w: number, h: number, anchor: Anchor): Rgba {
  if (img.width === w && img.height === h) return { ...img, data: img.data.slice() };
  const srcAspect = img.width / img.height;
  const dstAspect = w / h;
  if (img.width >= 100 && img.height >= 100) {
    // Big sources are cropped first, then resized: less to resample.
    const c = srcAspect < dstAspect
      ? crop(img, img.width, Math.max(1, Math.floor(img.width / dstAspect + 0.5)), anchor)
      : crop(img, Math.max(1, Math.floor(img.height * dstAspect + 0.5)), img.height, anchor);
    return resize(c, w, h);
  }
  const r = srcAspect < dstAspect ? resize(img, w, 0) : resize(img, 0, h);
  return crop(r, w, h, anchor);
}

// --- encoders ---

/** imaging.Encode: JPEG at quality 95, GIF on the Plan 9 palette with Floyd-Steinberg, PNG otherwise. */
export function encodeImage(img: Rgba, as: "jpeg" | "gif" | "png"): Uint8Array {
  if (as === "jpeg") {
    // JPEG has no alpha; Go's encoder drops it the same way.
    return jpeg.encode({ width: img.width, height: img.height, data: img.data }, 95).data;
  }
  if (as === "gif") return encodeGif(img);
  return encodePng({ width: img.width, height: img.height, data: img.data, channels: 4, depth: 8 });
}

/** Go's palette.Plan9, the palette image/gif.Encode quantizes to when no options are given. */
const PLAN9: number[][] = (() => {
  const p: number[][] = [];
  for (let r = 0; r < 4; r++) {
    for (let v = 0; v < 4; v++) {
      for (let g = 0; g < 4; g++) {
        for (let b = 0; b < 4; b++) {
          const den = Math.max(r, g, b);
          if (den === 0) p.push([17 * v, 17 * v, 17 * v]);
          else {
            const num = 17 * (4 * den + v);
            p.push([Math.floor((r * num) / den), Math.floor((g * num) / den), Math.floor((b * num) / den)]);
          }
        }
      }
    }
  }
  return p;
})();

function nearest(r: number, g: number, b: number): number {
  let best = 0, bestD = Infinity;
  for (let i = 0; i < PLAN9.length; i++) {
    const [pr, pg, pb] = PLAN9[i];
    const d = (r - pr) ** 2 + (g - pg) ** 2 + (b - pb) ** 2;
    if (d < bestD) [best, bestD] = [i, d];
  }
  return best;
}

function encodeGif(img: Rgba): Uint8Array {
  const { width: w, height: h, data } = img;
  // Premultiplied like Go's draw onto a paletted image: transparent pixels become black.
  const err = new Float32Array(w * h * 3);
  for (let i = 0; i < w * h; i++) {
    const a = data[i * 4 + 3] / 255;
    for (let k = 0; k < 3; k++) err[i * 3 + k] = data[i * 4 + k] * a;
  }
  const idx = new Uint8Array(w * h);
  const cache = new Map<number, number>();
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      const r = clamp8(err[i * 3]), g = clamp8(err[i * 3 + 1]), b = clamp8(err[i * 3 + 2]);
      const key = (r << 16) | (g << 8) | b;
      let p = cache.get(key);
      if (p === undefined) cache.set(key, p = nearest(r, g, b));
      idx[i] = p;
      const c = PLAN9[p];
      const e = [r - c[0], g - c[1], b - c[2]];
      const spread = (dx: number, dy: number, f: number) => {
        const nx = x + dx, ny = y + dy;
        if (nx < 0 || nx >= w || ny >= h) return;
        const j = (ny * w + nx) * 3;
        for (let k = 0; k < 3; k++) err[j + k] += e[k] * f;
      };
      spread(1, 0, 7 / 16);
      spread(-1, 1, 3 / 16);
      spread(0, 1, 5 / 16);
      spread(1, 1, 1 / 16);
    }
  }
  const out = new Uint8Array(2048 + w * h * 2);
  const palette = PLAN9.map(([r, g, b]) => (r << 16) | (g << 8) | b);
  const gw = new GifWriter(out, w, h, { palette });
  gw.addFrame(0, 0, w, h, idx);
  return out.slice(0, gw.end());
}
