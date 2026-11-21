import { SCHEDULER_SERVICE } from "./scheduler.ts";
import { hostname } from "node:os";
import { dbPath } from "../workers/mod.ts";
import type { App } from "../app.ts";
import { ExecutorUnavailable, resolveLaunch } from "./launch.ts";
import type { SupervisorState } from "./supervisor.ts";
import type { FromSupervisorThread, ToSupervisorThread } from "./supervisor_thread.ts";

export interface ServeQueueOptions {
  /** Slots per queue of the embedded worker; 0 for none (`serve --no-worker` sets both). */
  concurrency?: { normal?: number; heavy?: number };
  /** pb_data/storage, for the executors' local files. */
  storageDir?: string;
  dataDir?: string;
  /** Flags of the executors (createCli's executorFlags). */
  executorFlags?: string[];
  /** The data dir is being restored by another node, or was swapped: the serve must go (exit 75). */
  onRestoring?: (why: string) => void;
}

export const DEFAULT_CONCURRENCY = { normal: 4, heavy: 1 };

/**
 * How long a clean stop waits for the running jobs before giving them back (DENOBASE_STOP_GRACE_MS): keep it under the
 * orchestrator's own stop timeout, or the process is killed with the jobs held (their tries spent).
 */
export function stopGraceMs(def: number): number {
  const v = Number(Deno.env.get("DENOBASE_STOP_GRACE_MS"));
  return Number.isFinite(v) && v >= 0 && Deno.env.get("DENOBASE_STOP_GRACE_MS") !== undefined ? v : def;
}

export function nodeId(kind: string): string {
  return `${kind}:${hostname()}:${Deno.pid}:${crypto.randomUUID().slice(0, 8)}`;
}

/**
 * The serve's queue runtime (§16 N2): the supervisor thread, always (also with --no-worker, which only leaves
 * normal/heavy to other nodes), kept current with the schedules and timezone of this app; the main thread publishes the
 * outbox's topics.
 */
export async function startServeQueue(app: App, o: ServeQueueOptions = {}): Promise<{ stop(): Promise<void> }> {
  const data = dbPath(app.db), aux = dbPath(app.logs.db);
  if (!data || !aux) throw new Error("the queue runtime needs file dbs");
  const concurrency = {
    normal: o.concurrency?.normal ?? DEFAULT_CONCURRENCY.normal,
    heavy: o.concurrency?.heavy ?? DEFAULT_CONCURRENCY.heavy,
  };
  let launch: ReturnType<typeof resolveLaunch> | { error: string };
  try {
    launch = resolveLaunch(app.setup, o.executorFlags);
  } catch (e) {
    if (!(e instanceof ExecutorUnavailable)) throw e;
    launch = { error: e.message };
  }
  const id = nodeId("serve");
  app.queue.nodeId = id;
  // The scheduler is a long service of this serve (§18), a client of the queue: while it runs, the supervisor
  // thread's minute tick enqueues the due schedules. Every serve runs one (lastSlot keeps a slot enqueued once).
  let scheduling = false;
  let schedulerCrashed: ((why: string) => void) | undefined;
  const worker = new Worker(new URL("./supervisor_thread.ts", import.meta.url), { type: "module" });
  const post = (m: ToSupervisorThread) => worker.postMessage(m);
  const state = (): SupervisorState => ({
    scheduling,
    schedules: app.queue.schedules(),
    timezone: app.settings.meta.timezone || "UTC",
    defs: Object.fromEntries(
      app.queue.definitions().map((d) => [d.name, {
        queue: d.opts.queue,
        maxAttempts: d.opts.maxAttempts,
        backoffMs: d.opts.backoffMs,
        leaseMs: d.opts.leaseMs,
        timeoutMs: d.opts.timeoutMs,
      }]),
    ),
  });
  let started!: () => void;
  const ready = new Promise<void>((r) => (started = r));
  let stopped!: () => void;
  const done = new Promise<void>((r) => (stopped = r));
  worker.onmessage = (e: MessageEvent<FromSupervisorThread>) => {
    const m = e.data;
    if (m.t === "started") started();
    else if (m.t === "stopped") stopped();
    else if (m.t === "restoring") o.onRestoring?.(m.why);
    else if (m.t === "schedulerError") schedulerCrashed?.(m.error);
    else if (m.t === "events") {
      for (const ev of m.events) {
        if (ev.kind !== "topic") continue;
        app.realtime.publish(ev.topic, ev.data, { access: ev.access as "authenticated" }).catch((err) =>
          console.error("outbox publish:", err)
        );
      }
    }
  };
  worker.onerror = (e) => {
    e.preventDefault();
    console.error("queue supervisor thread crashed:", e.message);
  };
  const offs = [
    app.queue.onSchedulesChange(() => post({ t: "state", state: state() })),
    app.queue.onWake(() => post({ t: "wake" })),
  ];
  post({
    t: "init",
    opts: {
      kind: "serve",
      nodeId: id,
      dbPath: data,
      auxPath: aux,
      storageDir: o.storageDir,
      dataDir: o.dataDir,
      setup: app.setup,
      concurrency,
      launch,
    },
    state: state(),
  });
  // Settings may change the timezone: the thread reads it from the state it is sent.
  const tz = setInterval(() => post({ t: "state", state: { timezone: app.settings.meta.timezone || "UTC" } }), 60_000);
  await ready;
  await app.services.provide(SCHEDULER_SERVICE, {
    start: (ctx) => {
      scheduling = true;
      schedulerCrashed = (why) => ctx.crashed(new Error(why));
      post({ t: "state", state: { scheduling: true } });
    },
    stop: () => {
      scheduling = false;
      schedulerCrashed = undefined;
      post({ t: "state", state: { scheduling: false } });
    },
    status: () => ({ schedules: app.queue.schedules().length }),
  }, { singleton: false, startSecs: 0 });
  return {
    stop: async () => {
      clearInterval(tz);
      for (const off of offs) off();
      const grace = stopGraceMs(10_000);
      post({ t: "stop", graceMs: grace });
      await Promise.race([done, new Promise((r) => setTimeout(r, grace + 5_000))]);
      worker.terminate();
    },
  };
}
