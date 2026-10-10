import { assertEquals, assertRejects, assertThrows } from "@std/assert";
import { defineCollection } from "../core/define.ts";
import { registerCollections } from "../core/registry.ts";
import type { ApiError } from "../core/errors.ts";
import type { CollectionConfig } from "../core/types.ts";
import { openDb } from "../core/db.ts";
import * as migrations from "../migrations/mod.ts";
import { createStore } from "../store/mod.ts";
import { dbWith } from "../testing/mod.ts";
import { count, defineView, deriveViewFields, from, sqlView, sum } from "./mod.ts";

const vw_times = defineCollection({
  slug: "vw_times",
  fields: [{ name: "nome", type: "text", required: true }],
  access: { read: () => true },
});
const vw_pessoas = defineCollection({
  slug: "vw_pessoas",
  fields: [
    { name: "nome", type: "text", required: true },
    { name: "idade", type: "number", integer: true },
    { name: "ativo", type: "checkbox" },
    { name: "time", type: "relationship", relationTo: "vw_times" },
  ],
  access: { read: () => true },
});
const vw_ativos = defineView({
  slug: "vw_ativos",
  query: from(vw_pessoas)
    .select({ nome: "nome", time: "time", timeNome: "time.nome" })
    .where("ativo", "equals", true)
    .where("nome", "not_equals", "o'brien"),
  access: { read: () => true },
});
const vw_por_time = defineView({
  slug: "vw_por_time",
  query: from(vw_pessoas).select({ id: "time", time: "time", total: count(), idades: sum("idade") }).groupBy("time"),
  access: { read: () => true },
});
const vw_fechada = defineView({ slug: "vw_fechada", query: from(vw_pessoas).select({ nome: "nome" }) });
const vw_sql = defineView({
  slug: "vw_sql",
  query: sqlView(
    vw_pessoas,
    `SELECT p.id, UPPER(p.nome) || '@' || COALESCE(t.nome, '-') AS rotulo, p.time FROM vw_pessoas p
     LEFT JOIN vw_times t ON t.id = p.time UNION ALL SELECT t.id, t.nome, NULL FROM vw_times t`,
    [{ name: "rotulo", type: "text" }, { name: "time", type: "relationship", relationTo: "vw_times" }],
  ),
  access: { read: () => true },
});
registerCollections(vw_times, vw_pessoas, vw_ativos, vw_por_time, vw_fechada, vw_sql);

async function seeded() {
  const db = await dbWith([vw_times, vw_pessoas, vw_ativos, vw_por_time, vw_fechada, vw_sql]);
  const store = createStore(db);
  const a = await store.collection(vw_times).create({ nome: "A" });
  const b = await store.collection(vw_times).create({ nome: "B" });
  const pessoas = store.collection(vw_pessoas);
  await pessoas.create({ nome: "ana", idade: 30, ativo: true, time: a.id });
  await pessoas.create({ nome: "bia", idade: 25, ativo: false, time: a.id });
  await pessoas.create({ nome: "o'brien", idade: 40, ativo: true, time: b.id });
  await pessoas.create({ nome: "caio", idade: 10, ativo: true, time: b.id });
  return { db, store, a, b };
}

Deno.test("view fields are derived from the query: paths keep the source type, aggregates are numbers", () => {
  assertEquals(vw_ativos.fields, [
    { name: "nome", type: "text" },
    { name: "time", type: "relationship", relationTo: "vw_times" },
    { name: "timeNome", type: "text" },
  ]);
  assertEquals(vw_por_time.fields, [
    { name: "time", type: "relationship", relationTo: "vw_times" },
    { name: "total", type: "number", integer: true },
    { name: "idades", type: "number" },
  ]);
  assertThrows(() => deriveViewFields({ from: "vw_pessoas", select: { x: "nope" } }, [vw_pessoas]), Error, "nope");
  assertThrows(() => defineView({ slug: "v", query: from(vw_pessoas).select({ n: count() }).groupBy("time") }));
});

Deno.test("a view reads like any collection: where through relations, quoting, sort, expand and grouping", async () => {
  const { store, a, b } = await seeded();
  const ativos = await store.collection(vw_ativos).query().orderBy("nome").all();
  assertEquals(ativos.map((r) => [r.nome, r.timeNome]), [["ana", "A"], ["caio", "B"]]);
  const expanded = await store.collection("vw_ativos").find({ where: { nome: { equals: "ana" } } });
  assertEquals(expanded[0].time, a.id);
  const grupos = await store.collection(vw_por_time).query().orderBy("idades", "desc").all();
  assertEquals(grupos.map((g) => [g.id, g.total, g.idades]), [[a.id, 2, 55], [b.id, 2, 50]]);
  assertEquals((await store.collection(vw_por_time).get(b.id)).total, 2);
});

Deno.test("a SQL view runs its SELECT as written and exposes the declared fields", async () => {
  assertThrows(() => defineView({ slug: "v", query: sqlView("vw_pessoas", "SELECT 1 AS id", []) }), Error, "fields");
  assertEquals(vw_sql.fields, [
    { name: "rotulo", type: "text" },
    { name: "time", type: "relationship", relationTo: "vw_times" },
  ]);
  const { store, a } = await seeded();
  const rows = await store.collection(vw_sql).query().where("rotulo", "like", "ANA").all();
  assertEquals(rows.map((r) => [r.rotulo, r.time]), [["ANA@A", a.id]]);
  assertEquals(await store.collection(vw_sql).query().count(), 6);
});

Deno.test("a view page has no DISTINCT unless a filter joins: SQLite pages it without reading every row", async () => {
  const { db, store, a } = await seeded();
  const seen: string[] = [];
  const spy = db as unknown as { prepare: (sql: string) => unknown };
  const original = spy.prepare;
  spy.prepare = function (this: unknown, sql: string) {
    seen.push(sql);
    return original.call(this, sql);
  };
  try {
    const page = await store.collection(vw_sql).query().orderBy("rotulo").limit(2).all();
    assertEquals(page.map((r) => r.rotulo), ["A", "ANA@A"]);
    assertEquals(await store.collection(vw_sql).query().where("time", "equals", a.id).count(), 2);
  } finally {
    spy.prepare = original;
  }
  assertEquals(seen.filter((q) => q.includes("vw_sql") && /SELECT DISTINCT/.test(q)), []);
});

Deno.test("a view that repeats an id lists every row and counts distinct ids (produtos_requisicoes shape)", async () => {
  const vw_rep = defineView({
    slug: "vw_rep",
    query: sqlView(vw_pessoas, `SELECT p.time AS id, p.nome AS nome FROM vw_pessoas p`, [{
      name: "nome",
      type: "text",
    }]),
    access: { read: () => true },
  });
  registerCollections(vw_rep);
  const db = await dbWith([vw_times, vw_pessoas, vw_rep]);
  const store = createStore(db);
  const a = await store.collection(vw_times).create({ nome: "A" });
  for (const nome of ["ana", "bia", "caio"]) await store.collection(vw_pessoas).create({ nome, time: a.id });
  const rows = await store.collection(vw_rep).query().orderBy("nome").all();
  assertEquals(rows.map((r) => [r.id, r.nome]), [[a.id, "ana"], [a.id, "bia"], [a.id, "caio"]]);
  assertEquals(await store.collection(vw_rep).query().count(), 1);
});

Deno.test("views are read-only: every write answers PB's 400 Unsupported collection type", async () => {
  const { store } = await seeded();
  const v = store.collection("vw_ativos");
  for (const write of [() => v.create({ nome: "x" }), () => v.update("x", {}), () => v.delete("x")]) {
    const e = await assertRejects(write) as ApiError;
    assertEquals([e.status, e.message], [400, "Unsupported collection type."]);
  }
});

Deno.test("migrations: a view survives its source table rebuild and an edited query becomes alterView", async () => {
  const db = openDb();
  const base = (extra: CollectionConfig["fields"] = []) => ({
    ...vw_pessoas,
    fields: [...vw_pessoas.fields, ...extra],
  });
  const s1 = migrations.configToSnapshot([vw_times, base(), vw_fechada]);
  const m1 = { id: "1", parents: [], ops: migrations.diff({}, s1) };
  await migrations.up(db, [m1]);
  db.exec(`INSERT INTO vw_pessoas (id, created, updated, nome) VALUES ('p1', '', '', 'ana')`);
  // Altering a source column rebuilds vw_pessoas, which SQLite refuses while a view depends on it.
  const s2 = migrations.configToSnapshot([
    vw_times,
    base([{ name: "apelido", type: "text", unique: true }]),
    vw_fechada,
  ]);
  const m2 = { id: "2", parents: ["1"], ops: migrations.diff(s1, s2) };
  await migrations.up(db, [m1, m2]);
  assertEquals(db.prepare(`SELECT nome FROM vw_fechada`).all().map((r) => r.nome), ["ana"]);
  const edited = { ...vw_fechada, view: { ...vw_fechada.view, where: { nome: { equals: "x" } } } };
  const ops = migrations.diff(
    s2,
    migrations.configToSnapshot([vw_times, base([{ name: "apelido", type: "text", unique: true }]), edited]),
  );
  assertEquals(ops.map((o) => o.op), ["alterView"]);
  await migrations.up(db, [m1, m2, { id: "3", parents: ["2"], ops }]);
  assertEquals(db.prepare(`SELECT COUNT(*) AS n FROM vw_fechada`).get(), { n: 0 });
});
