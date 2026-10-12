import { assert, assertEquals, assertMatch, assertNotEquals } from "@std/assert";
import { createApp } from "../app.ts";
import { MemoryMailer } from "../auth/mailer.ts";
import { defineCollection } from "../core/define.ts";
import { collectionId, registerCollections } from "../core/registry.ts";
import { superusers } from "../core/superusers.ts";
import { MemoryStorage } from "../files/storage.ts";
import { beforeCommit, tx } from "../core/db.ts";
import { normalizeName } from "../files/name.ts";
import { dbWith, tokenFor } from "../testing/mod.ts";

Deno.env.set("BCRYPT_COST", "4");

const fl_membros = defineCollection({ slug: "fl_membros", auth: true, fields: [], access: { read: () => true } });
const fl_docs = defineCollection({
  slug: "fl_docs",
  fields: [
    { name: "titulo", type: "text" },
    { name: "capa", type: "file", mimeTypes: ["image/png"] },
    { name: "anexos", type: "file", maxSelect: 3, maxSize: 10 },
    { name: "secreto", type: "file", protected: true },
    { name: "nota", type: "number" },
  ],
  access: {
    read: ({ user }) => (user ? true : { titulo: { equals: "publico" } }),
    create: () => true,
    update: () => true,
    delete: () => true,
  },
});
registerCollections(fl_membros, fl_docs);

/** A PNG signature: the stored type is sniffed from the bytes, as PB does, never taken from the client. */
const PNG = [137, 80, 78, 71, 13, 10, 26, 10];
const png = (name = "Foto Capa.PNG") => new File([new Uint8Array(PNG)], name, { type: "image/png" });
const txt = (name: string, body = "oi") => new File([body], name, { type: "text/plain" });

async function setup() {
  const db = await dbWith([superusers, fl_membros, fl_docs]);
  const storage = new MemoryStorage();
  const app = createApp({ db, mailer: new MemoryMailer(), storage, settings: { batch: { enabled: true } } });
  const send = async (method: string, path: string, form: FormData | unknown, token?: string) => {
    const headers: Record<string, string> = token ? { Authorization: token } : {};
    let body: BodyInit;
    if (form instanceof FormData) body = form;
    else {
      headers["content-type"] = "application/json";
      body = JSON.stringify(form);
    }
    const r = await app.http.request(path, { method, headers, body });
    return { status: r.status, json: r.status === 204 ? null : await r.json() };
  };
  const fd = (entries: [string, string | File][]) => {
    const f = new FormData();
    for (const [k, v] of entries) f.append(k, v);
    return f;
  };
  return { db, app, storage, send, fd };
}

Deno.test("names follow PB's normalizeName: snake case, random suffix, cleaned extension", () => {
  assertMatch(normalizeName("Foto Capa.PNG"), /^foto_capa_[a-z0-9]{10}\.PNG$/);
  assertMatch(normalizeName("a.tar.gz"), /^a[a-z0-9]{10}_[a-z0-9]{10}\.tar\.gz$/);
  // Path tricks never survive: no separators and no leading dot.
  assertMatch(normalizeName("../../etc/passwd"), /^[a-z0-9_]+\.[\w.]+$/);
});

Deno.test("multipart create stores uploads, casts fields and the file serves with PB headers", async () => {
  const t = await setup();
  const r = await t.send(
    "POST",
    "/api/collections/fl_docs/records",
    t.fd([["titulo", "publico"], ["nota", "7"], ["capa", png()], ["anexos", txt("a.txt")], ["anexos", txt("b.txt")]]),
  );
  assertEquals(r.status, 200);
  assertMatch(r.json.capa, /^foto_capa_\w{10}\.PNG$/);
  assertEquals([r.json.anexos.length, r.json.nota], [2, 7]);
  const key = `${collectionId(fl_docs)}/${r.json.id}/${r.json.capa}`;
  assert(t.storage.files.has(key));

  const res = await t.app.http.request(`/api/files/${r.json.collectionId}/${r.json.id}/${r.json.capa}`);
  assertEquals(res.status, 200);
  assertEquals(res.headers.get("content-type"), "image/png");
  assertEquals(res.headers.get("content-disposition"), `inline; filename="${r.json.capa}"`);
  assertEquals(new Uint8Array(await res.arrayBuffer()), new Uint8Array(PNG));
  const dl = await t.app.http.request(`/api/files/fl_docs/${r.json.id}/${r.json.capa}?download=1`);
  assert(dl.headers.get("content-disposition")!.startsWith("attachment"));
  await dl.body?.cancel();
  assertEquals((await t.app.http.request(`/api/files/fl_docs/${r.json.id}/nope.png`)).status, 404);
});

Deno.test("file checks answer PB's codes: type, size, count and names the client did not upload", async () => {
  const t = await setup();
  const base = "/api/collections/fl_docs/records";
  let r = await t.send("POST", base, t.fd([["capa", txt("x.txt")]]));
  assertEquals(r.json.data.capa.code, "validation_invalid_mime_type");
  r = await t.send("POST", base, t.fd([["anexos", txt("grande.txt", "12345678901")]]));
  assertEquals(r.json.data.anexos.code, "validation_file_size_limit");
  r = await t.send("POST", base, t.fd(["a", "b", "c", "d"].map((n) => ["anexos", txt(`${n}.txt`)] as [string, File])));
  assertEquals(r.json.data.anexos.code, "validation_too_many_files");
  r = await t.send("POST", base, { capa: "alheio.png" });
  assertEquals(r.json.data.capa.code, "validation_invalid_file");
});

Deno.test("the file type is sniffed from the content like PB: the client's type and the name do not count", async () => {
  const t = await setup();
  const base = "/api/collections/fl_docs/records";
  // Text claimed as a PNG is refused with PB's message.
  let r = await t.send("POST", base, t.fd([["capa", new File(["oi"], "f.png", { type: "image/png" })]]));
  assertEquals(r.json.data.capa, {
    code: "validation_invalid_mime_type",
    message: '"f.png" mime type must be one of: image/png.',
  });
  // A real PNG sent as text/plain passes, and is stored as image/png.
  r = await t.send("POST", base, t.fd([["capa", new File([new Uint8Array(PNG)], "f.bin", { type: "text/plain" })]]));
  assertEquals(r.status, 200);
  assertEquals(t.storage.files.get(`${collectionId(fl_docs)}/${r.json.id}/${r.json.capa}`)?.type, "image/png");
  // Without mimeTypes anything goes, and the stored type is still the sniffed one.
  r = await t.send("POST", base, t.fd([["anexos", new File(['{"a":1}'], "x.png", { type: "image/png" })]]));
  assertEquals(
    t.storage.files.get(`${collectionId(fl_docs)}/${r.json.id}/${r.json.anexos[0]}`)?.type,
    "application/json",
  );
});

Deno.test("modifiers append and remove files; replaced and deleted files leave storage after commit", async () => {
  const t = await setup();
  const doc = (await t.send("POST", "/api/collections/fl_docs/records", t.fd([["anexos", txt("a.txt")]]))).json;
  const path = `/api/collections/fl_docs/records/${doc.id}`;
  const added = (await t.send("PATCH", path, t.fd([["anexos+", txt("b.txt")]]))).json;
  assertEquals(added.anexos.length, 2);
  const [first, second] = added.anexos;
  const removed = (await t.send("PATCH", path, { "anexos-": [first] })).json;
  assertEquals(removed.anexos, [second]);
  const dir = `${collectionId(fl_docs)}/${doc.id}/`;
  assertEquals(t.storage.files.has(dir + first), false);
  assert(t.storage.files.has(dir + second));
  const plus = (await t.send("PATCH", path, { "nota+": 5 })).json;
  assertEquals(plus.nota, 5);
  assertEquals((await t.send("DELETE", path, {})).status, 204);
  assertEquals([...t.storage.files.keys()].filter((k) => k.startsWith(dir)), []);
});

Deno.test("protected files need a file token whose user passes the read rule", async () => {
  const t = await setup();
  const doc = (await t.send("POST", "/api/collections/fl_docs/records", t.fd([["secreto", txt("s.txt")]]))).json;
  const url = `/api/files/fl_docs/${doc.id}/${doc.secreto}`;
  assertEquals((await t.app.http.request(url)).status, 404);
  const m = await t.app.store.collection(fl_membros).create(
    { email: "m@x.io", password: "12345678", passwordConfirm: "12345678" } as never,
  );
  const auth = await tokenFor(t.db, "fl_membros", m);
  // The Authorization header does not unlock a protected file; only ?token= does.
  assertEquals((await t.app.http.request(url, { headers: { Authorization: auth } })).status, 404);
  assertEquals((await t.send("POST", "/api/files/token", {})).status, 401);
  const { token } = (await t.send("POST", "/api/files/token", {}, auth)).json;
  assertNotEquals(token, auth);
  const ok = await t.app.http.request(`${url}?token=${token}`);
  assertEquals([ok.status, await ok.text()], [200, "oi"]);
});

Deno.test("batch accepts multipart: @jsonPayload requests and requests.<i>.<field> files", async () => {
  const t = await setup();
  const form = new FormData();
  form.append(
    "@jsonPayload",
    JSON.stringify({ requests: [{ method: "POST", url: "/api/collections/fl_docs/records", body: { titulo: "x" } }] }),
  );
  form.append("requests.0.capa", png("lote.png"));
  const r = await t.send("POST", "/api/batch", form);
  assertEquals(r.status, 200);
  assertMatch(r.json[0].body.capa, /^lote_\w{10}\.png$/);
  assertEquals(r.json[0].body.titulo, "x");
});

Deno.test("file fields filter like PB multivaluers: :length, any-of and the REST @request.headers", async () => {
  const t = await setup();
  const base = "/api/collections/fl_docs/records";
  await t.send("POST", base, t.fd([["titulo", "dois"], ["anexos", txt("a.txt")], ["anexos", txt("b.txt")]]));
  await t.send("POST", base, t.fd([["titulo", "um"], ["anexos", txt("zebra.txt")]]));
  const su = await t.app.store.collection(superusers).create(
    { email: "su@x.io", password: "12345678", passwordConfirm: "12345678" } as never,
  );
  const token = await tokenFor(t.db, "_superusers", su);
  const list = async (filter: string, headers: Record<string, string> = {}) => {
    const r = await t.app.http.request(`${base}?filter=${encodeURIComponent(filter)}&sort=titulo`, {
      headers: { Authorization: token, ...headers },
    });
    return (await r.json()).items.map((d: { titulo: string }) => d.titulo);
  };
  assertEquals(await list("anexos:length = 2"), ["dois"]);
  assertEquals(await list("anexos ?~ 'zebra_'"), ["um"]);
  assertEquals(await list("@request.headers.x_marca = 'sim'", { "X-Marca": "sim" }), ["dois", "um"]);
  assertEquals(await list("@request.headers.x_marca = 'sim'"), []);
});

Deno.test("files serve like Go's http.ServeContent: ranges, 416 and conditionals", async () => {
  const t = await setup();
  const r = await t.send("POST", "/api/collections/fl_docs/records", t.fd([["anexos", txt("r.txt", "0123456789")]]));
  const url = `/api/files/fl_docs/${r.json.id}/${r.json.anexos[0]}`;
  const get = (headers: Record<string, string>) => t.app.http.request(url, { headers });

  const full = await get({});
  assertEquals([full.status, full.headers.get("accept-ranges"), await full.text()], [200, "bytes", "0123456789"]);
  const lastModified = full.headers.get("last-modified")!;
  assert(lastModified);

  const one = await get({ Range: "bytes=2-4" });
  assertEquals([one.status, one.headers.get("content-range"), one.headers.get("content-length")], [
    206,
    "bytes 2-4/10",
    "3",
  ]);
  assertEquals(await one.text(), "234");
  const suffix = await get({ Range: "bytes=-3" });
  assertEquals([suffix.headers.get("content-range"), await suffix.text()], ["bytes 7-9/10", "789"]);

  const multi = await get({ Range: "bytes=0-0,8-" });
  assertEquals(multi.status, 206);
  const boundary = multi.headers.get("content-type")!.match(/^multipart\/byteranges; boundary=(\w+)$/)![1];
  const body = await multi.text();
  assertEquals(Number(multi.headers.get("content-length")), new TextEncoder().encode(body).byteLength);
  assertEquals(
    body,
    `--${boundary}\r\nContent-Range: bytes 0-0/10\r\nContent-Type: text/plain; charset=utf-8\r\n\r\n0` +
      `\r\n--${boundary}\r\nContent-Range: bytes 8-9/10\r\nContent-Type: text/plain; charset=utf-8\r\n\r\n89\r\n--${boundary}--\r\n`,
  );

  const past = await get({ Range: "bytes=20-" });
  assertEquals([past.status, past.headers.get("content-range")], [416, "bytes */10"]);
  assertEquals(await past.text(), "invalid range: failed to overlap\n");
  const bad = await get({ Range: "items=0-1" });
  assertEquals(bad.status, 416);
  await bad.body?.cancel();
  // Asking for more than the file, through overlaps, gets the whole file.
  const over = await get({ Range: "bytes=0-9,0-9" });
  assertEquals([over.status, await over.text()], [200, "0123456789"]);

  const cached = await get({ "If-Modified-Since": lastModified });
  assertEquals([cached.status, cached.headers.get("content-type")], [304, null]);
  await cached.body?.cancel();
  const stale = await get({ Range: "bytes=0-1", "If-Range": "Mon, 01 Jan 2001 00:00:00 GMT" });
  assertEquals([stale.status, await stale.text()], [200, "0123456789"]);
  const fresh = await get({ Range: "bytes=0-1", "If-Range": lastModified });
  assertEquals([fresh.status, await fresh.text()], [206, "01"]);
});

/** Spool dirs left in the temp dir; the request scope must remove its own whatever the outcome. */
async function spoolDirs(): Promise<number> {
  const tmp = Deno.env.get("TMPDIR") || "/tmp";
  let n = 0;
  for await (const e of Deno.readDir(tmp)) if (e.name.startsWith("denobase-upload-")) n++;
  return n;
}

Deno.test("uploads spool to disk and the spool goes after success, validation error and batch rollback", async () => {
  const t = await setup();
  const base = "/api/collections/fl_docs/records";
  const before = await spoolDirs();
  let r = await t.send("POST", base, t.fd([["anexos", txt("ok.txt", "0123456789")]]));
  assertEquals(r.status, 200);
  const stored = await t.storage.get(`${collectionId(fl_docs)}/${r.json.id}/${r.json.anexos[0]}`);
  assertEquals(await new Response(stored!.body).text(), "0123456789");
  // One byte over maxSize: PB's error and message, from the size counted while the spool kept only maxSize.
  r = await t.send("POST", base, t.fd([["anexos", txt("grande.txt", "x".repeat(100_000))]]));
  assertEquals(r.status, 400);
  assertEquals(r.json.data.anexos, {
    code: "validation_file_size_limit",
    message: "Failed to upload grande.txt - the maximum allowed file size is 10 bytes.",
  });
  const form = new FormData();
  form.append(
    "@jsonPayload",
    JSON.stringify({
      requests: [
        { method: "POST", url: base, body: { titulo: "a" } },
        { method: "POST", url: base, body: { nota: "x" } },
      ],
    }),
  );
  form.append("requests.0.anexos", txt("a.txt"));
  r = await t.send("POST", "/api/batch", form);
  assertEquals(r.status, 400);
  assertEquals(await spoolDirs(), before);
});

Deno.test("a failed save or commit leaves no orphan uploads; replaced files stay until a commit succeeds", async () => {
  const t = await setup();
  const docs = t.app.store.collection(fl_docs);
  const keys = () => [...t.storage.files.keys()];
  const failCommit = (fn: () => Promise<unknown>) =>
    tx(t.db, async () => {
      await fn();
      await beforeCommit(t.db, "fail", () => {
        throw new Error("commit failed");
      });
    }).then(() => assert(false), (e) => assertEquals((e as Error).message, "commit failed"));

  // Create: the upload happened, the commit failed, the file is gone and no row exists.
  await failCommit(() => docs.create({ titulo: "x", anexos: [txt("a.txt")] } as never));
  assertEquals(keys(), []);
  assertEquals(await docs.count(), 0);

  // The row write itself failing (a unique id clash) cleans up too.
  const first = await docs.create({ titulo: "y", anexos: [txt("a.txt")] } as never);
  const dir = `${collectionId(fl_docs)}/${first.id}/`;
  const kept = keys();
  assertEquals(kept.length, 1);
  await docs.create({ id: first.id, anexos: [txt("b.txt")] } as never).then(() => assert(false), () => {});
  assertEquals(keys(), kept);

  // Update replacing the file: the new upload goes, the old one stays (the row still points at it).
  await failCommit(() => docs.update(first.id, { anexos: [txt("c.txt")] } as never));
  assertEquals(keys(), kept);
  assertEquals((await docs.get(first.id) as Record<string, unknown>).anexos, (first as Record<string, unknown>).anexos);

  // A successful replace drops the old file only now.
  const next = await docs.update(first.id, { anexos: [txt("d.txt")] } as never) as Record<string, unknown>;
  assertEquals(keys(), [dir + (next.anexos as string[])[0]]);
});
