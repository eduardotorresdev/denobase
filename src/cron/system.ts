import type { DatabaseSync } from "node:sqlite";
import type { Settings } from "../settings/mod.ts";
import type { Logs } from "../logs/mod.ts";
import { dbPath } from "../workers/mod.ts";
import type { Cron } from "./cron.ts";
import { maintain, type MaintenanceInput, type MaintenanceJob } from "./tasks/maintenance.ts";

const JOBS: [string, string, MaintenanceJob][] = [
  ["__pbLogsCleanup__", "0 */6 * * *", "logsCleanup"],
  ["__denobaseTracesCleanup__", "0 * * * *", "tracesCleanup"],
  ["__pbDBOptimize__", "0 0 * * *", "dbOptimize"],
  ["__pbOTPCleanup__", "0 * * * *", "otpCleanup"],
  ["__denobaseOAuthCleanup__", "30 * * * *", "oauthCleanup"],
  // The serving thread never auto-checkpoints (offRequestCheckpoints): the worker keeps the WAL bounded, and resets
  // a large one off-hours (05:50 UTC, 02:50 in the factory zone, apart from the reconciliations).
  ["__denobaseWalCheckpoint__", "* * * * *", "walCheckpoint"],
  ["__denobaseWalTruncate__", "50 5 * * *", "walTruncate"],
];

/**
 * PB's own maintenance jobs: old logs, db optimize, expired OTPs (and, ours, expired
 * OAuth rows). On file dbs each run
 * is a job in the job worker (PB runs them in the background); in-memory dbs (tests) can only be reached here, so they
 * run inline.
 */
export function systemJobs(cron: Cron, db: DatabaseSync, logs: Logs, settings: Settings): void {
  const paths = { dbPath: dbPath(db), auxPath: dbPath(logs.db) };
  for (const [id, expr, job] of JOBS) {
    const input = (): MaintenanceInput => ({
      job,
      dbPath: paths.dbPath ?? "",
      auxPath: paths.auxPath ?? "",
      maxDays: job === "tracesCleanup" ? settings.traces.maxDays : settings.logs.maxDays,
    });
    if (paths.dbPath && paths.auxPath) {
      cron.addJob(id, expr, { module: new URL("./tasks/maintenance.ts", import.meta.url) }, input);
    } else cron.add(id, expr, () => maintain(input(), () => db, () => logs.db));
  }
}
