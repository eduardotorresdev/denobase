import type { DatabaseSync } from "node:sqlite";
import { Schedule } from "../cron/schedule.ts";
import { insertJob, type NewJob } from "./table.ts";
import type { JobRow, ScheduleDef } from "./types.ts";

/** The WAL checkpoints run inside the scheduler, not as jobs (§5): their ids, hidden from /api/crons. */
export const WAL_SCHEDULES = ["__denobaseWalCheckpoint__", "__denobaseWalTruncate__"];

const MINUTE = 60_000;
/** A scheduled job is valid until the next slot, at most this long (a missed 02:00 backup does not run at 14:00). */
const MAX_VALIDITY = 24 * 60 * MINUTE;

const parsed = new Map<string, Schedule>();
function schedule(expr: string): Schedule {
  let s = parsed.get(expr);
  if (!s) parsed.set(expr, s = new Schedule(expr));
  return s;
}

/** The next slot of expr after `slot`, scanning at most MAX_VALIDITY ahead. */
export function nextSlot(expr: string, slot: number, tz: string): number {
  const s = schedule(expr);
  for (let t = slot + MINUTE; t <= slot + MAX_VALIDITY; t += MINUTE) if (s.isDue(new Date(t), tz)) return t;
  return slot + MAX_VALIDITY;
}

/** What a schedule enqueues, given the job's definition (queue, tries). */
export type ScheduledJob = (def: ScheduleDef) => Omit<NewJob, "runAt" | "schedule" | "dedupe" | "expiresAt">;

/**
 * Enqueues every schedule due at the minute of `now`, each in one transaction with its lastSlot: two serves ticking
 * the same minute enqueue it once (§5). Not overlapping: `dedupe = cron:<id>` keeps one pending or running run per
 * schedule, so a slow run is never piled up. Returns what was enqueued. The caller owns the transaction boundary
 * (`inTx`): the supervisor's own connection, or tx() on a shared one.
 */
export function enqueueDue(
  db: DatabaseSync,
  defs: ScheduleDef[],
  now: number,
  tz: string,
  job: ScheduledJob,
  inTx: (fn: () => JobRow | null) => JobRow | null,
): JobRow[] {
  const slot = now - (now % MINUTE);
  const out: JobRow[] = [];
  for (const d of defs) {
    if (WAL_SCHEDULES.includes(d.id)) continue;
    let s: Schedule;
    try {
      s = schedule(d.expression);
    } catch {
      continue;
    }
    if (!s.isDue(new Date(slot), tz)) continue;
    const r = inTx(() => {
      db.prepare(`INSERT OR IGNORE INTO _queue_schedules (id, lastSlot) VALUES (?, 0)`).run(d.id);
      // A lastSlot ahead of the clock (it jumped forward, then back) would silence the schedule until the clock
      // catches up: clamp it (R9). One minute of slack keeps a node with a slightly fast clock from a double run.
      db.prepare(`UPDATE _queue_schedules SET lastSlot = ? WHERE id = ? AND lastSlot > ?`)
        .run(slot - MINUTE, d.id, slot + MINUTE);
      const won = db.prepare(`UPDATE _queue_schedules SET lastSlot = ? WHERE id = ? AND lastSlot < ?`)
        .run(slot, d.id, slot).changes > 0;
      if (!won) return null;
      const { row, created } = insertJob(db, {
        ...job(d),
        runAt: now,
        schedule: d.id,
        dedupe: d.dedupe ?? `cron:${d.id}`,
        // Valid until the next slot; counted from the real clock, so a pinned tick (tests) is valid too.
        expiresAt: Date.now() + (nextSlot(d.expression, slot, tz) - slot),
      }, now);
      if (!created) console.warn(`cron ${d.id}: skipped (schedule), the previous run is still going`);
      return created ? row : null;
    });
    if (r) out.push(r);
  }
  return out;
}

/** Whether a schedule of WAL maintenance is due now (the supervisor runs those itself). */
export function walDue(now: number, tz: string): { checkpoint: boolean; truncate: boolean } {
  const slot = new Date(now - (now % MINUTE));
  return { checkpoint: true, truncate: schedule("50 5 * * *").isDue(slot, tz) };
}

/** The long service that turns the scheduler on in a serve (src/queue/runtime.ts); its state is the health's alarm. */
export const SCHEDULER_SERVICE = "scheduler";
