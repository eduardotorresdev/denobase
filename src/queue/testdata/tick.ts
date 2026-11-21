import { openDb } from "../../core/db.ts";
import { ensureJobsTable } from "../table.ts";
import { enqueueDue } from "../scheduler.ts";

/** One serve's scheduler tick, as its own process: `tick.ts <db> <at ms>`. */
const db = openDb(Deno.args[0]);
ensureJobsTable(db);
const defs = [{ id: "s", expression: "* * * * *", job: "t_sleep", payload: { ms: 0 } }];
enqueueDue(db, defs, Number(Deno.args[1]), "UTC", () => ({
  queue: "normal",
  name: "t_sleep",
  payload: { ms: 0 },
  maxAttempts: 1,
  backoffMs: 0,
  leaseMs: 60_000,
  timeoutMs: 60_000,
}), (fn) => {
  db.exec("BEGIN IMMEDIATE");
  try {
    const r = fn();
    db.exec("COMMIT");
    return r;
  } catch (e) {
    db.exec("ROLLBACK");
    throw e;
  }
});
db.close();
