import type { DatabaseSync } from "node:sqlite";
import { FsStorage } from "../../files/storage.ts";
import { offRequestCheckpoints, openDb } from "../../core/db.ts";
import * as migrations from "../../migrations/mod.ts";
import { ensureAuthOriginsTable, ensureOtpTable } from "../../auth/mod.ts";
import { type Command } from "../engine.ts";
import { type App, createApp, loadSetup } from "../../app.ts";
import { startServeQueue } from "../../queue/runtime.ts";
import { freeOrphanRestore } from "../../backups/ops.ts";
import { awaitRestoreMarker, queueFlags } from "./worker.ts";
import type { SettingsPatch } from "../../settings/mod.ts";
import type { Mailer } from "../../auth/mailer.ts";
import type { McpOptions } from "../../mcp/types.ts";
import { dataDirOf, DEFAULT_DB, openFileDb } from "../data.ts";

export interface ServeOptions {
  /**
   * The setup module (its default export, defineSetup): jobs, schedules and hooks, run in every process (serve,
   * worker executors, mcp). A URL, since executors import it themselves.
   */
  setup?: URL | string;
  /** Flags of the executor subprocesses; default -A (Deno does not expose the parent's). */
  executorFlags?: string[];
  /** Runs on every serve after migrations and the setup, before listening: long services, derived data. */
  beforeServe?: (app: App) => unknown;
  /** PB settings the served app starts with (e.g. batch enabled). */
  settings?: SettingsPatch;
  /** The consumer's mailer; gets the app lazily so it can read live settings (sender). Defaults to mailerFromEnv(). */
  mailer?: (app: () => App) => Mailer;
  /** The native MCP's options (e.g. which auth collections may authorize an OAuth client). */
  mcp?: McpOptions;
}

/** `serve [--port --db]`; the consumer registers its own instance to plug beforeServe. */
export function serveCommand(opts: ServeOptions = {}): Command {
  return {
    name: "serve",
    usage: "[--port N] [--db path] [--no-worker] [--queues normal,heavy] [--concurrency N] [--heavy-concurrency N]",
    description: "apply pending migrations and serve HTTP (with an embedded queue worker)",
    run: (c) =>
      serve({
        port: c.str("port") ? Number(c.str("port")) : undefined,
        dbPath: c.str("db"),
        concurrency: queueFlags(c, c.flags["no-worker"] === true),
        ...opts,
      }),
  };
}

/** Applies pending migrations first, like PB automigrate, so a dev db is never served behind the code. */
export async function serve(
  opts: { port?: number; dbPath?: string; concurrency?: { normal: number; heavy: number } } & ServeOptions,
): Promise<void> {
  const dbPath = opts.dbPath ?? Deno.env.get("DB_PATH") ?? DEFAULT_DB;
  // A restore in progress (another serve swapping pb_data): open nothing until it ends; an orphan is cleared.
  await awaitRestoreMarker(dataDirOf(dbPath), dbPath, true);
  const db = openFileDb(dbPath);
  await migrations.up(db, await migrations.loadMigrations());
  ensureOtpTable(db);
  offRequestCheckpoints(db);
  ensureAuthOriginsTable(db);
  analisarSeSemEstatisticas(db);
  // The composition root: the one App of this process, handed to the consumer before it serves.
  // PB keeps uploads next to the db: pb_data/storage.
  const own = dataDirOf(dbPath);
  const dataDir = own ?? ".";
  const served: { app?: App } = {};
  const appRef = (): App => {
    if (!served.app) throw new Error("app not created yet");
    return served.app;
  };
  const app = createApp({
    db,
    mailer: opts.mailer?.(appRef),
    settings: opts.settings,
    mcp: opts.mcp,
    storage: new FsStorage(`${dataDir}/storage`),
    auxDb: offRequestCheckpoints(openDb(`${dataDir}/auxiliary.db`)),
    // Backups zip the whole data dir, so only a real pb_data-style dir enables them (never the cwd).
    dataDir: own ?? undefined,
    adminUiDir: Deno.env.get("DENOBASE_UI") === "off" ? false : undefined,
    setup: opts.setup,
    role: "serve",
    // The open db handles still point at the replaced files: exit non-zero so an on-failure restart
    // policy (Dokku's default) brings the process back on the restored data, PB's app.Restart().
    onRestored: () => {
      console.log("backup restored, restarting");
      Deno.exit(1);
    },
  });
  served.app = app;
  await loadSetup(app);
  await opts.beforeServe?.(app);
  const port = opts.port ?? Number(Deno.env.get("PORT") ?? 8090);
  const server = Deno.serve({ port }, app.fetch);
  let leaving = false;
  // PB OnTerminate: on SIGINT/SIGTERM the app closes what it holds open (sockets, the queue) before the process exits.
  // Listening before the queue starts: its supervisor claims while it boots, and a SIGTERM then must still give the
  // jobs back (it waits for the queue to be up, so the queue's own stop is registered) instead of killing the process.
  const queueUp = Promise.withResolvers<void>();
  const stop = async () => {
    await queueUp.promise;
    await app.terminate();
    await server.shutdown();
  };
  for (const sig of ["SIGINT", "SIGTERM"] as const) {
    if (Deno.build.os !== "windows" || sig === "SIGINT") Deno.addSignalListener(sig, stop);
  }
  // The queue's supervisor thread, always (--no-worker only leaves normal/heavy to `worker` processes).
  // A restore that died with its serve left its row holding the backups key: freed at boot (B5).
  freeOrphanRestore(app.queue, app.backups?.dataDir);
  const queue = await startServeQueue(app, {
    concurrency: opts.concurrency ?? workerEnvConcurrency(),
    storageDir: `${dataDir}/storage`,
    dataDir: own ?? undefined,
    executorFlags: opts.executorFlags,
    // Another node restores pb_data, or it was swapped: stop serving and leave for the restarted process (75).
    onRestoring: (why) => {
      if (leaving) return;
      leaving = true;
      // 75 whatever path ends the process: the server's shutdown also returns from serve (a 0 the CLI would exit
      // with), and an on-failure restart policy never brings a 0 back (Q2).
      Deno.exitCode = 75;
      console.log(`queue: ${why}; exiting to restart on the restored data`);
      void (async () => {
        await server.shutdown().catch(() => {});
        await app.terminate().catch(() => {});
        Deno.exit(75);
      })();
    },
  });
  app.onTerminate(() => queue.stop());
  // Calls from workers and executors to this serve's services arrive on a socket in pb_data (§18).
  if (own) app.services.listen(own);
  queueUp.resolve();
  await server.finished;
  // Leaving for a restore: the exit (75) is on its way; returning would let the caller exit 0 first.
  if (leaving) await new Promise(() => {});
}

/** DENOBASE_WORKER=0 (or "false") turns the embedded worker off, like --no-worker. */
function workerEnvConcurrency(): { normal: number; heavy: number } | undefined {
  const v = Deno.env.get("DENOBASE_WORKER")?.trim().toLowerCase();
  return v === "0" || v === "false" ? { normal: 0, heavy: 0 } : undefined;
}

/**
 * A db without sqlite_stat1 (one copied table by table, as the PB to denobase cutover did) leaves the planner
 * guessing, and it guessed low-selectivity indexes (stage_transitions.to_stage) on hot paths. PB's db carried the
 * stats; ANALYZE once restores them, and the dbOptimize cron keeps them fresh from there.
 */
export function analisarSeSemEstatisticas(db: DatabaseSync): boolean {
  const tem = db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'sqlite_stat1'").get();
  if (tem && db.prepare("SELECT 1 FROM sqlite_stat1 LIMIT 1").get()) return false;
  db.exec("ANALYZE");
  return true;
}
