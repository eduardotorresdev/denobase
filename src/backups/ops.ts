import { ApiError, badRequest } from "../core/errors.ts";
import type { Queue } from "../queue/queue.ts";
import { WAL_SCHEDULES } from "../queue/scheduler.ts";
import type { JobRow } from "../queue/types.ts";
import { tx } from "../core/db.ts";
import { holdKey, releaseKey } from "../queue/table.ts";
import { isOrphan, readMarker } from "../queue/restore_marker.ts";
import type { Backups } from "./mod.ts";
import { BACKUP_JOB, BACKUPS_KEY, RESTORE_JOB } from "./auto.ts";

/**
 * What REST and the MCP do with backups, through the queue (§8): one backup or restore at a time across every
 * process, by the dedupe key they share.
 */

const BUSY = "Try again later - another backup/restore process has already been started";

/** A restore holds its key at most this long without its marker: the start of the run, before withMarker writes it. */
const MARKERLESS_MS = 30_000;

/**
 * Frees the `backups` key of a restore whose process died (B5): its row follows the `.restoring` marker's beat. No
 * marker (after the grace of its first steps), or an orphaned one: no restore is alive, the row is failed.
 */
export function freeOrphanRestore(queue: Queue, dataDir: string | undefined, now = Date.now()): void {
  if (!dataDir) return;
  const db = queue.deps.db;
  const r = db.prepare(`SELECT id, started FROM _jobs WHERE name = ? AND status = 'running'`).get(RESTORE_JOB) as
    | { id: string; started: number }
    | undefined;
  if (!r) return;
  const m = readMarker(dataDir);
  if (m ? !isOrphan(m, now) : now - r.started < MARKERLESS_MS) return;
  releaseKey(db, r.id, "The restore stopped: its process died.", now);
}

/** The backup or restore pending or running now, if any. */
export function activeBackup(queue: Queue): JobRow | null {
  freeOrphanRestore(queue, queue.deps.app().backups?.dataDir);
  const r = queue.deps.db.prepare(`SELECT id FROM _jobs WHERE dedupe = ? AND status IN ('pending', 'running')`)
    .get(BACKUPS_KEY) as { id: string } | undefined;
  return r ? queue.get(r.id) : null;
}

/** The zip a running backup writes or a restore reads: it cannot be deleted meanwhile. */
export function backupInUse(queue: Queue, key: string): boolean {
  const a = activeBackup(queue);
  if (!a) return false;
  const p = a.payload as { key?: string; args?: unknown[] } | null;
  return p?.key === key || p?.args?.[0] === key || (a.name === BACKUP_JOB && !!(p as { auto?: boolean })?.auto);
}

/**
 * PB's POST /api/backups: the request waits for the zip (204 when done). Fails fast when another backup or a restore
 * holds the key, or when no node consumes the heavy queue.
 */
export async function createBackup(queue: Queue, key: string, busyDot = false): Promise<void> {
  if (activeBackup(queue)) throw badRequest(busyDot ? `${BUSY}.` : BUSY);
  try {
    await queue.run(BACKUP_JOB, { key }, { dedupe: BACKUPS_KEY, exclusive: true });
  } catch (e) {
    if (e instanceof ApiError && e.code === "queue_dedupe_taken") throw badRequest(busyDot ? `${BUSY}.` : BUSY);
    console.error("Failed to create backup", key, e);
    throw badRequest("Failed to create backup.");
  }
}

/**
 * PB's restore: answers at once and restores in the background, here (a serve: the process it restarts). It holds
 * the `backups` key in _jobs for its whole run, so no backup starts meanwhile on any path, and it refuses while one
 * is pending or running (§18).
 */
export async function restoreBackup(queue: Queue, backups: Backups, key: string): Promise<void> {
  const db = queue.deps.db;
  freeOrphanRestore(queue, backups.dataDir);
  const held = await tx(
    db,
    () => holdKey(db, BACKUPS_KEY, RESTORE_JOB, queue.nodeId ?? `local:${Deno.pid}`, 6 * 3_600_000, Date.now()),
  );
  if (!held) throw badRequest(`${BUSY}.`);
  // The restore's owner is this node: its own supervisor must not read the marker as another node's restore (Q1).
  void backups.restore(key, queue.nodeId ?? `restore:${Deno.pid}`).then(
    // The swapped-in db has no such row: this only ends it when the restore stopped before the swap.
    () => tx(db, () => releaseKey(db, held.id, null, Date.now())).catch(() => {}),
    (e) => {
      console.error("Failed to restore backup", key, e);
      return tx(db, () => releaseKey(db, held.id, (e as Error).message, Date.now())).catch(() => {});
    },
  );
}

/** /api/crons and the MCP's crons tools: the schedules, without the WAL checkpoints (not jobs, §5). */
export function cronList(queue: Queue): { id: string; expression: string }[] {
  return queue.schedules().filter((s) => !WAL_SCHEDULES.includes(s.id)).map((s) => ({
    id: s.id,
    expression: s.expression,
  }));
}
