import type { DatabaseSync } from "node:sqlite";
import { Logs } from "../../logs/mod.ts";
import { MAX_SPAN_ROWS, Spans } from "../../telemetry/store.ts";
import { RequestStats } from "../../telemetry/requests.ts";
import { deleteExpiredOtps } from "../../auth/otp.ts";
import { cleanupOAuth } from "../../oauth/tables.ts";

export type MaintenanceJob =
  | "logsCleanup"
  | "tracesCleanup"
  | "dbOptimize"
  | "otpCleanup"
  | "oauthCleanup"
  | "walCheckpoint"
  | "walTruncate";

/** A WAL above this is reset by the off-hours TRUNCATE (it otherwise keeps its high-water size on disk). */
export const WAL_TRUNCATE_BYTES = 16 * 1024 * 1024;

function walBytes(path: string): number {
  try {
    return path ? Deno.statSync(`${path}-wal`).size : 0;
  } catch {
    return 0;
  }
}

export interface MaintenanceInput {
  job: MaintenanceJob;
  dbPath: string;
  auxPath: string;
  /** logsCleanup/tracesCleanup: entries older than this many days go. */
  maxDays?: number;
}

/** PB's maintenance work, on the connections of the process running the job (an executor, or inline). */
export async function maintain(
  input: MaintenanceInput,
  db: () => DatabaseSync,
  aux: () => DatabaseSync,
): Promise<void> {
  switch (input.job) {
    case "logsCleanup":
      if (input.maxDays && input.maxDays > 0) {
        await new Logs(aux()).deleteOlderThan(new Date(Date.now() - input.maxDays * 86_400_000));
      }
      return;
    case "tracesCleanup":
      {
        const spans = new Spans(aux());
        if (input.maxDays && input.maxDays > 0) {
          await spans.deleteOlderThan(new Date(Date.now() - input.maxDays * 86_400_000));
        }
        await spans.trimTo(MAX_SPAN_ROWS);
        // The home's request counts compare a day with the one before; a week covers that with room to spare.
        new RequestStats(aux()).deleteOlderThan(new Date(Date.now() - 7 * 86_400_000));
      }
      return;
    case "dbOptimize":
      // analysis_limit bounds the ANALYZE optimize may run to a sample: unbounded, it holds the write lock for
      // seconds on a big table, and every other thread's writer waits on it.
      for (const c of [db(), aux()]) c.exec("PRAGMA analysis_limit = 400; PRAGMA optimize;");
      return;
    case "otpCleanup":
      await deleteExpiredOtps(db());
      return;
    case "oauthCleanup":
      cleanupOAuth(db());
      return;
    case "walCheckpoint":
      // PASSIVE never waits on a reader or writer: it copies what it can, and the next write restarts the WAL from
      // the top once every frame is in the db, so the file stops growing.
      for (const c of [db(), aux()]) c.exec("PRAGMA wal_checkpoint(PASSIVE);");
      return;
    case "walTruncate":
      // TRUNCATE waits for readers and writers (busy_timeout), so it only runs off-hours, and only on a large WAL.
      for (const [c, path] of [[db, input.dbPath], [aux, input.auxPath]] as const) {
        if (walBytes(path) > WAL_TRUNCATE_BYTES) c().exec("PRAGMA wal_checkpoint(TRUNCATE);");
      }
      return;
  }
}
