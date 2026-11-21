import { assertEquals } from "@std/assert";
import { DatabaseSync } from "node:sqlite";
import { enqueueDue } from "./scheduler.ts";
import { ensureJobsTable } from "./table.ts";
import type { ScheduleDef } from "./types.ts";

const job = () => ({
  queue: "normal" as const,
  name: "t",
  payload: null,
  maxAttempts: 1,
  backoffMs: 0,
  timeoutMs: 0,
  leaseMs: 1_000,
});

Deno.test("a clock that jumped ahead and back does not silence a schedule: lastSlot is clamped to now", () => {
  const db = new DatabaseSync(":memory:");
  ensureJobsTable(db);
  const defs: ScheduleDef[] = [{ id: "every", expression: "* * * * *", job: "t" }];
  const t0 = Date.UTC(2026, 0, 1, 12, 0);
  // The clock runs a day ahead for one tick...
  assertEquals(enqueueDue(db, defs, t0 + 86_400_000, "UTC", job, (fn) => fn()).length, 1);
  db.exec(`UPDATE _jobs SET status = 'done'`);
  // ...then comes back: the next minute still fires.
  assertEquals(enqueueDue(db, defs, t0 + 60_000, "UTC", job, (fn) => fn()).length, 1);
  db.exec(`UPDATE _jobs SET status = 'done'`);
  // And the same minute does not fire twice.
  assertEquals(enqueueDue(db, defs, t0 + 60_000, "UTC", job, (fn) => fn()).length, 0);
});
