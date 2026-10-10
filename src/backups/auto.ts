import type { Cron } from "../cron/mod.ts";
import type { Settings } from "../settings/mod.ts";
import type { Backups } from "./mod.ts";
import { backupName } from "./name.ts";

const JOB = "__pbAutoBackup__";
const PREFIX = "@auto_pb_backup_";

/**
 * PB registerAutobackupHooks: settings.backups.cron schedules "@auto_pb_backup_*" zips, pruned to cronMaxKeep.
 * Returns the reload to run whenever settings change, so a new schedule (or none) applies at once.
 */
export function autoBackups(cron: Cron, backups: Backups | null, settings: Settings): () => void {
  const load = () => {
    const expr = settings.backups.cron;
    if (!backups || !expr) return cron.remove(JOB);
    // Snapshot, zip and retention all run in the job worker (Backups.create); main only dispatches.
    cron.add(JOB, expr, () =>
      backups.create(backupName(settings.meta.appName, PREFIX), {
        prefix: PREFIX,
        maxKeep: settings.backups.cronMaxKeep,
      }));
  };
  load();
  return load;
}
