/** The files migration as a heavy job of the queue: one run moves (or continues moving) every record file. */
import type { Queue } from "../../queue/queue.ts";
import { CurrentStorage } from "../current.ts";
import { FILES_MIGRATION_TOPIC, type MigrationState, runMigration } from "../migrate.ts";

export const FILES_MIGRATION_JOB = "__denobaseFilesMigration__";

export function filesMigrationJob(queue: Queue): void {
  queue.define<{ id: string }>(FILES_MIGRATION_JOB, async (ctx) => {
    const storage = ctx.store.storage;
    if (!(storage instanceof CurrentStorage)) throw new Error("files migration: the store has no switchable storage");
    return await ctx.span("files.migrate", { "files.migration": ctx.payload.id }, () =>
      runMigration(ctx.payload.id, {
        aux: ctx.internalDb("aux"),
        data: ctx.internalDb("data"),
        storage,
        s3: () => ctx.settings.s3,
        signal: ctx.signal,
        // In an executor the realtime has no clients: the publish goes through the outbox to the serves.
        progress: (s: MigrationState) => ctx.app.realtime.publish(FILES_MIGRATION_TOPIC, s, { access: "superusers" }),
      }));
  }, { queue: "heavy", maxAttempts: 3, backoffMs: 30_000 });
}
