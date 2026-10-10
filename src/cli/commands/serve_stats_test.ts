import { assertEquals } from "@std/assert";
import { DatabaseSync } from "node:sqlite";
import { analisarSeSemEstatisticas } from "./serve.ts";

Deno.test("serve analyzes a db that came without sqlite_stat1, once", () => {
  const db = new DatabaseSync(":memory:");
  db.exec("CREATE TABLE t (a TEXT, b TEXT); CREATE INDEX t_a ON t (a); CREATE INDEX t_b ON t (b)");
  for (let i = 0; i < 50; i++) db.prepare("INSERT INTO t VALUES (?, ?)").run(String(i), String(i % 2));
  assertEquals(analisarSeSemEstatisticas(db), true);
  assertEquals((db.prepare("SELECT count(*) AS n FROM sqlite_stat1").get() as { n: number }).n > 0, true);
  assertEquals(analisarSeSemEstatisticas(db), false);
});
