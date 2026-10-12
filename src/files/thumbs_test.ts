import { assert, assertEquals, assertRejects } from "@std/assert";
import { decode as decodePng, encode as encodePng } from "fast-png";
import { pngOf, twoTone } from "./testkit.ts";
import jpeg from "jpeg-js";
import encodeWebp from "@jsquash/webp/encode.js";
import { decodeImage, encodeImage, exifOrientation, imageSize, orient, type Rgba, sniffFormat } from "./image.ts";
import { renderThumb, Thumbs } from "./thumbs.ts";
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
