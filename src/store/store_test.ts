import { assert, assertEquals, assertRejects } from "@std/assert";
import { z } from "zod";
import { defineCollection } from "../core/define.ts";
import { registerCollections } from "../core/registry.ts";
import { ApiError } from "../core/errors.ts";
import { dbWith } from "../testing/mod.ts";
import { createStore } from "./mod.ts";

const st_tags = defineCollection({
  slug: "st_tags",
  fields: [{ name: "nome", type: "text", required: true, unique: true }],
  access: { read: () => true },
});
const st_posts = defineCollection({
  slug: "st_posts",
  fields: [
    { name: "titulo", type: "text", required: true, minLength: 2 },
    { name: "nota", type: "number", integer: true, min: 0 },
    { name: "status", type: "select", options: ["rascunho", "publicado"] },
    { name: "tag", type: "relationship", relationTo: "st_tags" },
    { name: "meta", type: "json", schema: z.object({ autor: z.string() }) },
    { name: "segredo", type: "text", hidden: true },
  ],
  // Guests only see published posts: the system store must not care.
  access: { read: () => ({ status: { equals: "publicado" } }) },
  schema: z.object({ titulo: z.string(), nota: z.number().optional() }).refine((d) => d.titulo !== "proibido", {
    path: ["titulo"],
    message: "Reserved title.",
    params: { code: "validation_reserved" },
  }),
});
registerCollections(st_tags, st_posts);

async function setup() {
  const db = await dbWith([st_tags, st_posts]);
  return { db, store: createStore(db) };
}

Deno.test("typed CRUD round-trips through the full pipeline and decodes json by its schema", async () => {
  const { store } = await setup();
  const tags = store.collection(st_tags);
  const posts = store.collection(st_posts);
  const tag = await tags.create({ nome: "deno" });
  const p = await posts.create({ titulo: "Ola", nota: 3, status: "rascunho", tag: tag.id, meta: { autor: "ed" } });
  // Compile-time: these reads are typed from the config (string, number, union, parsed json).
  const titulo: string = p.titulo;
  const status: "rascunho" | "publicado" = p.status;
  const autor: string | undefined = p.meta?.autor; // optional json reads as null when empty, like PB
  assertEquals([titulo, p.nota, status, autor, p.tag], ["Ola", 3, "rascunho", "ed", tag.id]);
  // @ts-expect-error status is the options union, not any string
  const _wrong: "arquivado" = p.status;
  // @ts-expect-error titulo is required on create
  void (() => posts.create({ nota: 1 }));
  // @ts-expect-error unknown field
  void p.naoExiste;
  assertEquals((await posts.update(p.id, { nota: 4 })).nota, 4);
  assertEquals((await posts.get(p.id)).titulo, "Ola");
  await posts.delete(p.id);
  assertEquals(await posts.findOne(p.id), undefined);
  assertEquals((await assertRejects(() => posts.get(p.id)) as ApiError).status, 404);
});

Deno.test("query builder composes where, orderBy, limit/offset, first and count", async () => {
  const { store } = await setup();
  const posts = store.collection(st_posts);
  for (
    const [titulo, nota, status] of [["aa", 1, "publicado"], ["bb", 5, "rascunho"], ["cc", 3, "publicado"]] as const
  ) {
    await posts.create({ titulo, nota, status });
  }
  const pub = posts.query().where("status", "equals", "publicado");
  assertEquals((await pub.orderBy("nota", "desc").all()).map((p) => p.titulo), ["cc", "aa"]);
  assertEquals(await pub.count(), 2);
  assertEquals((await posts.query().orderBy("titulo").offset(1).limit(1).first())?.titulo, "bb");
  const either = posts.query().where({ or: [{ nota: { greater_than: 4 } }, { titulo: { equals: "aa" } }] });
  assertEquals((await either.orderBy("titulo").all()).map((p) => p.titulo), ["aa", "bb"]);
  assert(await posts.query().where("titulo", "like", "c").exists());
  // A builder is immutable: deriving from pub did not change it.
  assertEquals(pub.toQuery(), { where: { status: { equals: "publicado" } } });
});

Deno.test("system store skips access and sees hidden fields; store.as applies the principal's rules", async () => {
  const { store } = await setup();
  const posts = store.collection(st_posts);
  await posts.create({ titulo: "draft", status: "rascunho", segredo: "s" } as never);
  await posts.create({ titulo: "live", status: "publicado" });
  assertEquals(await posts.count(), 2);
  assertEquals((await posts.query().where("titulo", "equals", "draft").first())?.segredo, "s");
  const guest = store.as(null).collection(st_posts);
  assertEquals((await guest.find()).map((p) => p.titulo), ["live"]);
  assertEquals("segredo" in (await guest.find())[0], false);
});

Deno.test("zod validation answers with PB error codes: field types, field schema and collection schema", async () => {
  const { store } = await setup();
  const posts = store.collection(st_posts);
  const errOf = async (data: Record<string, unknown>) =>
    ((await assertRejects(() => posts.create(data as never))) as ApiError).data;
  assertEquals((await errOf({ titulo: "a" })).titulo.code, "validation_min_text_constraint");
  assertEquals((await errOf({ titulo: "ok", nota: 1.5 })).nota.code, "validation_only_int_constraint");
  assertEquals((await errOf({ titulo: "ok", nota: -1 })).nota.code, "validation_min_number_constraint");
  assertEquals((await errOf({ titulo: "ok", status: "x" })).status.code, "validation_invalid_value");
  assertEquals((await errOf({ titulo: "ok", meta: { autor: 1 } })).meta.code, "validation_invalid_value");
  assertEquals((await errOf({ titulo: "proibido" })).titulo, {
    code: "validation_reserved",
    message: "Reserved title.",
  });
  assertEquals((await errOf({ titulo: "ok", tag: "nope" })).tag.code, "validation_missing_rel_records");
});

Deno.test("an empty single relation is stored NULL, keeps its foreign key and still matches equals ''", async () => {
  const { db, store } = await setup();
  const posts = store.collection(st_posts);
  const tag = await store.collection(st_tags).create({ nome: "com-tag" });
  // With foreign keys on, '' in the column would be refused as a missing st_tags row.
  const sem = await posts.create({ titulo: "Sem tag", tag: "" });
  const com = await posts.create({ titulo: "Com tag", tag: tag.id });
  assertEquals(sem.tag, "");
  assertEquals((db.prepare("SELECT tag FROM st_posts WHERE id = ?").get(sem.id) as { tag: unknown }).tag, null);
  // A row migrated from PB keeps '' (written before foreign keys checked it): equals '' finds both forms.
  db.exec("PRAGMA foreign_keys = OFF");
  db.prepare("INSERT INTO st_posts (id, created, updated, titulo, tag) VALUES ('legadopb0000001', '', '', 'PB', '')")
    .run();
  db.exec("PRAGMA foreign_keys = ON");
  const vazios = await posts.query().where("tag", "equals", "").all();
  assertEquals(vazios.map((p) => p.id).sort(), [sem.id, "legadopb0000001"].sort());
  assertEquals((await posts.query().where("tag", "not_equals", "").all()).map((p) => p.id), [com.id]);
});
