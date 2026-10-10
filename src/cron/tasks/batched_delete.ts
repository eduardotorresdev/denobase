import type { DatabaseSync } from "node:sqlite";
import { inJobWorker } from "../../jobs/on_main.ts";

/** Rows per DELETE in the cleanup jobs: each is its own short write transaction. */
export const CLEANUP_BATCH = 500;

/**
 * The pause between batches. In the job worker it lasts longer than SQLite's busy-handler naps, so a writer on another
 * thread waiting for the lock gets it instead of the next batch; inline it only yields the loop.
 */
const yieldLoop = () => new Promise<void>((r) => setTimeout(r, inJobWorker() ? GAP_IN_WORKER_MS : 0));

/** Longer than the busy handler's 25 ms naps. */
export const GAP_IN_WORKER_MS = 30;

/**
 * Deletes `table` rows matching `where` in batches of `batch`, awaiting between them: the write lock is released
 * after every batch, so other connections (and, inline, the loop) are never held for the whole cleanup.
 */
export async function deleteInBatches(
  db: DatabaseSync,
  table: string,
  where: string,
  params: (string | number)[],
  batch = CLEANUP_BATCH,
): Promise<number> {
  const stmt = db.prepare(
    `DELETE FROM ${table} WHERE rowid IN (SELECT rowid FROM ${table} WHERE ${where} LIMIT ${batch})`,
  );
  let total = 0;
  for (;;) {
    const n = Number(stmt.run(...params).changes);
    total += n;
    if (n < batch) return total;
    await yieldLoop();
  }
}

/** Deletes the `count` oldest rows by `order`, in batches, awaiting between them. */
export async function deleteOldestInBatches(
  db: DatabaseSync,
  table: string,
  order: string,
  count: number,
  batch = CLEANUP_BATCH,
): Promise<number> {
  const stmt = db.prepare(`DELETE FROM ${table} WHERE rowid IN (SELECT rowid FROM ${table} ORDER BY ${order} LIMIT ?)`);
  let total = 0;
  while (total < count) {
    const n = Number(stmt.run(Math.min(count - total, batch)).changes);
    if (!n) break;
    total += n;
    if (total < count) await yieldLoop();
  }
  return total;
}
