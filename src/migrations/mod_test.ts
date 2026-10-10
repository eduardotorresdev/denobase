import { assertEquals, assertRejects, assertThrows } from "@std/assert";
import { DatabaseSync } from "node:sqlite";
import type { CollectionConfig } from "../core/types.ts";
import {
  applyOps,
  configToSnapshot,
  create,
  diff,
  heads,
  loadMigrations,
  type Migration,
  reconcile,
  replay,
  status,
  topoSort,
  up,
} from "./mod.ts";
import { opToSql } from "./ddl.ts";
import type { Snapshot } from "./types.ts";

const cargos: CollectionConfig = {
  slug: "cargos",
  fields: [{ name: "titulo", type: "text", required: true, unique: true }, { name: "funcoes", type: "json" }],
  access: { read: () => true },
};
const users: CollectionConfig = {
  slug: "users",
  auth: true,
  fields: [{ name: "name", type: "text" }, { name: "cargo", type: "relationship", relationTo: "cargos" }],
};

function memDb(): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  db.exec("PRAGMA foreign_keys = ON");
  return db;
}
const cols = (db: DatabaseSync, t: string) =>
  (db.prepare(`PRAGMA table_info("${t}")`).all() as { name: string }[]).map((r) => r.name);

Deno.test("diff then applyOps reaches the target snapshot and strips functions", () => {
  const to = configToSnapshot([cargos, users]);
  assertEquals(applyOps({}, diff({}, to)), to);
  assertEquals("access" in to.cargos, false);
  const changed = configToSnapshot([
    {
      ...cargos,
      fields: [{ name: "titulo", type: "text" }, { name: "x", type: "number" }],
      indexes: [{ fields: ["x"] }],
    },
  ]);
  const ops = diff(to, changed);
  assertEquals(ops.map((o) => o.op), ["dropCollection", "removeField", "alterField", "addField", "addIndex"]);
  assertEquals(applyOps(to, ops), changed);
});

Deno.test("topoSort orders by parents with id tie-break; heads lists leaves", () => {
  const ms: Migration[] = [
    { id: "c", parents: ["a"], ops: [] },
    { id: "b", parents: ["a"], ops: [] },
    { id: "a", parents: [], ops: [] },
  ];
  assertEquals(topoSort(ms).map((m) => m.id), ["a", "b", "c"]);
  assertEquals(heads(ms), ["b", "c"]);
  assertThrows(() => topoSort([{ id: "x", parents: ["y"], ops: [] }]));
});

Deno.test("up applies DDL, keeps data through a column rebuild, and records status", async () => {
  const db = memDb();
  const m1: Migration = { id: "1", parents: [], ops: diff({}, configToSnapshot([cargos, users])) };
  assertEquals(await up(db, [m1]), ["1"]);
  db.prepare(`INSERT INTO cargos (id, created, updated, titulo) VALUES ('c1','t','t','Admin')`).run();
  db.prepare(`INSERT INTO users (id, created, updated, email, passwordHash, tokenKey, cargo)
    VALUES ('u1','t','t','a@b.c','h','k','c1')`).run();
  assertThrows(() =>
    db.prepare(`INSERT INTO cargos (id, created, updated, titulo) VALUES ('c2','t','t','Admin')`).run()
  );

  const next = configToSnapshot([{ ...cargos, fields: [cargos.fields[0]] }, users]);
  const m2: Migration = { id: "2", parents: ["1"], ops: diff(replay([m1]), next) };
  assertEquals(await up(db, [m1, m2]), ["2"]);
  assertEquals(cols(db, "cargos"), ["id", "created", "updated", "titulo"]);
  assertEquals(db.prepare(`SELECT titulo FROM cargos`).get(), { titulo: "Admin" });
  assertEquals((db.prepare(`PRAGMA foreign_key_check`).all()).length, 0);
  assertEquals(status(db, [m1, m2]), { applied: ["1", "2"], pending: [], heads: ["2"] });
  assertEquals(await up(db, [m1, m2]), []);
});

Deno.test("up refuses multiple heads and applies nothing", async () => {
  const db = memDb();
  const ms: Migration[] = [
    { id: "a", parents: [], ops: [] },
    { id: "b", parents: ["a"], ops: [] },
    { id: "c", parents: ["a"], ops: [] },
  ];
  await assertRejects(() => up(db, ms), Error, "multiple heads");
  assertEquals(status(db, ms).applied, []);
});

Deno.test("create writes chained migrations and snapshot; reconcile merges heads", async () => {
  const dir = new URL(`file://${await Deno.makeTempDir()}/`);
  try {
    const m1 = (await create([cargos], dir))!;
    assertEquals(m1.parents, []);
    assertEquals(await create([cargos], dir), null);
    const m2 = (await create([cargos, users], dir))!;
    assertEquals(m2.parents, [m1.id]);
    const snap = JSON.parse(await Deno.readTextFile(new URL("schema.snapshot.json", dir)));
    assertEquals(snap, configToSnapshot([cargos, users]));

    // Simulate a second branch that also descended from m1 and added a field to cargos.
    const extra = { name: "nivel", type: "number" } as const;
    const branch: Migration = {
      id: "zz_branch",
      parents: [m1.id],
      ops: [{ op: "addField", slug: "cargos", field: extra }],
    };
    await Deno.writeTextFile(new URL("zz_branch.json", dir), JSON.stringify(branch));
    await assertRejects(() => create([cargos, users], dir), Error, "multiple heads");

    const final = [{ ...cargos, fields: [...cargos.fields, extra] }, users];
    const merge = (await reconcile(final, dir))!;
    assertEquals(merge.parents, [m2.id, "zz_branch"].sort());
    assertEquals(merge.ops, []);
    const ms = await loadMigrations(dir);
    assertEquals(heads(ms), [merge.id]);
    assertEquals(replay(ms), configToSnapshot(final));

    const db = memDb();
    await up(db, ms);
    assertEquals(cols(db, "cargos").includes("nivel"), true);
  } finally {
    await Deno.remove(new URL(dir), { recursive: true });
  }
});

const base: Migration = {
  id: "a",
  parents: [],
  ops: [{ op: "createCollection", collection: { slug: "x", auth: false, fields: [], indexes: [] } }],
};
const addN = (id: string): Migration => ({
  id,
  parents: ["a"],
  ops: [{ op: "addField", slug: "x", field: { name: "n", type: "number" } }],
});

Deno.test("reconcile merges branches that both added the same field", async () => {
  const dir = new URL(`file://${await Deno.makeTempDir()}/`);
  for (const m of [base, addN("b"), addN("c")]) {
    await Deno.writeTextFile(new URL(`${m.id}.json`, dir), JSON.stringify(m));
  }
  const x: CollectionConfig = { slug: "x", fields: [{ name: "n", type: "number" }] };
  const m = await reconcile([x], dir);
  assertEquals(m?.parents, ["b", "c"]);
  assertEquals(m?.ops, []);
});

Deno.test("up after a sibling branch was applied skips what it already did", async () => {
  const db = memDb();
  await up(db, [base, addN("b")]);
  const merge: Migration = { id: "m", parents: ["b", "c"], ops: [] };
  assertEquals(await up(db, [base, addN("b"), addN("c"), merge]), ["c", "m"]);
  assertEquals(cols(db, "x").includes("n"), true);
});

Deno.test("duplicate migration ids are named, not reported as a cycle", async () => {
  assertThrows(() => topoSort([base, { ...base }]), Error, "duplicate migration id: a");
  const dir = new URL(`file://${await Deno.makeTempDir()}/`);
  await Deno.writeTextFile(new URL("copy.json", dir), JSON.stringify(base));
  await assertRejects(() => loadMigrations(dir), Error, "has id a");
});

Deno.test("addIndex keeps the partial index predicate", () => {
  const before: Snapshot = { t: { slug: "t", auth: false, fields: [{ name: "a", type: "text" }], indexes: [] } };
  const sql = opToSql(
    { op: "addIndex", slug: "t", index: { name: "idx_t_a", fields: ["a"], unique: true, where: "`a` != ''" } },
    before,
  );
  assertEquals(sql, ['CREATE UNIQUE INDEX "idx_t_a" ON "t" ("a") WHERE `a` != \'\'']);
});
