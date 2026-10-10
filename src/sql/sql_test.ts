import { assertEquals, assertRejects, assertThrows } from "@std/assert";
import { DatabaseSync } from "node:sqlite";
import { ReadOnlySqlError, selectRows } from "./read.ts";
import { guardedQuery, SqlRejected } from "./guard.ts";

const SCHEMA = `
  CREATE TABLE pedidos (id TEXT PRIMARY KEY, cliente TEXT, valor REAL, tags TEXT);
  CREATE TABLE clientes (id TEXT PRIMARY KEY, nome TEXT, limite REAL);
  CREATE TABLE _superusers (id TEXT, passwordHash TEXT);
  INSERT INTO clientes VALUES ('c1', 'Ana', 1000), ('c2', 'Bia', 50);
  INSERT INTO pedidos VALUES ('p1', 'c1', 10, '["a","b"]'), ('p2', 'c1', 5, '["a"]'), ('p3', 'c2', 7, '[]');
  INSERT INTO _superusers VALUES ('s', 'hash');
`;

function memDb(): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  db.exec(SCHEMA);
  return db;
}

Deno.test("selectRows runs JOIN and json_each aggregations with params", () => {
  const db = memDb();
  const porCliente = selectRows<{ nome: string; total: number }>(
    db,
    "SELECT c.nome, sum(p.valor) AS total FROM pedidos p JOIN clientes c ON c.id = p.cliente WHERE p.valor > ? " +
      "GROUP BY c.nome ORDER BY c.nome",
    [1],
  );
  assertEquals(porCliente.map((r) => ({ ...r })), [{ nome: "Ana", total: 15 }, { nome: "Bia", total: 7 }]);
  const porTag = selectRows(
    db,
    "SELECT t.value AS tag, count(*) AS n FROM pedidos, json_each(pedidos.tags) t GROUP BY 1",
  );
  assertEquals(porTag.map((r) => ({ ...r })), [{ tag: "a", n: 2 }, { tag: "b", n: 1 }]);
});

Deno.test("selectRows refuses writes, PRAGMA and DDL at compile time and leaves the db writable", () => {
  const db = memDb();
  for (
    const sql of [
      "DELETE FROM pedidos",
      "UPDATE pedidos SET valor = 0",
      "PRAGMA table_info(pedidos)",
      "DROP TABLE pedidos",
    ]
  ) {
    assertThrows(() => selectRows(db, sql), ReadOnlySqlError);
  }
  assertEquals(selectRows<{ n: number }>(db, "SELECT count(*) AS n FROM pedidos")[0].n, 3);
  db.exec("DELETE FROM pedidos WHERE id = 'p3'"); // the authorizer is gone after the call
});

Deno.test("selectRows reuses the prepared read: later rows show, a refused write stays refused", () => {
  const db = memDb();
  const sql = "SELECT count(*) AS n FROM pedidos WHERE cliente = :c";
  assertEquals(selectRows<{ n: number }>(db, sql, { c: "c1" })[0].n, 2);
  db.exec("INSERT INTO pedidos VALUES ('p4', 'c1', 1, '[]')");
  assertEquals(selectRows<{ n: number }>(db, sql, { c: "c1" })[0].n, 3);
  for (let i = 0; i < 2; i++) assertThrows(() => selectRows(db, "DELETE FROM pedidos"), ReadOnlySqlError);
  // A schema change under a cached statement re-prepares it transparently.
  db.exec("ALTER TABLE pedidos ADD COLUMN extra TEXT");
  assertEquals(selectRows<{ n: number }>(db, sql, { c: "c2" })[0].n, 1);
});

async function fileDb(): Promise<string> {
  const dir = await Deno.makeTempDir();
  const path = `${dir}/data.db`;
  const db = new DatabaseSync(path);
  db.exec("PRAGMA journal_mode = WAL;" + SCHEMA);
  db.close();
  return path;
}

Deno.test("guardedQuery returns columns and array rows, reporting the tables read", async () => {
  const path = await fileDb();
  const r = await guardedQuery(
    path,
    "SELECT c.nome, p.id FROM pedidos p JOIN clientes c ON c.id = p.cliente WHERE p.valor >= ? ORDER BY p.id;",
    [7],
  );
  assertEquals([r.columns, r.rows, r.truncated, r.tables], [
    ["nome", "id"],
    [["Ana", "p1"], ["Bia", "p3"]],
    false,
    ["clientes", "pedidos"],
  ]);
});

Deno.test("guardedQuery refuses by layer: forma, tabelas (allowlist, system, column), conexao", async () => {
  const path = await fileDb();
  const layer = async (sql: string, opts = {}) =>
    (await assertRejects(() => guardedQuery(path, sql, [], opts), SqlRejected)).layer;
  assertEquals(await layer("SELEC 1"), "forma");
  assertEquals(await layer("SELECT 1; DELETE FROM pedidos"), "forma");
  assertEquals(await layer("SELECT * FROM clientes", { tables: ["pedidos"] }), "tabelas");
  assertEquals(await layer("SELECT * FROM _superusers"), "tabelas");
  assertEquals(await layer("SELECT limite FROM clientes", { deniedColumns: ["clientes.limite"] }), "tabelas");
  assertEquals(await layer("SELECT * FROM pragma_table_info('pedidos')"), "tabelas");
  const db = new DatabaseSync(path);
  assertEquals((db.prepare("SELECT count(*) AS n FROM pedidos").get() as { n: number }).n, 3);
  db.close();
});

Deno.test("guardedQuery truncates at maxRows and maxBytes", async () => {
  const path = await fileDb();
  const byRows = await guardedQuery(path, "SELECT id FROM pedidos ORDER BY id", [], { maxRows: 2 });
  assertEquals([byRows.rows, byRows.truncated], [[["p1"], ["p2"]], true]);
  const byBytes = await guardedQuery(path, "SELECT id FROM pedidos ORDER BY id", [], { maxBytes: 10 });
  assertEquals([byBytes.rows.length, byBytes.truncated], [1, true]);
});

Deno.test("guardedQuery terminates a runaway query at the timeout", async () => {
  const path = await fileDb();
  const e = await assertRejects(
    () =>
      guardedQuery(
        path,
        "WITH RECURSIVE n(x) AS (SELECT 1 UNION ALL SELECT x + 1 FROM n) SELECT count(*) FROM n",
        [],
        { timeoutMs: 300 },
      ),
    SqlRejected,
  );
  assertEquals(e.layer, "limites");
});
