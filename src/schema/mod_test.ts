import { assertEquals, assertThrows } from "@std/assert";
import { collectionToTable, createIndexSql, createTableSql, fromDb, quoteIdent, tableName, toDb } from "./mod.ts";
import type { Field } from "../core/types.ts";

Deno.test("tableName rejects slugs that are not plain identifiers", () => {
  assertEquals(tableName("cargos"), "cargos");
  assertThrows(() => tableName('x"; drop'));
});

Deno.test("auth collection gets implicit columns, unique email index and FK for single relationship", () => {
  const t = collectionToTable({
    slug: "users",
    auth: true,
    fields: [
      { name: "cargo", type: "relationship", relationTo: "cargos" },
      { name: "tags", type: "relationship", relationTo: "cargos", hasMany: true },
      { name: "permissoes", type: "json", virtual: true },
    ],
  });
  assertEquals(t.columns.map((c) => c.name), [
    "id",
    "created",
    "updated",
    "email",
    "passwordHash",
    "tokenKey",
    "emailVisibility",
    "verified",
    "cargo",
    "tags",
  ]);
  assertEquals(t.columns.find((c) => c.name === "cargo")?.references, "cargos");
  assertEquals(t.columns.find((c) => c.name === "tags")?.references, undefined);
  assertEquals(t.indexes, [{ name: "idx_users_email", columns: ["email"], unique: true }]);
});

Deno.test("toDb/fromDb round-trip json, hasMany, checkbox and PB zero values", () => {
  const json: Field = { name: "j", type: "json" };
  const many: Field = { name: "m", type: "select", options: ["a"], hasMany: true };
  const cb: Field = { name: "c", type: "checkbox" };
  assertEquals(fromDb(json, toDb(json, { a: [1] })), { a: [1] });
  assertEquals(fromDb(many, toDb(many, ["a"])), ["a"]);
  assertEquals(toDb(cb, true), 1);
  assertEquals(fromDb(cb, 0), false);
  assertEquals(fromDb(many, null), []);
  assertEquals(fromDb({ name: "t", type: "text" }, null), "");
  assertEquals(quoteIdent('a"b'), '"a""b"');
});

Deno.test("a partial unique index only binds the rows its where predicate selects", async () => {
  const { DatabaseSync } = await import("node:sqlite");
  const t = collectionToTable({
    slug: "estadias",
    fields: [{ name: "unidade", type: "text" }, { name: "encerrada_em", type: "date" }],
    indexes: [{ name: "idx_aberta", fields: ["unidade"], unique: true, where: "COALESCE(`encerrada_em`, '') = ''" }],
  });
  const db = new DatabaseSync(":memory:");
  db.exec(createTableSql(t));
  for (const i of t.indexes) db.exec(createIndexSql(t.name, i));
  const insert = db.prepare(
    "INSERT INTO estadias (id, created, updated, unidade, encerrada_em) VALUES (?, '', '', ?, ?)",
  );
  insert.run("a", "u1", "2026-01-01 10:00:00.000Z");
  insert.run("b", "u1", "2026-01-02 10:00:00.000Z");
  insert.run("c", "u1", "");
  assertThrows(() => insert.run("d", "u1", ""), Error, "UNIQUE");
  insert.run("e", "u2", "");
  db.close();
});

Deno.test("a desc index field serves a mixed ORDER BY without a temp B-tree", async () => {
  const { DatabaseSync } = await import("node:sqlite");
  const t = collectionToTable({
    slug: "raias",
    fields: [{ name: "c", type: "text" }, { name: "p", type: "number" }, { name: "d", type: "date" }],
    indexes: [{ name: "idx_raia", fields: ["c", "p", "d"], desc: ["p"] }],
  });
  const db = new DatabaseSync(":memory:");
  db.exec(createTableSql(t));
  for (const i of t.indexes) db.exec(createIndexSql(t.name, i));
  const plan = db.prepare("EXPLAIN QUERY PLAN SELECT id FROM raias WHERE c = '' ORDER BY p DESC, d").all()
    .map((r) => String(r.detail)).join("\n");
  assertEquals(plan.includes("USING INDEX idx_raia"), true, plan);
  assertEquals(plan.includes("TEMP B-TREE"), false, plan);
  db.close();
});
