import type { Settings } from "../settings/mod.ts";
import type { Queue } from "../queue/queue.ts";
import type { Backups } from "./mod.ts";
import { backupName } from "./name.ts";

const AUTO = "__pbAutoBackup__";
const PREFIX = "@auto_pb_backup_";

/** The backup job: a heavy job, one at a time with the restore (dedupe key BACKUPS_KEY). */
export const BACKUP_JOB = "__denobaseBackup__";
/** The dedupe key a backup and a restore share: at most one of them pending or running, across every process. */
export const BACKUPS_KEY = "backups";
/** The row a restore holds the key with (no handler: nobody claims it). */
export const RESTORE_JOB = "__denobaseRestore__";

interface BackupPayload {
  key?: string;
  /** An automatic run: name and retention come from the settings at run time. */
  auto?: boolean;
}

/** Defines the backup job. */
export function backupJobs(queue: Queue, backups: Backups): void {
  queue.define<BackupPayload>(BACKUP_JOB, async (ctx) => {
    const s = ctx.settings;
    if (ctx.payload.auto) {
      await backups.create(backupName(s.meta.appName, PREFIX), { prefix: PREFIX, maxKeep: s.backups.cronMaxKeep }, ctx);
    } else await backups.create(ctx.payload.key!, undefined, ctx);
  }, { queue: "heavy", maxAttempts: 1, timeoutMs: 6 * 3_600_000 });
}

/**
 * PB registerAutobackupHooks: settings.backups.cron schedules "@auto_pb_backup_*" zips, pruned to cronMaxKeep.
 * Returns the reload to run whenever settings change, so a new schedule (or none) applies at once.
 */
export function autoBackups(queue: Queue, backups: Backups | null, settings: Settings): () => void {
  const load = () => {
    const expr = settings.backups.cron;
    if (!backups || !expr) return queue.unschedule(AUTO);
    queue.schedule(AUTO, expr, BACKUP_JOB, { auto: true }, { dedupe: BACKUPS_KEY });
  };
  load();
  return load;
}
