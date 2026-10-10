import { assertEquals, assertThrows } from "@std/assert";
import type { DatabaseSync } from "node:sqlite";
import { openDb } from "../core/db.ts";
import type { CollectionConfig, Where } from "../core/types.ts";
import { ApiError } from "../core/errors.ts";
import { andWhere, compilePb, parseExpand, parseFields, pickFields, sortToSql, whereToSql } from "./mod.ts";

const cargos: CollectionConfig = {
  slug: "cargos",
  fields: [{ name: "titulo", type: "text" }, {
    name: "permissoes",
    type: "select",
    options: ["a", "b"],
    hasMany: true,
  }],
};
const users: CollectionConfig = {
  slug: "users",
  auth: true,
  fields: [
    { name: "name", type: "text" },
    { name: "age", type: "number" },
    { name: "cargo", type: "relationship", relationTo: "cargos" },
    { name: "extras", type: "relationship", relationTo: "cargos", hasMany: true },
    { name: "passwordHash", type: "text", hidden: true },
  ],
};
const all = [cargos, users];

// Hand-built tables keep this suite independent of the schema module, which is developed in parallel.
function db(): DatabaseSync {
  const d = openDb();
  d.exec(`
    CREATE TABLE cargos (id TEXT PRIMARY KEY, created TEXT, updated TEXT, titulo TEXT, permissoes TEXT);
    CREATE TABLE users (id TEXT PRIMARY KEY, created TEXT, updated TEXT, email TEXT, verified INTEGER,
      passwordHash TEXT, name TEXT, age REAL, cargo TEXT, extras TEXT);
    INSERT INTO cargos VALUES ('c1','2024','2024','Admin','["a","b"]'), ('c2','2024','2024','Vendas','["b"]');
    INSERT INTO users VALUES
      ('u1','2024-01','x','a@x.com',1,'h','Ana',30,'c1','["c2"]'),
      ('u2','2024-02','x','b@x.com',0,'h','Bia 100%',20,'c2','[]'),
      ('u3','2024-03','x','c@x.com',0,'h',NULL,NULL,NULL,NULL);
  `);
  return d;
}

function ids(w: Where, sort = ""): string[] {
  const f = whereToSql(users, w, all);
  const sql = `SELECT DISTINCT "users"."id" AS id FROM "users" ${f.joins.join(" ")} WHERE ${f.sql} ${
    sort || 'ORDER BY "users"."id"'
  }`;
  return db().prepare(sql).all(...f.params).map((r) => String(r.id));
}
const request = (auth: Record<string, unknown> | null) => ({
  context: "default",
  method: "GET",
  query: {},
  headers: {},
  body: {},
  auth: auth ? { collection: "users", record: auth } : null,
});
/** PB filter compiled as a superuser would (hidden fields allowed, no joined read rules). */
const pbFilter = (filter: string, auth: Record<string, unknown> | null = null, allowHidden = true) =>
  compilePb(users, { filter }, { collections: all, request: request(auth), allowHidden });
const q = (filter: string, auth: Record<string, unknown> | null = null) => {
  const f = pbFilter(filter, auth);
  const sql = `SELECT DISTINCT "users"."id" AS id FROM "users" ${
    f.joins.join(" ")
  } WHERE ${f.where} ORDER BY "users"."id"`;
  return db().prepare(sql).all(...f.joinParams, ...f.params).map((r) => String(r.id));
};
const status = (fn: () => unknown) => (assertThrows(fn, ApiError) as ApiError).status;

Deno.test("where operators compile to parameterized SQL", () => {
  assertEquals(ids({ name: { equals: "Ana" } }), ["u1"]);
  assertEquals(ids({ name: { not_equals: "Ana" } }), ["u2", "u3"]);
  assertEquals(ids({ age: { greater_than: 20 } }), ["u1"]);
  assertEquals(ids({ age: { less_than_equal: 20 } }), ["u2"]);
  assertEquals(ids({ id: { in: ["u1", "u3"] } }), ["u1", "u3"]);
  assertEquals(ids({ id: { in: [] } }), []);
  assertEquals(ids({ id: { not_in: ["u1"] } }), ["u2", "u3"]);
  assertEquals(ids({ name: { exists: false } }), ["u3"]);
  assertEquals(ids({ verified: { equals: true } }), ["u1"]);
  assertEquals(ids({ or: [{ name: { equals: "Ana" } }, { age: { equals: 20 } }] }), ["u1", "u2"]);
  assertEquals(ids({}), ["u1", "u2", "u3"]);
});

Deno.test("like escapes wildcards unless caller passes %", () => {
  assertEquals(ids({ name: { like: "Bi%" } }), ["u2"]);
  assertEquals(ids({ name: { like: "_" } }), []);
  assertEquals(ids({ name: { not_like: "an" } }), ["u2", "u3"]);
});

Deno.test("relation paths join single relations and EXISTS hasMany", () => {
  assertEquals(ids({ "cargo.titulo": { equals: "Admin" } }), ["u1"]);
  assertEquals(ids({ and: [{ "cargo.titulo": { like: "a" } }, { "cargo.id": { equals: "c2" } }] }), ["u2"]);
  assertEquals(
    whereToSql(users, { "cargo.titulo": { exists: true }, "cargo.id": { exists: true } }, all).joins.length,
    1,
  );
  assertEquals(ids({ "extras.titulo": { equals: "Vendas" } }), ["u1"]);
  assertEquals(ids({ "cargo.permissoes": { equals: "a" } }), ["u1"]);
  assertEquals(ids({ "cargo.permissoes": { not_equals: "a" } }), ["u2", "u3"]);
  assertEquals(ids({ extras: { exists: true } }), ["u1"]);
});

Deno.test("hidden, unknown fields and operators are rejected", () => {
  assertEquals(status(() => whereToSql(users, { passwordHash: { equals: "h" } }, all)), 400);
  assertEquals(status(() => whereToSql(users, { nope: { equals: 1 } }, all)), 400);
  assertEquals(status(() => whereToSql(users, { "name.x": { equals: 1 } }, all)), 400);
  assertEquals(status(() => whereToSql(users, { name: { regex: "x" } } as unknown as Where, all)), 400);
  assertEquals(status(() => pbFilter("tokenKey != ''", null, false)), 400);
  assertEquals(status(() => pbFilter("passwordHash != ''", null, false)), 400);
});

Deno.test("injection attempts stay values or fail as 400", () => {
  assertEquals(q(`name = "Ana' OR 1=1 --"`), []);
  assertEquals(ids({ name: { equals: `"; DROP TABLE users; --` } }), []);
  assertEquals(status(() => q(`name = 1; DROP TABLE users`)), 400);
  assertEquals(status(() => whereToSql(users, { 'name" OR 1=1 --': { equals: 1 } }, all)), 400);
});

Deno.test("PB filter grammar", () => {
  assertEquals(q("name = 'Ana'"), ["u1"]);
  assertEquals(q('name != "Ana" && age >= 20'), ["u2"]);
  // u3's NULL age and verified read as PB's zero values (0, false).
  assertEquals(q("(age > 25 || age < 21) && verified = false"), ["u2", "u3"]);
  assertEquals(q("name ~ 'bi'"), ["u2"]);
  assertEquals(q("name !~ 'bi'"), ["u1", "u3"]);
  assertEquals(q("name = ''"), ["u3"]);
  assertEquals(q("cargo.titulo = 'Admin'"), ["u1"]);
  assertEquals(q("25 < age"), ["u1"]);
  assertEquals(q(`name = 'it\\'s'`), []);
  for (
    const bad of [
      "name =",
      "name = 'x",
      "(name = 'x'",
      "name = 'x')",
      "name 'x'",
      "name == 'x'",
      "a = b",
      "@collection.x = 1",
    ]
  ) {
    assertEquals(status(() => pbFilter(bad)), 400, bad);
  }
  // PB rejects an empty or whitespace-only filter expression.
  assertEquals(status(() => pbFilter("  ")), 400);
});

Deno.test("@request.auth resolves to values, guest as empty", () => {
  assertEquals(q("id = @request.auth.id", { id: "u2" }), ["u2"]);
  assertEquals(q("@request.auth.id != ''", null), []);
  assertEquals(q("@request.auth.id != ''", { id: "u1" }), ["u1", "u2", "u3"]);
  assertEquals(
    q("id = @request.auth.id || @request.auth.cargo.titulo = 'Admin'", { id: "u3", cargo: { titulo: "x" } }),
    [
      "u3",
    ],
  );
  assertEquals(q("id = @request.auth.id", null), []);
});

Deno.test("sort, expand, fields and andWhere helpers", () => {
  assertEquals(sortToSql(users, "-created, name"), 'ORDER BY "users"."created" DESC, "users"."name" ASC');
  assertEquals(sortToSql(users, ""), "");
  assertEquals(ids({}, sortToSql(users, "-created")), ["u3", "u2", "u1"]);
  assertEquals(status(() => sortToSql(users, "passwordHash")), 400);
  assertEquals(status(() => sortToSql(users, "name; DROP")), 400);
  assertEquals(parseExpand("cargo, extras.x"), { cargo: {}, extras: { x: {} } });
  assertEquals(status(() => parseExpand("a.b.c.d.e.f.g")), 400);
  assertEquals(parseFields("*,id"), null);
  const t = parseFields("id,expand.cargo.titulo,name:excerpt(5)");
  assertEquals(pickFields({ id: "u1", name: "Ana", age: 1, expand: { cargo: { id: "c", titulo: "T" } } }, t), {
    id: "u1",
    name: "Ana",
    expand: { cargo: { titulo: "T" } },
  });
  assertEquals(andWhere({}, undefined, { a: { equals: 1 } }), { a: { equals: 1 } });
  assertEquals(andWhere({ a: { equals: 1 } }, { b: { equals: 2 } }), {
    and: [{ a: { equals: 1 } }, { b: { equals: 2 } }],
  });
});

Deno.test("a Date in a where becomes the db text layout, so it compares with stored dates", () => {
  const f = whereToSql(users, { created: { greater_than_equal: new Date("2026-10-06T03:00:00Z") } }, all);
  assertEquals(f.params, ["2026-10-06 03:00:00.000Z"]);
});
