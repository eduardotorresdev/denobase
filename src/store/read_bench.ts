/**
 * Cost of a plain store read against the raw SELECT it runs: `deno bench -A src/store/read_bench.ts`.
 * The collection mimics a production list (texts, numbers, bools, dates, selects, json, single and multi relations).
 */
import { defineCollection } from "../core/define.ts";
import { registerCollections } from "../core/registry.ts";
import { dbWith } from "../testing/mod.ts";
import { createStore } from "./mod.ts";
import { find, makeReq } from "../engine/mod.ts";

const rb_ref = defineCollection({ slug: "rb_ref", fields: [{ name: "nome", type: "text" }] });
const rb_rows = defineCollection({
  slug: "rb_rows",
  fields: [
    { name: "codigo", type: "text" },
    { name: "descricao", type: "text" },
    { name: "obs", type: "text" },
    { name: "largura", type: "number" },
    { name: "altura", type: "number" },
    { name: "espessura", type: "number" },
    { name: "quantidade", type: "number", integer: true },
    { name: "ativo", type: "checkbox" },
    { name: "cortado", type: "checkbox" },
    { name: "fita", type: "checkbox" },
    { name: "status", type: "select", options: ["a", "b", "c"] },
    { name: "inicio", type: "date" },
    { name: "fim", type: "date" },
    { name: "meta", type: "json" },
    { name: "medidas", type: "json" },
    { name: "ref", type: "relationship", relationTo: "rb_ref" },
    { name: "refs", type: "relationship", relationTo: "rb_ref", hasMany: true },
    { name: "segredo", type: "text", hidden: true },
  ],
  access: { read: () => true },
});
registerCollections(rb_ref, rb_rows);

const N = 1200;
const db = await dbWith([rb_ref, rb_rows]);
const store = createStore(db);
const refs = [];
for (let i = 0; i < 5; i++) refs.push((await store.collection(rb_ref).create({ nome: `r${i}` })).id);
db.exec("BEGIN");
for (let i = 0; i < N; i++) {
  await store.collection(rb_rows).create({
    codigo: `P-${i}`,
    descricao: "Lateral esquerda MDF branco",
    obs: i % 3 ? "" : "conferir veio",
    largura: 550.5 + i,
    altura: 720,
    espessura: 18,
    quantidade: 2,
    ativo: true,
    cortado: i % 2 === 0,
    fita: false,
    status: "b",
    inicio: "2026-10-07 12:00:00.000Z",
    fim: "",
    meta: { lote: i, tags: ["x", "y"] },
    medidas: [1, 2, 3],
    ref: refs[i % 5],
    refs: refs.slice(0, 3),
    segredo: "s",
  });
}
db.exec("COMMIT");

const raw = db.prepare(`SELECT * FROM "rb_rows"`);
const user = { id: "u", collection: "users", record: { id: "u" } };
const asUser = store.as(user).collection(rb_rows);

Deno.bench("raw SELECT *", { group: "read", baseline: true }, () => {
  raw.all();
});
Deno.bench("system store find()", { group: "read" }, async () => {
  await store.collection(rb_rows).find();
});
Deno.bench("user store find()", { group: "read" }, async () => {
  await asUser.find();
});
Deno.bench("REST-style list (perPage 1000, user)", { group: "read" }, async () => {
  await find({ collection: "rb_rows", req: makeReq(store, user), perPage: 1000, skipTotal: true });
});

// Stage breakdown of the same read, to see where the per-row cost goes.
import * as sql from "./sqlite.ts";
import { present } from "../engine/present.ts";
const rawRows = raw.all() as Record<string, unknown>[];
const decoded = sql.findMany(db, rb_rows);
const sysReq = makeReq(store, null);
Deno.bench("stage: SELECT DISTINCT", { group: "stage" }, () => {
  db.prepare(`SELECT DISTINCT "rb_rows".* FROM "rb_rows"`).all();
});
Deno.bench("stage: decode only", { group: "stage" }, () => {
  for (const r of rawRows) sql.decode(rb_rows, r);
});
Deno.bench("stage: findMany (sql + decode)", { group: "stage" }, () => {
  sql.findMany(db, rb_rows);
});
Deno.bench("stage: present only", { group: "stage" }, async () => {
  for (const d of decoded) await present(sysReq, rb_rows, d, { override: true, showHidden: true });
});
