import { assert, assertEquals } from "@std/assert";
import jpeg from "jpeg-js";
import { createApp } from "../app.ts";
import { MemoryMailer } from "../auth/mailer.ts";
import { defineCollection } from "../core/define.ts";
import { registerCollections } from "../core/registry.ts";
import { superusers } from "../core/superusers.ts";
import { MemoryStorage } from "../files/storage.ts";
import { decodeImage } from "../files/image.ts";
import { dbWith, startFakeS3, tokenFor } from "../testing/mod.ts";
import { pngOf, twoTone } from "../files/testkit.ts";

Deno.env.set("BCRYPT_COST", "4");

const th_fotos = defineCollection({
  slug: "th_fotos",
  fields: [
    { name: "foto", type: "file", thumbs: ["50x50", "50x50t", "50x50b", "40x40f", "0x30", "30x0"] },
    { name: "outra", type: "file" },
  ],
  access: { read: () => true, create: () => true, update: () => true, delete: () => true },
});
registerCollections(th_fotos);

const png = () => new File([pngOf(twoTone(200, 100, "lr"))], "foto.png", { type: "image/png" });

async function setup() {
  const db = await dbWith([superusers, th_fotos]);
  const storage = new MemoryStorage();
  const app = createApp({ db, mailer: new MemoryMailer(), storage });
  const su = await app.store.collection(superusers).create(
    { email: "su@x.io", password: "12345678", passwordConfirm: "12345678" } as never,
  );
  const token = await tokenFor(db, "_superusers", su);
  const send = async (method: string, path: string, body?: FormData | unknown) => {
    const headers: Record<string, string> = { Authorization: token };
    let payload: BodyInit | undefined;
    if (body instanceof FormData) payload = body;
    else if (body !== undefined) {
      headers["content-type"] = "application/json";
      payload = JSON.stringify(body);
    }
    const r = await app.http.request(path, { method, headers, body: payload });
    const text = await r.text();
    return { status: r.status, json: text ? JSON.parse(text) : null };
  };
  const upload = async (field: string, file: File) => {
    const f = new FormData();
    f.append(field, file);
    return (await send("POST", "/api/collections/th_fotos/records", f)).json;
  };
  const get = async (rec: { collectionId: string; id: string }, name: string, query = "") => {
    const r = await app.http.request(`/api/files/${rec.collectionId}/${rec.id}/${name}${query}`);
    return { res: r, bytes: new Uint8Array(await r.arrayBuffer()) };
  };
  return { app, storage, send, upload, get };
}

const keysOf = (s: MemoryStorage) => [...s.files.keys()].sort();

Deno.test("?thumb= serves a generated thumb for each size mode, stored at PB's key layout", async () => {
  const t = await setup();
  try {
    const rec = await t.upload("foto", png());
    const dir = `${rec.collectionId}/${rec.id}/`;
    const cases: [string, number, number][] = [
      ["100x100", 100, 100],
      ["50x50", 50, 50],
      ["50x50t", 50, 50],
      ["50x50b", 50, 50],
      ["40x40f", 40, 20],
      ["0x30", 60, 30],
      ["30x0", 30, 15],
    ];
    for (const [size, w, h] of cases) {
      const { res, bytes } = await t.get(rec, rec.foto, `?thumb=${size}`);
      assertEquals(res.status, 200, size);
      assertEquals(res.headers.get("content-type"), "image/png");
      assertEquals(res.headers.get("content-disposition"), `inline; filename="${size}_${rec.foto}"`);
      assertEquals(res.headers.get("cache-control"), "max-age=2592000, stale-while-revalidate=86400");
      assert(res.headers.get("last-modified"));
      const img = await decodeImage(bytes);
      assertEquals([img.width, img.height], [w, h], size);
      assert(t.storage.files.has(`${dir}thumbs_${rec.foto}/${size}_${rec.foto}`), size);
    }
    // Served again from storage; Range works on thumbs like on any file.
    const again = await t.app.http.request(`/api/files/${rec.collectionId}/${rec.id}/${rec.foto}?thumb=50x50`, {
      headers: { range: "bytes=0-3" },
    });
    assertEquals([again.status, [...new Uint8Array(await again.arrayBuffer())]], [206, [137, 80, 78, 71]]);
  } finally {
    await t.app.terminate();
  }
});

Deno.test("a size not in the field's thumbs (nor 100x100) or a non-image serves the original", async () => {
  const t = await setup();
  try {
    const rec = await t.upload("foto", png());
    const original = await t.get(rec, rec.foto);
    for (const q of ["?thumb=60x60", "?thumb=abc", "?thumb=", "?thumb=50x50x"]) {
      const { res, bytes } = await t.get(rec, rec.foto, q);
      assertEquals([res.status, res.headers.get("content-disposition")], [200, `inline; filename="${rec.foto}"`]);
      assertEquals(bytes, original.bytes);
    }
    // 50x50 is allowed on "foto" only; "outra" has only the default.
    const other = await t.upload("outra", png());
    const { bytes } = await t.get(other, other.outra, "?thumb=50x50");
    assertEquals(bytes.length, (await t.get(other, other.outra)).bytes.length);
    assertEquals(keysOf(t.storage).filter((k) => k.includes("thumbs_")), []);

    // Unsupported types are served as is: text, svg, bmp.
    for (const [name, type] of [["a.txt", "text/plain"], ["a.svg", "image/svg+xml"], ["a.bmp", "image/bmp"]]) {
      const r = await t.upload("foto", new File(["<svg/>"], name, { type }));
      const { res, bytes } = await t.get(r, r.foto, "?thumb=100x100");
      assertEquals([res.status, new TextDecoder().decode(bytes)], [200, "<svg/>"]);
    }
    // An "image" that does not decode falls back to the original, and no thumb is stored.
    const broken = await t.upload("foto", new File(["not a png"], "x.png", { type: "image/png" }));
    const warn = console.warn;
    const warned: unknown[] = [];
    console.warn = (...a: unknown[]) => warned.push(a[0]);
    const fb = await t.get(broken, broken.foto, "?thumb=100x100").finally(() => console.warn = warn);
    assertEquals(warned, [`Fallback to original - failed to create thumb 100x100_${broken.foto}`]);
    assertEquals([fb.res.status, new TextDecoder().decode(fb.bytes)], [200, "not a png"]);
    assertEquals(keysOf(t.storage).filter((k) => k.includes("thumbs_")), []);
    // A missing file is still 404 with ?thumb.
    assertEquals((await t.get(rec, "nope.png", "?thumb=100x100")).res.status, 404);
  } finally {
    await t.app.terminate();
  }
});

Deno.test("jpeg thumbs stay jpeg", async () => {
  const t = await setup();
  try {
    const jpg = new Uint8Array(jpeg.encode(twoTone(120, 80, "lr"), 90).data);
    const rec = await t.upload("foto", new File([jpg], "f.jpg", { type: "image/jpeg" }));
    const { res, bytes } = await t.get(rec, rec.foto, "?thumb=100x100");
    assertEquals(res.headers.get("content-type"), "image/jpeg");
    assertEquals([bytes[0], bytes[1]], [0xff, 0xd8]);
  } finally {
    await t.app.terminate();
  }
});

Deno.test("concurrent requests for one thumb generate it once", async () => {
  const t = await setup();
  try {
    const rec = await t.upload("foto", png());
    let puts = 0;
    const put = t.storage.put.bind(t.storage);
    t.storage.put = (key, body, meta) => {
      if (key.includes("thumbs_")) puts++;
      return put(key, body, meta);
    };
    const all = await Promise.all(Array.from({ length: 6 }, () => t.get(rec, rec.foto, "?thumb=100x100")));
    assertEquals(all.map((r) => r.res.status), [200, 200, 200, 200, 200, 200]);
    assertEquals(new Set(all.map((r) => r.bytes.length)).size, 1);
    assertEquals(puts, 1);
  } finally {
    await t.app.terminate();
  }
});

Deno.test("replacing or deleting a file removes its thumbs after commit", async () => {
  const t = await setup();
  try {
    const rec = await t.upload("foto", png());
    await t.get(rec, rec.foto, "?thumb=100x100");
    await t.get(rec, rec.foto, "?thumb=50x50");
    const thumbs = (s: string) => keysOf(t.storage).filter((k) => k.includes(`thumbs_${s}/`));
    assertEquals(thumbs(rec.foto).length, 2);

    const f = new FormData();
    f.append("foto", png());
    const upd = (await t.send("PATCH", `/api/collections/th_fotos/records/${rec.id}`, f)).json;
    for (let i = 0; i < 50 && thumbs(rec.foto).length; i++) await new Promise((r) => setTimeout(r, 5));
    assertEquals(thumbs(rec.foto), []);

    await t.get(upd, upd.foto, "?thumb=100x100");
    assertEquals(thumbs(upd.foto).length, 1);
    assertEquals((await t.send("DELETE", `/api/collections/th_fotos/records/${rec.id}`)).status, 204);
    for (let i = 0; i < 50 && t.storage.files.size; i++) await new Promise((r) => setTimeout(r, 5));
    assertEquals(keysOf(t.storage), []);
  } finally {
    await t.app.terminate();
  }
});

Deno.test("thumbs go through S3 when settings.s3 is on", async () => {
  const s3 = startFakeS3();
  const t = await setup();
  try {
    assertEquals((await t.send("PATCH", "/api/settings", { s3: s3.config })).status, 200);
    const rec = await t.upload("foto", png());
    const { res, bytes } = await t.get(rec, rec.foto, "?thumb=50x50b");
    assertEquals([res.status, res.headers.get("content-type")], [200, "image/png"]);
    assertEquals((await decodeImage(bytes)).width, 50);
    const key = `${rec.collectionId}/${rec.id}/thumbs_${rec.foto}/50x50b_${rec.foto}`;
    assertEquals(s3.objects.get(key)?.type, "image/png");
    assertEquals(t.storage.files.size, 0);

    const f = new FormData();
    f.append("foto", png());
    assertEquals((await t.send("PATCH", `/api/collections/th_fotos/records/${rec.id}`, f)).status, 200);
    for (let i = 0; i < 50 && s3.objects.has(key); i++) await new Promise((r) => setTimeout(r, 10));
    assertEquals(s3.objects.has(key), false);
  } finally {
    await t.app.terminate();
    await s3.close();
  }
});
