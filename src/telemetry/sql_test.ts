import { assertEquals } from "@std/assert";
import { normalizeSql } from "./sql.ts";

Deno.test("sql: literals become ?, whitespace collapses, quoted identifiers stay", () => {
  assertEquals(
    normalizeSql(
      `SELECT  "t1".*\n  FROM "pedidos"   WHERE "nome" = 'O''Brien' AND "valor" > 10.5 AND x = 0x1F LIMIT 3`,
    ),
    `SELECT "t1".* FROM "pedidos" WHERE "nome" = ? AND "valor" > ? AND x = ? LIMIT ?`,
  );
});

Deno.test("sql: IN lists fold to one placeholder so the same statement groups", () => {
  assertEquals(normalizeSql(`SELECT 1 FROM t WHERE id IN (?, ?, ?)`), `SELECT ? FROM t WHERE id IN (?)`);
  assertEquals(normalizeSql(`DELETE FROM t WHERE id in ('a','b')`), `DELETE FROM t WHERE id IN (?)`);
});

Deno.test("sql: long statements are cut at 2KB", () => {
  const s = normalizeSql(`SELECT ${"col, ".repeat(1000)}x FROM t`);
  assertEquals(s.length, 2048);
  assertEquals(s.endsWith("..."), true);
});

Deno.test("sql: comments go, and typed SQL loses its double-quoted literals too", () => {
  assertEquals(
    normalizeSql(`SELECT a -- token abc\nFROM t /* secret x */ WHERE b = 'it''s'`),
    `SELECT a FROM t WHERE b = ?`,
  );
  assertEquals(normalizeSql(`SELECT "x" FROM t WHERE senha = "abc123"`), `SELECT "x" FROM t WHERE senha = "abc123"`);
  assertEquals(
    normalizeSql(`SELECT * FROM t WHERE senha = "abc123"`, { userSql: true }),
    `SELECT * FROM t WHERE senha = ?`,
  );
});
