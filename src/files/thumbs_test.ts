import { assert, assertEquals, assertRejects } from "@std/assert";
import { decode as decodePng, encode as encodePng } from "fast-png";
import { unzlibSync, zlibSync } from "fflate";
import { pngOf, twoTone } from "./testkit.ts";
import jpeg from "jpeg-js";
import encodeWebp from "@jsquash/webp/encode.js";
import { decodeImage, encodeImage, exifOrientation, imageSize, orient, type Rgba, sniffFormat } from "./image.ts";
import { renderThumb, Thumbs } from "./thumbs.ts";
import { ThumbPool } from "./thumb_pool.ts";
import { MemoryStorage, readAll } from "./storage.ts";

const px = (
  img: Rgba,
  x: number,
  y: number,
) => [...img.data.subarray((y * img.width + x) * 4, (y * img.width + x) * 4 + 4)];
const near = (a: number[], b: number[], tol = 40) => a.every((v, i) => Math.abs(v - b[i]) <= tol);
const RED = [255, 0, 0, 255], BLUE = [0, 0, 255, 255];

async function thumbOf(src: Uint8Array, type: string, size: string) {
  const t = await renderThumb(src, type, size);
  return { type: t.type, img: await decodeImage(t.bytes) };
}

Deno.test("WxH fills and crops from the center, t from the top, b from the bottom", async () => {
  const wide = pngOf(twoTone(200, 100, "lr"));
  const c = await thumbOf(wide, "image/png", "100x100");
  assertEquals([c.img.width, c.img.height, c.type], [100, 100, "image/png"]);
  // The middle half of a red|blue image keeps both colors.
  assert(near(px(c.img, 5, 50), RED) && near(px(c.img, 95, 50), BLUE));

  const tall = pngOf(twoTone(100, 200, "tb"));
  const t = await thumbOf(tall, "image/png", "50x50t");
  const b = await thumbOf(tall, "image/png", "50x50b");
  const m = await thumbOf(tall, "image/png", "50x50");
  assertEquals([t.img.width, t.img.height], [50, 50]);
  assert(near(px(t.img, 25, 2), RED) && near(px(t.img, 25, 47), RED));
  assert(near(px(b.img, 25, 2), BLUE) && near(px(b.img, 25, 47), BLUE));
  assert(near(px(m.img, 25, 2), RED) && near(px(m.img, 25, 47), BLUE));

  // Small sources resize first, then crop (imaging.Fill's other branch).
  const small = await thumbOf(pngOf(twoTone(40, 20, "lr")), "image/png", "10x10");
  assertEquals([small.img.width, small.img.height], [10, 10]);
});

Deno.test("WxHf fits without cropping or enlarging; 0xH and Wx0 keep the aspect ratio", async () => {
  const tall = pngOf(twoTone(100, 200, "tb"));
  const f = await thumbOf(tall, "image/png", "50x50f");
  assertEquals([f.img.width, f.img.height], [25, 50]);
  assert(near(px(f.img, 12, 2), RED) && near(px(f.img, 12, 47), BLUE));
  const big = await thumbOf(tall, "image/png", "500x500f");
  assertEquals([big.img.width, big.img.height], [100, 200]);

  const wide = pngOf(twoTone(200, 100, "lr"));
  const h = await thumbOf(wide, "image/png", "0x50");
  const w = await thumbOf(wide, "image/png", "50x0");
  assertEquals([h.img.width, h.img.height, w.img.width, w.img.height], [100, 50, 50, 25]);
  // Resize enlarges, like imaging.Resize.
  const up = await thumbOf(wide, "image/png", "400x0");
  assertEquals([up.img.width, up.img.height], [400, 200]);
});

Deno.test("output format follows PB: jpeg stays jpeg, gif stays gif, webp and image/jpg become png", async () => {
  const img = twoTone(120, 120, "lr");
  const jpg = jpeg.encode(img, 90).data;
  assertEquals((await renderThumb(jpg, "image/jpeg", "100x100")).type, "image/jpeg");
  assertEquals(sniffFormat((await renderThumb(jpg, "image/jpeg", "100x100")).bytes), "jpeg");
  assertEquals((await renderThumb(jpg, "image/jpg", "100x100")).type, "image/png");

  const gif = encodeImage(img, "gif");
  const g = await thumbOf(gif, "image/gif", "50x50");
  assertEquals([g.type, g.img.width], ["image/gif", 50]);
  assert(near(px(g.img, 2, 25), RED, 60) && near(px(g.img, 47, 25), BLUE, 60));

  const webp = new Uint8Array(await encodeWebp(new ImageData(new Uint8ClampedArray(img.data), 120, 120)));
  assertEquals(sniffFormat(webp), "webp");
  assertEquals(imageSize(webp), { width: 120, height: 120 });
  const w = await thumbOf(webp, "image/webp", "60x30");
  assertEquals([w.type, w.img.width, w.img.height], ["image/png", 60, 30]);
  assert(near(px(w.img, 2, 15), RED) && near(px(w.img, 57, 15), BLUE));
});

Deno.test("png variants decode: gray, palette, 16-bit and alpha", async () => {
  const gray = encodePng({ width: 2, height: 1, data: new Uint8Array([0, 255]), channels: 1, depth: 8 });
  assertEquals([...(await decodeImage(gray)).data], [0, 0, 0, 255, 255, 255, 255, 255]);
  const deep = encodePng({ width: 1, height: 1, data: new Uint16Array([65535, 0, 0, 32768]), channels: 4, depth: 16 });
  assertEquals([...(await decodeImage(deep)).data], [255, 0, 0, 128]);
  const pal = encodePng({
    width: 2,
    height: 1,
    data: new Uint8Array([0, 1]),
    channels: 1,
    depth: 8,
    palette: [[10, 20, 30], [40, 50, 60]],
  });
  assertEquals([...(await decodeImage(pal)).data], [10, 20, 30, 255, 40, 50, 60, 255]);
  // Transparent pixels do not bleed their color into a resample.
  const half = pngOf({ width: 2, height: 1, data: new Uint8Array([255, 0, 0, 255, 0, 255, 0, 0]) });
  const out = decodePng((await renderThumb(half, "image/png", "1x0")).bytes);
  assertEquals([...out.data].slice(0, 3), [255, 0, 0]);
});

Deno.test("EXIF orientation is read from JPEG and applied", () => {
  // Minimal APP1 with an Orientation=6 tag, little endian.
  const exif = [
    ...[0xff, 0xd8, 0xff, 0xe1, 0x00, 0x22],
    ...[0x45, 0x78, 0x69, 0x66, 0, 0],
    ...[0x49, 0x49, 0x2a, 0x00, 0x08, 0, 0, 0],
    ...[1, 0, 0x12, 0x01, 3, 0, 1, 0, 0, 0, 6, 0, 0, 0, 0, 0, 0, 0],
  ];
  assertEquals(exifOrientation(new Uint8Array(exif)), 6);
  assertEquals(exifOrientation(new Uint8Array([0xff, 0xd8, 0xff, 0xda, 0, 2])), 1);
  // 2x1 [A B] rotated 90 clockwise becomes 1x2 [A; B].
  const img = { width: 2, height: 1, data: new Uint8Array([1, 1, 1, 255, 2, 2, 2, 255]) };
  const r = orient(img, 6);
  assertEquals([r.width, r.height, r.data[0], r.data[4]], [1, 2, 1, 2]);
  const f = orient(img, 2);
  assertEquals([f.data[0], f.data[4]], [2, 1]);
});

Deno.test("bad input fails: unknown format, broken bytes, zero size, oversized source", async () => {
  await assertRejects(() => renderThumb(new TextEncoder().encode("plain text"), "image/png", "100x100"));
  await assertRejects(() => renderThumb(pngOf(twoTone(4, 4, "lr")).slice(0, 30), "image/png", "100x100"));
  await assertRejects(() => renderThumb(pngOf(twoTone(4, 4, "lr")), "image/png", "0x0"), Error, "cannot be zero");
  await assertRejects(() => renderThumb(pngOf(twoTone(4, 4, "lr")), "image/png", "9000x10"), Error, "capped");
  // A header claiming 20000x20000 is refused before any pixel is allocated.
  const huge = pngOf(twoTone(1, 1, "lr"));
  new DataView(huge.buffer, huge.byteOffset).setUint32(16, 20000);
  new DataView(huge.buffer, huge.byteOffset).setUint32(20, 20000);
  await assertRejects(() => decodeImage(huge), Error, "size guard");
});

Deno.test("Thumbs shares one generation per key and runs at most two at once", async () => {
  const storage = new MemoryStorage();
  let gets = 0, live = 0, peak = 0;
  const slow: typeof storage = Object.create(storage);
  slow.stat = (key) => storage.stat(key);
  slow.get = async (key, opts) => {
    gets++;
    live++;
    peak = Math.max(peak, live);
    await new Promise((r) => setTimeout(r, 20));
    live--;
    return await storage.get(key, opts);
  };
  for (let i = 0; i < 4; i++) {
    await storage.put(`c/r/f${i}.png`, pngOf(twoTone(20, 20, "lr")), { type: "image/png" });
  }
  const thumbs = new Thumbs(2);
  const same = Array.from(
    { length: 5 },
    () => thumbs.create(slow, "c/r/f0.png", "c/r/thumbs_f0.png/10x10_f0.png", "10x10"),
  );
  assertEquals(thumbs.inFlight, 1);
  await Promise.all(same);
  assertEquals(gets, 1);
  assertEquals(thumbs.inFlight, 0);
  const stored = await storage.get("c/r/thumbs_f0.png/10x10_f0.png");
  assertEquals(stored?.type, "image/png");
  assertEquals((await decodeImage(await readAll(stored!.body))).width, 10);

  await Promise.all([1, 2, 3].map((i) => thumbs.create(slow, `c/r/f${i}.png`, `c/r/t${i}`, "10x10")));
  assertEquals([gets, peak], [4, 2]);
  // A failed generation is forgotten, so the next request tries again.
  await assertRejects(() => thumbs.create(slow, "c/r/missing.png", "c/r/t9", "10x10"));
  assertEquals(thumbs.inFlight, 0);
});

Deno.test("Thumbs gives up waiting for a slot after maxWait", async () => {
  const storage = new MemoryStorage();
  let release!: () => void;
  const blocked: typeof storage = Object.create(storage);
  blocked.get = () => new Promise((r) => release = () => r(null));
  const thumbs = new Thumbs(1, 30);
  const first = thumbs.create(blocked, "a", "ta", "10x10");
  await assertRejects(() => thumbs.create(blocked, "b", "tb", "10x10"), Error, "timed out");
  release();
  await assertRejects(() => first, Error, "not found");
});

// --- hand-built PNG and GIF fixtures for the decoder guards ---

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
function crc32(b: Uint8Array): number {
  let c = 0xffffffff;
  for (const v of b) c = CRC_TABLE[(c ^ v) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(type: string, body: Uint8Array): Uint8Array {
  const out = new Uint8Array(12 + body.length);
  const dv = new DataView(out.buffer);
  dv.setUint32(0, body.length);
  out.set(new TextEncoder().encode(type), 4);
  out.set(body, 8);
  dv.setUint32(8 + body.length, crc32(out.subarray(4, 8 + body.length)));
  return out;
}
function rawPng(
  w: number,
  h: number,
  depth: number,
  colorType: number,
  idat: Uint8Array,
  extra: Uint8Array[] = [],
  interlace = 0,
): Uint8Array {
  const ihdr = new Uint8Array(13);
  const dv = new DataView(ihdr.buffer);
  dv.setUint32(0, w);
  dv.setUint32(4, h);
  ihdr.set([depth, colorType, 0, 0, interlace], 8);
  const parts = [
    new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    ...extra,
    chunk("IDAT", idat),
    chunk("IEND", new Uint8Array()),
  ];
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) out.set(p, (o += p.length) - p.length);
  return out;
}
/** Rows with filter byte 0 prepended, zlib-compressed. */
const idatOf = (rows: number[][]) => zlibSync(new Uint8Array(rows.flatMap((r) => [0, ...r])));

Deno.test("a 1-bit grayscale PNG is unpacked, not read a byte per pixel", async () => {
  // 16x2: left 8 pixels white, right 8 black, packed 8 pixels per byte.
  const png = rawPng(16, 2, 1, 0, idatOf([[0xff, 0x00], [0xff, 0x00]]));
  const img = await decodeImage(png);
  assertEquals([img.width, img.height], [16, 2]);
  assertEquals(px(img, 0, 1), [255, 255, 255, 255]);
  assertEquals(px(img, 7, 0), [255, 255, 255, 255]);
  assertEquals(px(img, 8, 0), [0, 0, 0, 255]);
  assertEquals(px(img, 15, 1), [0, 0, 0, 255]);
  // 2-bit, 3 pixels per row (row padded to a byte): levels 3, 1, 0.
  const two = await decodeImage(rawPng(3, 1, 2, 0, idatOf([[0b11_01_00_00]])));
  assertEquals([px(two, 0, 0)[0], px(two, 1, 0)[0], px(two, 2, 0)[0]], [255, 85, 0]);
});

Deno.test("tRNS keys a color transparent on truecolor and grayscale PNGs", async () => {
  const rgb = rawPng(2, 1, 8, 2, idatOf([[255, 255, 255, 10, 20, 30]]), [
    chunk("tRNS", new Uint8Array([0, 255, 0, 255, 0, 255])),
  ]);
  const a = await decodeImage(rgb);
  assertEquals(px(a, 0, 0)[3], 0);
  assertEquals(px(a, 1, 0), [10, 20, 30, 255]);
  const gray = await decodeImage(rawPng(2, 1, 8, 0, idatOf([[7, 8]]), [chunk("tRNS", new Uint8Array([0, 7]))]));
  assertEquals([px(gray, 0, 0)[3], px(gray, 1, 0)], [0, [8, 8, 8, 255]]);
  const bit = await decodeImage(rawPng(8, 1, 1, 0, idatOf([[0b1010_1010]]), [chunk("tRNS", new Uint8Array([0, 0]))]));
  assertEquals([px(bit, 0, 0), px(bit, 1, 0)[3]], [[255, 255, 255, 255], 0]);
});

Deno.test("a PNG whose IDAT inflates past its header is refused; iCCP is never inflated", async () => {
  const bomb = rawPng(1, 1, 8, 2, zlibSync(new Uint8Array(32 * 1024 * 1024), { level: 9 }));
  assert(bomb.length < 100_000);
  await assertRejects(() => decodeImage(bomb), Error, "larger than its header");
  const iccp = new Uint8Array([...new TextEncoder().encode("x\0\0"), ...zlibSync(new Uint8Array(32 * 1024 * 1024))]);
  const img = await decodeImage(rawPng(1, 1, 8, 2, idatOf([[1, 2, 3]]), [chunk("iCCP", iccp)]));
  assertEquals(px(img, 0, 0), [1, 2, 3, 255]);
});

Deno.test("a GIF frame larger than its logical screen is refused before omggif allocates it", async () => {
  const gif = new Uint8Array([
    ...new TextEncoder().encode("GIF89a"),
    1,
    0,
    1,
    0,
    0,
    0,
    0, // 1x1 screen, no global palette
    0x2c,
    0,
    0,
    0,
    0,
    0x30,
    0x75,
    0x30,
    0x75,
    0, // image descriptor: 30000x30000, no local palette
    2,
    2,
    0x4c,
    0x01,
    0, // tiny LZW stream
    0x3b,
  ]);
  assertEquals(imageSize(gif), { width: 1, height: 1 });
  await assertRejects(() => decodeImage(gif), Error, "frame bounds");
});

Deno.test("a thumb generated while its original is deleted does not outlive it", async () => {
  const storage = new MemoryStorage();
  await storage.put("c/r/a.png", pngOf(twoTone(20, 20, "lr")), { type: "image/png" });
  const racing: typeof storage = Object.create(storage);
  racing.stat = (key) => storage.stat(key);
  racing.put = (key, body, meta) => storage.put(key, body, meta);
  racing.delete = (key) => storage.delete(key);
  racing.get = async (key, opts) => {
    const obj = await storage.get(key, opts);
    // The record update commits and its cleanup runs between the read and the put.
    await storage.delete("c/r/a.png");
    await storage.deletePrefix("c/r/thumbs_a.png/");
    return obj;
  };
  const thumbs = new Thumbs(1);
  await assertRejects(() => thumbs.create(racing, "c/r/a.png", "c/r/thumbs_a.png/10x10_a.png", "10x10"));
  assertEquals(await storage.stat("c/r/thumbs_a.png/10x10_a.png"), null);
});

// --- Adam7 below 8 bits ---

const ADAM7 = [[0, 0, 8, 8], [4, 0, 8, 8], [0, 4, 4, 8], [2, 0, 4, 4], [0, 2, 2, 4], [1, 0, 2, 2], [0, 1, 1, 2]];

/** Encodes one sample grid both plainly and as Adam7, each row with a filter cycling through all five. */
function packedPngs(w: number, h: number, depth: number, sample: (x: number, y: number) => number) {
  const pack = (vals: number[]) => {
    const row = new Array(Math.ceil((vals.length * depth) / 8)).fill(0);
    vals.forEach((v, i) => row[(i * depth) >> 3] |= v << (8 - depth - ((i * depth) & 7)));
    return row;
  };
  const filtered = (rows: number[][]) => {
    const out: number[] = [];
    rows.forEach((row, j) => {
      const f = j % 5, prev = j ? rows[j - 1] : row.map(() => 0);
      out.push(f);
      row.forEach((v, i) => {
        const a = i ? row[i - 1] : 0, b = prev[i], c = i ? prev[i - 1] : 0;
        const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
        const pred = [0, a, b, (a + b) >> 1, pa <= pb && pa <= pc ? a : pb <= pc ? b : c][f];
        out.push((v - pred) & 0xff);
      });
    });
    return out;
  };
  const plain: number[][] = [];
  for (let y = 0; y < h; y++) plain.push(pack(Array.from({ length: w }, (_, x) => sample(x, y))));
  const passes: number[] = [];
  for (const [x0, y0, dx, dy] of ADAM7) {
    const rows: number[][] = [];
    for (let y = y0; y < h; y += dy) {
      const vals: number[] = [];
      for (let x = x0; x < w; x += dx) vals.push(sample(x, y));
      if (vals.length) rows.push(pack(vals));
    }
    passes.push(...filtered(rows));
  }
  return { plain: zlibSync(new Uint8Array(filtered(plain))), adam7: zlibSync(new Uint8Array(passes)) };
}

Deno.test("Adam7 PNGs below 8 bits are de-interlaced: gray 1/2/4 and palette 1/2/4 match the plain encoding", async () => {
  for (const depth of [1, 2, 4]) {
    const max = (1 << depth) - 1;
    const sample = (x: number, y: number) => (x * 7 + y * 3 + ((x * y) >> 1)) & max;
    for (const [w, h] of [[13, 11], [1, 1], [3, 9], [17, 2]]) {
      const { plain, adam7 } = packedPngs(w, h, depth, sample);
      const gray = await decodeImage(rawPng(w, h, depth, 0, adam7, [], 1));
      assertEquals(gray, await decodeImage(rawPng(w, h, depth, 0, plain)), `gray ${depth}-bit ${w}x${h}`);
      const levels = 1 << depth;
      const plte = chunk("PLTE", new Uint8Array(Array.from({ length: levels * 3 }, (_, i) => (i * 37) & 0xff)));
      const trns = chunk("tRNS", new Uint8Array([0, 128]));
      const pal = await decodeImage(rawPng(w, h, depth, 3, adam7, [plte, trns], 1));
      assertEquals(
        pal,
        await decodeImage(rawPng(w, h, depth, 3, plain, [plte, trns])),
        `palette ${depth}-bit ${w}x${h}`,
      );
    }
  }
  // And it gets a thumb.
  const { adam7 } = packedPngs(40, 40, 1, (x) => (x < 20 ? 1 : 0));
  const t = await thumbOf(rawPng(40, 40, 1, 0, adam7, [], 1), "image/png", "10x10");
  assertEquals(px(t.img, 0, 5), [255, 255, 255, 255]);
  assertEquals(px(t.img, 9, 5), [0, 0, 0, 255]);
});

Deno.test("an Adam7 sub-byte PNG whose passes run short is refused", async () => {
  const { adam7 } = packedPngs(13, 11, 1, () => 1);
  const short = zlibSync(unzlibSync(adam7).subarray(0, 10));
  await assertRejects(() => decodeImage(rawPng(13, 11, 1, 0, short, [], 1)), Error, "truncated");
});

// --- worker pool ---

Deno.test("ThumbPool renders off thread, transfers the input, and replaces a worker that times out", async () => {
  const pool = new ThumbPool(1, 30_000);
  try {
    const src = pngOf(twoTone(40, 20, "lr"));
    const out = await pool.render(src, "image/png", "10x10");
    assertEquals(src.byteLength, 0, "the original's buffer is transferred, not copied");
    assertEquals(out.type, "image/png");
    assertEquals((await decodeImage(out.bytes)).width, 10);
    assertEquals(pool.spawned, 1);
    // Reused while warm.
    await pool.render(pngOf(twoTone(40, 20, "lr")), "image/png", "10x10");
    assertEquals(pool.spawned, 1);

    pool.timeoutMs = 1;
    const big = pngOf(twoTone(3000, 3000, "lr"));
    await assertRejects(() => pool.render(big, "image/png", "100x100"), Error, "passed 1ms");
    pool.timeoutMs = 30_000;
    const again = await pool.render(pngOf(twoTone(40, 20, "lr")), "image/png", "10x10");
    assertEquals((await decodeImage(again.bytes)).width, 10);
    assertEquals(pool.spawned, 2, "the timed-out worker was terminated and a fresh one took its seat");

    // Guards still apply inside the worker; the error comes back by message.
    await assertRejects(() => pool.render(new Uint8Array([1, 2, 3]), "image/png", "10x10"), Error, "unsupported");
    // A view into a larger buffer is copied before the transfer, so the rest of the buffer stays with the caller.
    const inner = pngOf(twoTone(40, 20, "lr"));
    const whole = new Uint8Array(inner.length + 64);
    whole.set(inner, 32);
    await pool.render(whole.subarray(32, 32 + inner.length), "image/png", "10x10");
    assertEquals(whole.byteLength, inner.length + 64);
  } finally {
    pool.close();
  }
});

Deno.test("ThumbPool frees a seat at once when its running job is aborted, and drops listeners of settled jobs", async () => {
  const pool = new ThumbPool(1, 30_000);
  try {
    const ac = new AbortController();
    const running = pool.render(pngOf(twoTone(3000, 3000, "lr")), "image/png", "100x100", ac.signal);
    const queued = pool.render(pngOf(twoTone(40, 20, "lr")), "image/png", "10x10");
    await new Promise((r) => setTimeout(r, 5));
    ac.abort();
    await assertRejects(() => running, Error, "canceled");
    // The worker was terminated, so the queued job runs on a fresh one instead of waiting out the decode.
    const t0 = performance.now();
    assertEquals((await decodeImage((await queued).bytes)).width, 10);
    assert(performance.now() - t0 < 5_000);
    assertEquals(pool.spawned, 2);

    // A long-lived signal shared by many renders keeps no listener once each job settles.
    let live = 0;
    const shared = new AbortController();
    const add = shared.signal.addEventListener.bind(shared.signal);
    const remove = shared.signal.removeEventListener.bind(shared.signal);
    shared.signal.addEventListener = ((...a: Parameters<typeof add>) => (live++, add(...a))) as typeof add;
    shared.signal.removeEventListener = ((...a: Parameters<typeof remove>) => (live--, remove(...a))) as typeof remove;
    for (let i = 0; i < 3; i++) await pool.render(pngOf(twoTone(40, 20, "lr")), "image/png", "10x10", shared.signal);
    await assertRejects(() => pool.render(new Uint8Array([1]), "image/png", "10x10", shared.signal));
    assertEquals(live, 0);
  } finally {
    pool.close();
  }
});

Deno.test("Thumbs.cancel stops in-flight generations for a file and awaits them before its thumbs are swept", async () => {
  const storage = new MemoryStorage();
  await storage.put("c/r/a.png", pngOf(twoTone(20, 20, "lr")), { type: "image/png" });
  await storage.put("c/r/b.png", pngOf(twoTone(20, 20, "lr")), { type: "image/png" });
  let putStarted!: () => void;
  const started = new Promise<void>((r) => putStarted = r);
  let finishPut!: () => void;
  const slow: typeof storage = Object.create(storage);
  slow.stat = (key) => storage.stat(key);
  slow.get = (key, opts) => storage.get(key, opts);
  slow.delete = (key) => storage.delete(key);
  slow.put = async (key, body, meta) => {
    if (key.startsWith("c/r/thumbs_a.png/")) {
      putStarted();
      await new Promise<void>((r) => finishPut = r);
    }
    return await storage.put(key, body, meta);
  };
  const thumbs = new Thumbs(2);
  const a = thumbs.create(slow, "c/r/a.png", "c/r/thumbs_a.png/10x10_a.png", "10x10");
  const b = thumbs.create(slow, "c/r/b.png", "c/r/thumbs_b.png/10x10_b.png", "10x10");
  await started;
  // The put is under way when the file is replaced: cancel must not resolve before it lands and is undone.
  let canceled = false;
  const cancel = thumbs.cancel("c/r/thumbs_a.png/").then(() => canceled = true);
  await new Promise((r) => setTimeout(r, 10));
  assertEquals(canceled, false);
  finishPut();
  await cancel;
  await storage.deletePrefix("c/r/thumbs_a.png/");
  await assertRejects(() => a);
  assertEquals(await storage.stat("c/r/thumbs_a.png/10x10_a.png"), null);
  // Other files are untouched.
  await b;
  assert(await storage.stat("c/r/thumbs_b.png/10x10_b.png"));
  assertEquals(thumbs.inFlight, 0);

  // Canceled before it reaches the pool: nothing is rendered or written.
  let gets = 0;
  const counting: typeof storage = Object.create(storage);
  counting.stat = (key) => storage.stat(key);
  counting.put = (key, body, meta) => storage.put(key, body, meta);
  counting.delete = (key) => storage.delete(key);
  counting.get = async (key, opts) => {
    gets++;
    await new Promise((r) => setTimeout(r, 10));
    return await storage.get(key, opts);
  };
  const c = thumbs.create(counting, "c/r/b.png", "c/r/thumbs_b.png/20x20_b.png", "20x20");
  await thumbs.cancel("c/r/");
  await assertRejects(() => c, Error, "canceled");
  assertEquals([gets, await storage.stat("c/r/thumbs_b.png/20x20_b.png")], [1, null]);
  // settled() waits without canceling.
  const d = thumbs.create(counting, "c/r/b.png", "c/r/thumbs_b.png/30x30_b.png", "30x30");
  await thumbs.settled("c/r/thumbs_b.png/");
  await d;
  assert(await storage.stat("c/r/thumbs_b.png/30x30_b.png"));
});
