import { FsStorage } from "../../files/storage.ts";
import { openDb } from "../../core/db.ts";
import { type Command, type CommandContext, UsageError } from "../engine.ts";
import { createApp } from "../../app.ts";
import { dataDirOf, DEFAULT_DB, openFileDb } from "../data.ts";
import { CurrentStorage } from "../../files/current.ts";
import {
  type MigrationSource,
  type MigrationState,
  planMigration,
  runMigration,
  sourceStorage,
} from "../../files/migrate.ts";
import type { S3Config } from "../../settings/model.ts";
import type { ServeOptions } from "./serve.ts";

const USAGE = "migrate --from local|s3 --to local|s3 [--delete-source] [--dry-run] [--db path] [--from-s3-* ...]";

/** --from-s3-<field> wins over DENOBASE_FROM_S3_<FIELD>: the old bucket is never in settings any more. */
export function fromS3(c: Pick<CommandContext, "str" | "flags">, env = Deno.env.toObject()): S3Config {
  const get = (flag: string, name: string) => c.str(`from-s3-${flag}`) ?? env[`DENOBASE_FROM_S3_${name}`] ?? "";
  const cfg: S3Config = {
    enabled: true,
    bucket: get("bucket", "BUCKET"),
    region: get("region", "REGION"),
    endpoint: get("endpoint", "ENDPOINT"),
    accessKey: get("access-key", "ACCESS_KEY"),
    secret: get("secret", "SECRET"),
    forcePathStyle: c.flags["from-s3-force-path-style"] === true ||
      /^(1|true)$/i.test(c.str("from-s3-force-path-style") ?? env.DENOBASE_FROM_S3_FORCE_PATH_STYLE ?? ""),
  };
  const missing = (["bucket", "region", "endpoint", "accessKey", "secret"] as const).filter((k) => !cfg[k]);
  if (missing.length) {
    throw new UsageError(`--from s3 needs ${missing.join(", ")} (--from-s3-* flags or DENOBASE_FROM_S3_* env)`);
  }
  return cfg;
}

function line(s: MigrationState): string {
  const err = s.error ? ` - ${s.error}` : "";
  return `[${s.status}] ${s.processed}/${s.total} (copied ${s.copied}, skipped ${s.skipped}, failed ${s.failed}, ` +
    `${s.bytes} bytes)${err}`;
}

/**
 * `storage migrate`: moves record files from the old storage to the one settings.s3 names now, in this process. --to
 * only confirms the operator's intent: the destination is always the current storage, so a mismatch aborts instead of
 * writing files where the app will not read them. A job already running (from the UI, or a CLI that died) is
 * followed, and taken over if its owner stopped renewing the lease.
 */
export function storageCommand(opts: ServeOptions = {}): Command {
  return {
    name: "storage",
    usage: USAGE,
    description: "migrate record files between local storage and S3",
    run: async (c) => {
      if (c.args[0] !== "migrate") throw new UsageError();
      const from = c.str("from"), to = c.str("to");
      if ((from !== "local" && from !== "s3") || (to !== "local" && to !== "s3")) {
        throw new UsageError("--from and --to must be local or s3");
      }
      const dbPath = c.str("db") ?? Deno.env.get("DB_PATH") ?? DEFAULT_DB;
      const dir = dataDirOf(dbPath) ?? ".";
      const app = createApp({
        db: openFileDb(dbPath),
        settings: opts.settings,
        storage: new FsStorage(`${dir}/storage`),
        auxDb: openDb(`${dir}/auxiliary.db`),
        adminUiDir: false,
      });
      try {
        return await migrate(app, c, from, to);
      } finally {
        await app.terminate();
      }
    },
  };
}

async function migrate(
  app: ReturnType<typeof createApp>,
  c: CommandContext,
  from: "local" | "s3",
  to: "local" | "s3",
): Promise<number> {
  const current = app.settings.s3.enabled ? "s3" : "local";
  if (to !== current) {
    console.error(
      `error: --to ${to} is not the current files storage (${current}). Save the new storage in the settings ` +
        `first; files are always migrated to the storage the app uses.`,
    );
    return 1;
  }
  const storage = app.store.storage as CurrentStorage;
  const mig = app.filesMigration;
  const run = (id: string) =>
    runMigration(id, {
      aux: app.logs.db,
      data: app.db,
      storage,
      s3: app.settings.s3,
      progress: (s) => console.log(line(s)),
    });

  const active = mig.active();
  if (active) {
    console.log(`a files migration is already running (${active.from} -> ${active.to}): following it`);
    // Run it here when its owner is gone; else watch the row until it ends.
    while (!(await run(active.id))) {
      const s = mig.get(active.id)!;
      if (s.status !== "running") break;
      console.log(line(s));
      await new Promise((r) => setTimeout(r, 1000));
    }
    const end = mig.get(active.id)!;
    console.log(line(end));
    return end.status === "done" ? 0 : 1;
  }

  const source: MigrationSource = from === "s3" ? { kind: "s3", s3: fromS3(c) } : { kind: "local" };
  if (c.flags["dry-run"] === true) {
    const plan = await planMigration(sourceStorage(source, storage), storage.target);
    console.log(
      `dry run: ${plan.total} file(s) at the source, ${plan.toCopy} to copy (${plan.bytes} bytes), ` +
        `${plan.same} already there`,
    );
    return 0;
  }
  const job = await mig.create({ from: source, deleteSource: c.flags["delete-source"] === true });
  console.log(`files migration ${job.id}: ${job.from} -> ${job.to}`);
  await run(job.id);
  const end = mig.get(job.id)!;
  console.log(line(end));
  for (const f of end.failures) console.error(`  ${f.key}: ${f.error}`);
  return end.status === "done" ? 0 : 1;
}
