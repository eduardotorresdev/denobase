import { assertEquals } from "@std/assert";
import { DatabaseSync } from "node:sqlite";
import { deleteInBatches, deleteOldestInBatches } from "./batched_delete.ts";
import { Logs } from "../../logs/mod.ts";

function table(n: number) {
  const db = new DatabaseSync(":memory:");
  db.exec(`CREATE TABLE t (id INTEGER PRIMARY KEY, v INTEGER)`);
  const ins = db.prepare(`INSERT INTO t (v) VALUES (?)`);
  for (let i = 0; i < n; i++) ins.run(i);
  return db;
}
const count = (db: DatabaseSync) => Number((db.prepare(`SELECT COUNT(*) AS n FROM t`).get() as { n: number }).n);

Deno.test("deleteInBatches deletes every match in batches, yielding to the loop between them", async () => {
  const db = table(1050);
  let ticks = 0;
  const timer = setInterval(() => ticks++, 0);
  const n = await deleteInBatches(db, "t", "v < ?", [1000], 100);
  clearInterval(timer);
  assertEquals([n, count(db)], [1000, 50]);
  // 10 full batches, each followed by a yield the interval can run in.
  assertEquals(ticks >= 1, true);
});

Deno.test("deleteOldestInBatches keeps the newest rows", async () => {
  const db = table(1234);
  assertEquals(await deleteOldestInBatches(db, "t", "v", 1200, 500), 1200);
  assertEquals((db.prepare(`SELECT MIN(v) AS m FROM t`).get() as { m: number }).m, 1200);
});

Deno.test("logs cleanup drops only entries older than the date", async () => {
  const logs = new Logs(new DatabaseSync(":memory:"));
  const ins = logs.db.prepare(`INSERT INTO _logs (id, created, data, message, level) VALUES (?, ?, '{}', '', 0)`);
  for (let i = 0; i < 1100; i++) ins.run(`old${i}`, "2020-01-01 00:00:00.000Z");
  ins.run("new", "2099-01-01 00:00:00.000Z");
  await logs.deleteOlderThan(new Date("2021-01-01T00:00:00Z"));
  assertEquals((logs.db.prepare(`SELECT id FROM _logs`).all() as { id: string }[]).map((r) => r.id), ["new"]);
});
