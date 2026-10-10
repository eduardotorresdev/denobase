import type { DatabaseSync } from "node:sqlite";
import { FsStorage } from "../../files/storage.ts";
import { offRequestCheckpoints, openDb } from "../../core/db.ts";
import * as migrations from "../../migrations/mod.ts";
import { ensureAuthOriginsTable, ensureOtpTable } from "../../auth/mod.ts";
import { type Command } from "../engine.ts";
import { type App, createApp } from "../../app.ts";
import type { SettingsPatch } from "../../settings/mod.ts";
import type { Mailer } from "../../auth/mailer.ts";
import type { McpOptions } from "../../mcp/types.ts";
import { dataDirOf, DEFAULT_DB, openFileDb } from "../data.ts";

export interface ServeOptions {
  /** Runs on every serve after migrations, before listening: derived data the consumer keeps in sync. */
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
    usage: "[--port N] [--db path]",
    description: "apply pending migrations and serve HTTP",
    run: (c) => serve({ port: c.str("port") ? Number(c.str("port")) : undefined, dbPath: c.str("db"), ...opts }),
  };
}

/** Applies pending migrations first, like PB automigrate, so a dev db is never served behind the code. */
export async function serve(opts: { port?: number; dbPath?: string } & ServeOptions): Promise<void> {
  const dbPath = opts.dbPath ?? Deno.env.get("DB_PATH") ?? DEFAULT_DB;
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
    // The open db handles still point at the replaced files: exit non-zero so an on-failure restart
    // policy (Dokku's default) brings the process back on the restored data, PB's app.Restart().
    onRestored: () => {
      console.log("backup restored, restarting");
      Deno.exit(1);
    },
  });
  served.app = app;
  await opts.beforeServe?.(app);
  app.cron.start();
  const port = opts.port ?? Number(Deno.env.get("PORT") ?? 8090);
  const server = Deno.serve({ port }, app.fetch);
  // PB OnTerminate: on SIGINT/SIGTERM the app closes what it holds open (sockets, crons) before the process exits.
  const stop = async () => {
    await app.terminate();
    await server.shutdown();
  };
  for (const sig of ["SIGINT", "SIGTERM"] as const) {
    if (Deno.build.os !== "windows" || sig === "SIGINT") Deno.addSignalListener(sig, stop);
  }
  await server.finished;
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
