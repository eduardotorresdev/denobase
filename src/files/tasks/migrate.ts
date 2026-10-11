/** Job task: one files migration run, in the job worker (or inline where the db has no file). */
import type { JobContext } from "../../jobs/context.ts";
import { CurrentStorage } from "../current.ts";
import { type MigrationState, runMigration } from "../migrate.ts";

/** The main-thread operation that publishes progress on its realtime (the worker has no clients). */
export const PROGRESS_OP = "denobase.filesMigrationProgress";

export default async function migrateFiles(input: { id: string }, ctx: JobContext): Promise<boolean> {
  const storage = ctx.store.storage;
  if (!(storage instanceof CurrentStorage)) throw new Error("files migration: the store has no switchable storage");
  return await ctx.span("files.migrate", { "files.migration": input.id }, () =>
    runMigration(input.id, {
      aux: ctx.internalDb("aux"),
      data: ctx.internalDb("data"),
      storage,
      s3: ctx.settings.s3,
      progress: (s: MigrationState) => ctx.call(PROGRESS_OP, s),
    }));
}
