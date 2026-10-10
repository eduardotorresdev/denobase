import { assertEquals } from "@std/assert";
import { DatabaseSync } from "node:sqlite";
import { asRollbackJournal, restore } from "./mod.ts";

function templateBytes(): Uint8Array {
  const db = new DatabaseSync(":memory:");
  db.exec("CREATE TABLE t (id TEXT PRIMARY KEY); INSERT INTO t VALUES ('a');");
  const bytes = db.serialize();
  db.close();
  return bytes;
}

Deno.test("restore gives each caller an independent writable copy", () => {
  const bytes = templateBytes();
  const a = restore(bytes);
  a.exec("INSERT INTO t VALUES ('b')");
  const b = restore(bytes);
  assertEquals(b.prepare("SELECT COUNT(*) AS n FROM t").get(), { n: 1 });
  assertEquals(a.prepare("SELECT COUNT(*) AS n FROM t").get(), { n: 2 });
  assertEquals(a.prepare("PRAGMA foreign_keys").get(), { foreign_keys: 1 });
});

Deno.test("a WAL-mode template is opened as rollback journal without touching the source bytes", () => {
  const bytes = templateBytes();
  bytes[18] = 2;
  bytes[19] = 2;
  const fixed = asRollbackJournal(bytes);
  assertEquals([fixed[18], fixed[19], bytes[18]], [1, 1, 2]);
  assertEquals(restore(fixed).prepare("SELECT id FROM t").get(), { id: "a" });
});
