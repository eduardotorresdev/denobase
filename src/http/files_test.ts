import { assert, assertEquals, assertMatch, assertNotEquals } from "@std/assert";
import { createApp } from "../app.ts";
import { MemoryMailer } from "../auth/mailer.ts";
import { defineCollection } from "../core/define.ts";
import { collectionId, registerCollections } from "../core/registry.ts";
import { superusers } from "../core/superusers.ts";
import { MemoryStorage } from "../files/storage.ts";
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

const png = (name = "Foto Capa.PNG") => new File([new Uint8Array([137, 80, 78, 71])], name, { type: "image/png" });
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
  assertEquals(new Uint8Array(await res.arrayBuffer()), new Uint8Array([137, 80, 78, 71]));
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
