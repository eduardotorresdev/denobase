import * as migrations from "../../migrations/mod.ts";
import { openDb } from "../../core/db.ts";
import { type Command, type CommandContext, UsageError } from "../engine.ts";
import { dataDirOf, DEFAULT_DB } from "../data.ts";
import { Supervisor } from "../../queue/supervisor.ts";
import { ExecutorUnavailable, resolveLaunch } from "../../queue/launch.ts";
import { DEFAULT_CONCURRENCY, nodeId, stopGraceMs } from "../../queue/runtime.ts";
import { isOrphan, readMarker, removeMarker } from "../../queue/restore_marker.ts";
import type { ServeOptions } from "./serve.ts";

/** Exit code of a node that leaves because pb_data is being or was restored: the process manager restarts it. */
export const EXIT_RESTORE = 75;

/**
 * --queues normal,heavy picks what the node consumes (default both); --concurrency and --heavy-concurrency its slots.
 * Undefined when no flag says anything (the caller's default applies).
 */
export function queueFlags(c: CommandContext, none = false): { normal: number; heavy: number } | undefined {
  if (none) return { normal: 0, heavy: 0 };
  const q = c.str("queues");
  const n = c.str("concurrency"), h = c.str("heavy-concurrency");
  if (q === undefined && n === undefined && h === undefined) return undefined;
  const names = (q ?? "normal,heavy").split(",").map((s) => s.trim()).filter(Boolean);
  for (const name of names) {
    if (name !== "normal" && name !== "heavy") throw new UsageError(`--queues: unknown queue ${name}`);
  }
  const num = (v: string | undefined, d: number, flag: string) => {
    if (v === undefined) return d;
    const x = Number(v);
    if (!Number.isInteger(x) || x < 1) throw new UsageError(`--${flag}: a positive integer`);
    return x;
  };
  return {
    normal: names.includes("normal") ? num(n, DEFAULT_CONCURRENCY.normal, "concurrency") : 0,
    heavy: names.includes("heavy") ? num(h, DEFAULT_CONCURRENCY.heavy, "heavy-concurrency") : 0,
  };
}

/**
 * Before opening the dbs: wait while a restore marker beats (§16 N6). An orphan (its beat stopped) is cleared by a
 * serve once data.db passes quick_check, refused otherwise; a worker only waits for a serve to clear it.
 */
export async function awaitRestoreMarker(dataDir: string | null, dbPath: string, serve: boolean): Promise<void> {
  if (!dataDir) return;
  let warned = false;
  for (;;) {
    const m = readMarker(dataDir);
    if (!m) return;
    if (!isOrphan(m)) {
      if (!warned) console.log(`waiting: a restore (${m.key}) is running`);
      warned = true;
      await new Promise((r) => setTimeout(r, 1_000));
      continue;
    }
    if (!serve) {
      if (!warned) console.log("waiting: a stale restore marker is left; a serve clears it");
      warned = true;
      await new Promise((r) => setTimeout(r, 2_000));
      continue;
    }
    const db = openDb(dbPath);
    try {
      const r = db.prepare("PRAGMA quick_check").get() as { quick_check: string };
      if (r.quick_check !== "ok") {
        throw new Error(`a restore (${m.key}) stopped mid-way and data.db fails quick_check: ${r.quick_check}`);
      }
    } finally {
      db.close();
    }
    console.log(`restore marker of ${m.key} was orphaned (no beat since ${new Date(m.beat).toISOString()}); cleared`);
    removeMarker(dataDir);
    return;
  }
}

/**
 * `worker`: a background node (§12). It consumes the queues it is told to, in executors of the consumer's program,
 * and nothing else (no HTTP, no long services, no scheduler). N of them run on the same db file.
 */
export function workerCommand(opts: ServeOptions = {}): Command {
  return {
    name: "worker",
    usage: "[--db path] [--queues normal,heavy] [--concurrency N] [--heavy-concurrency N] [--id name]",
    description: "consume the job queue (normal and/or heavy) in executor subprocesses",
    run: async (c) => {
      const dbPath = c.str("db") ?? Deno.env.get("DB_PATH") ?? DEFAULT_DB;
      const own = dataDirOf(dbPath);
      const dir = own ?? ".";
      const concurrency = queueFlags(c) ?? DEFAULT_CONCURRENCY;
      await awaitRestoreMarker(own, dbPath, false);
      // Jobs never run against a schema behind the code: the serve migrates, workers wait for it.
      const check = openDb(dbPath);
      try {
        migrations.ensureMigrationsTable(check);
        const pending = migrations.status(check, await migrations.loadMigrations()).pending;
        if (pending.length) {
          console.error(`worker: ${pending.length} pending migration(s); run serve or migrate up first`);
          return 1;
        }
      } finally {
        check.close();
      }
      let launch;
      try {
        launch = resolveLaunch(opts.setup === undefined ? undefined : String(opts.setup), opts.executorFlags);
      } catch (e) {
        if (e instanceof ExecutorUnavailable) {
          console.error(`worker: ${e.message}`);
          return 1;
        }
        throw e;
      }
      const leave = Promise.withResolvers<number>();
      const sup = new Supervisor({
        kind: "worker",
        nodeId: c.str("id") ?? nodeId("worker"),
        dbPath,
        auxPath: `${dir}/auxiliary.db`,
        storageDir: `${dir}/storage`,
        dataDir: own ?? undefined,
        setup: opts.setup === undefined ? undefined : String(opts.setup),
        concurrency,
        launch,
        restoring: (why) => {
          console.log(`worker: ${why}; exiting`);
          leave.resolve(EXIT_RESTORE);
        },
      });
      // Before start: the supervisor claims while it boots, and a SIGTERM before the listener would kill the process
      // with the job still held (its lease lapses and the try is spent) instead of giving it back.
      for (const sig of ["SIGINT", "SIGTERM"] as const) {
        if (Deno.build.os !== "windows" || sig === "SIGINT") Deno.addSignalListener(sig, () => leave.resolve(0));
      }
      await sup.start();
      console.log(
        `worker: consuming ${Object.entries(concurrency).filter(([, n]) => n).map(([q, n]) => `${q}×${n}`).join(", ")}`,
      );
      const code = await leave.promise;
      await sup.stop(code === EXIT_RESTORE ? 5_000 : stopGraceMs(30_000));
      return code;
    },
  };
}
