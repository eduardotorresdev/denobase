import { assertEquals } from "@std/assert";
import { DatabaseSync } from "node:sqlite";
import { Logs } from "./mod.ts";
import { stamp } from "../core/time.ts";

function logsAt(rows: [Date, number, Record<string, unknown>][]): Logs {
  const logs = new Logs(new DatabaseSync(":memory:"));
  const ins = logs.db.prepare(
    `INSERT INTO _logs (id, level, message, data, created, updated) VALUES (?, ?, '', ?, ?, ?)`,
  );
  rows.forEach(([at, level, data], i) => ins.run(`l${i}`, level, JSON.stringify(data), stamp(at), stamp(at)));
  return logs;
}

Deno.test("logs: a created filter uses an index, not a table scan", () => {
  const logs = logsAt([]);
  const plan = logs.db.prepare("EXPLAIN QUERY PLAN SELECT id FROM _logs WHERE created >= ?").all("x")
    .map((r) => String((r as { detail: string }).detail)).join(" ");
  assertEquals(/idx_logs_created/.test(plan), true, plan);
});
