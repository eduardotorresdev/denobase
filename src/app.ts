import type { DatabaseSync } from "node:sqlite";
import { ensureMathFunctions, openDb } from "./core/db.ts";
import { Logs } from "./logs/mod.ts";
import { Spans } from "./telemetry/store.ts";
import { Tracer } from "./telemetry/tracer.ts";
import type { Attrs } from "./telemetry/span.ts";
import { Cron, systemJobs } from "./cron/mod.ts";
import { autoBackups, Backups } from "./backups/mod.ts";
import type { Hono } from "hono";
import { type Mailer, mailerFromEnv } from "./auth/mailer.ts";
import type { CollectionConfig } from "./core/types.ts";
import { collections as registry } from "./core/registry.ts";
import { type AppEnv, createHttp, type Ctx } from "./http/app.ts";
import { defaultServices, type Services } from "./http/services.ts";
import { Realtime } from "./realtime/mod.ts";
import { createStore, type Store } from "./store/mod.ts";
import { type BlobStore, MemoryStorage } from "./files/storage.ts";
import { CurrentStorage } from "./files/current.ts";
import { loadSettings, resolveSettings, type Settings, type SettingsPatch } from "./settings/mod.ts";
import { bundledUi, diskUi } from "./http/ui_source.ts";
import { McpHost } from "./mcp/host.ts";
import { JobRunner } from "./jobs/runner.ts";
import { onExternalCommit, syncExternalCommits } from "./core/coherence.ts";
import { shareRecordEvents } from "./engine/bus.ts";
import { dbPath, runTask } from "./workers/mod.ts";
import type { Mcp, McpOptions } from "./mcp/types.ts";

export interface AppOptions {
  db: DatabaseSync;
  /** Defaults to mailerFromEnv(). */
  mailer?: Mailer;
  /** Defaults to every registered collection. */
  collections?: CollectionConfig[];
  /** Overrides for route tests; production uses the real engine and auth. */
  services?: Partial<Services>;
  /** Where record files live; defaults to memory (serve passes pb_data/storage on disk). */
  storage?: BlobStore;
  /** PB's auxiliary db (logs); defaults to memory (serve passes pb_data/auxiliary.db). */
  auxDb?: DatabaseSync;
  /** pb_data on disk: enables backups (zips of the dbs and storage/ kept in <dataDir>/backups). */
  dataDir?: string;
  /** After a restore swapped pb_data; serve exits so the supervisor restarts on the restored files. */
  onRestored?: () => void;
  /** Admin UI served at /_/: defaults to the bundled denobase/ui; false turns it off. */
  adminUiDir?: string | false;
  /** PB settings; anything left out keeps PB's default (batch is off unless enabled). */
  settings?: SettingsPatch;
  /** The native MCP server (POST /api/mcp, `mcp` CLI command); on by default. */
  mcp?: McpOptions;
}

/**
 * The one instance a process runs (PB's app, shuri's create()): it owns the db and builds the store, the
 * realtime broker and the HTTP handler exactly once. Everything else receives it, or the part it needs:
 * hooks and access fns get the store as req.store, the CLI's beforeServe gets the app.
 */
export interface App {
  readonly db: DatabaseSync;
  readonly store: Store;
  readonly mailer: Mailer;
  readonly realtime: Realtime;
  readonly settings: Settings;
  readonly logs: Logs;
  /** Native tracing (settings.traces): spans, context, traced fetch; flushed on terminate(). */
  readonly tracer: Tracer;
  /** The stored traces (_spans in the auxiliary db): list, view, stats, truncate. */
  readonly traces: Spans;
  /** Jobs ticking once serve starts it (PB app.Cron()); consumers add theirs in beforeServe, with addJob. */
  readonly cron: Cron;
  /**
   * The job worker every cron job and backup runs in: consumers point it at their bootstrap (use) and declare the
   * main-thread operations jobs call (operation, onMain). The main thread applies every write the jobs send.
   */
  readonly jobs: JobRunner;
  readonly backups: Backups | null;
  /** The Hono app, for mounting next to other routes and for app.http.request in tests. */
  readonly http: Hono<AppEnv>;
  /** Web-standard handler: Deno.serve(app.fetch). */
  readonly fetch: Hono<AppEnv>["fetch"];
  /** MCP extension API: tools, resources and prompts the consumer adds next to the built-ins. */
  readonly mcp: Mcp;
  /** Registers fn to run on terminate() (PB OnTerminate): close sockets, flush queues. */
  onTerminate(fn: () => unknown): void;
  /** Runs every onTerminate fn once, in reverse registration order; a failing fn does not stop the others. */
  terminate(): Promise<void>;
}

export function createApp(opts: AppOptions): App {
  const { db } = opts;
  // A db the caller opened itself (not through openDb) still needs the SQL functions filters compile to (fold).
  ensureMathFunctions(db);
  // The store keeps one storage for its life; settings.s3 decides what is behind it (see the swap below).
  const files = new CurrentStorage(opts.storage ?? new MemoryStorage());
  const store = createStore(db, files);
  const mailer = opts.mailer ?? mailerFromEnv();
  const s: Services = { ...defaultServices, ...opts.services };
  const realtime = new Realtime(store, s);
  // PB keeps settings in the db: what was saved through the API wins over the code defaults.
  const settings = resolveSettings(opts.settings, loadSettings(db));
  const shared = dbPath(db);
  // Other threads on the same file (job worker, HTTP isolates): their record writes reach this thread's realtime and
  // remote listeners, and a settings change saved by one reaches the others.
  const stopSharing = shared ? shareRecordEvents(db, shared) : () => {};
  files.use(settings.s3);
  // PB builds its filesystem from settings.s3 on each use: a saved change applies to the next file operation.
  const onSettingsChange: ((s: Settings) => void)[] = [(s) => files.use(s.s3)];
  let settingsStamp = settingsUpdated(db);
  // The baseline: what was committed before this app existed is already in what it loaded.
  syncExternalCommits(db);
  const stopSettingsSync = onExternalCommit((changed) => {
    if (changed !== db) return;
    const stamp = settingsUpdated(db);
    if (stamp === settingsStamp) return;
    settingsStamp = stamp;
    Object.assign(settings, resolveSettings(opts.settings, loadSettings(db)));
    for (const fn of onSettingsChange) fn(settings);
  });
  const logs = new Logs(opts.auxDb ?? openDb());
  const traces = new Spans(logs.db);
  const tracer = new Tracer(traces, () => settings.traces);
  const jobs = new JobRunner({ app: () => app, db, auxDb: logs.db, store, tracer });
  const backups = opts.dataDir
    ? new Backups(
      opts.dataDir,
      db,
      logs.db,
      opts.onRestored ?? (() => {}),
      // With the jobs inline (rollback flag) a backup still never runs on the main thread: a worker of its own.
      (module, input) => jobs.inWorker ? jobs.run({ module }, input) : runTask(module, input),
    )
    : null;
  const cron = new Cron(() => settings.meta.timezone, tracer);
  cron.useRunner(jobs);
  systemJobs(cron, db, logs, settings);
  const reloadAutoBackups = autoBackups(cron, backups, settings);
  onSettingsChange.push(reloadAutoBackups);
  const mcp = new McpHost(opts.mcp);
  mcp.useTracer({
    span: (name, attrs, fn) => tracer.span(name, attrs as Attrs, () => fn()),
    query: ({ limit, filter }) => Promise.resolve(traces.listTraces({ filter, perPage: limit })),
  });
  const ctx: Ctx = {
    db,
    store,
    mailer,
    collections: opts.collections ?? registry,
    s,
    realtime,
    settings,
    onSettingsChange,
    logs,
    tracer,
    traces,
    cron,
    backups,
    adminUi: opts.adminUiDir === false
      ? undefined
      : typeof opts.adminUiDir === "string"
      ? diskUi(opts.adminUiDir)
      : bundledUi(),
    mcp,
  };
  const http = createHttp(ctx);
  const onTerminate: (() => unknown)[] = [];
  let terminated: Promise<void> | undefined;
  const terminate = () =>
    terminated ??= (async () => {
      cron.stop();
      await mcp.close();
      jobs.terminate();
      stopSharing();
      stopSettingsSync();
      for (const fn of onTerminate.toReversed()) {
        try {
          await fn();
        } catch (err) {
          console.error("onTerminate:", err);
        }
      }
      // Roots still open (requests and jobs in flight) get DRAIN_MS to finish; what stays open after that is lost.
      await tracer.drain();
    })();
  const app: App = {
    db,
    store,
    mailer,
    realtime,
    settings,
    logs,
    tracer,
    traces,
    cron,
    jobs,
    backups,
    http,
    fetch: http.fetch,
    mcp,
    onTerminate: (fn) => void onTerminate.push(fn),
    terminate,
  };
  mcp.attach(app, ctx);
  return app;
}

/** When the saved settings last changed ('' before the first save): a cheap read to tell a settings commit apart. */
function settingsUpdated(db: DatabaseSync): string {
  try {
    const row = db.prepare(`SELECT updated FROM _params WHERE id = 'settings'`).get() as
      | { updated: string }
      | undefined;
    return row?.updated ?? "";
  } catch {
    return "";
  }
}
