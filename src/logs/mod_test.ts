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

Deno.test("traffic: per-hour totals, errors and nearest-rank latency since a date", () => {
  const h = (hh: number, mm = 0) => new Date(Date.UTC(2026, 9, 12, hh, mm));
  const logs = logsAt([
    [h(9), 0, { status: 200, execTime: 99 }], // before `since`: left out
    [h(10, 1), 0, { status: 200, execTime: 1 }],
    [h(10, 2), 0, { status: 404, execTime: 3 }],
    [h(10, 3), 8, { type: "cron" }], // error by level, no latency
    [h(11, 0), 0, { status: 200, execTime: 5 }],
  ]);
  const r = logs.traffic(h(10));
  assertEquals(r.hours, [
    { date: "2026-10-12 10:00:00.000Z", total: 3, errors: 2, avg: 2, p90: 3, p99: 3 },
    { date: "2026-10-12 11:00:00.000Z", total: 1, errors: 0, avg: 5, p90: 5, p99: 5 },
  ]);
  assertEquals(r.overall, { avg: 3, p90: 5, p99: 5 });
});

Deno.test("traffic: the created filter uses an index, not a table scan", () => {
  const logs = logsAt([]);
  const plan = logs.db.prepare("EXPLAIN QUERY PLAN SELECT id FROM _logs WHERE created >= ?").all("x")
    .map((r) => String((r as { detail: string }).detail)).join(" ");
  assertEquals(/idx_logs_created/.test(plan), true, plan);
});
