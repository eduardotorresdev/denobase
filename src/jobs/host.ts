/// <reference lib="deno.worker" />
/**
 * The job worker: one long-lived thread that runs every cron job and backup off the main thread. It builds an App of
 * its own on its own connection (WAL, busy_timeout) and lets the consumer's bootstrap modules set it up as the
 * served app is (collections, hooks, record listeners, registries), never with the HTTP server, MQTT, WhatsApp or
 * the scheduler: those singletons stay on the main thread. Jobs write directly; SQLite serializes them with the other
 * threads' writes. Runs are multiplexed by runId: a slow job does not hold the others.
 */
import { type App, createApp } from "../app.ts";
import { openDb } from "../core/db.ts";
import { syncExternalCommits } from "../core/coherence.ts";
import { onRecordEvent } from "../engine/events.ts";
import { FsStorage } from "../files/storage.ts";
import { parseTraceparent } from "../telemetry/propagation.ts";
import { Trace as TraceBuffer, type TraceSettings } from "../telemetry/buffer.ts";
import { Collector } from "../telemetry/instrument/worker.ts";
import { currentSpan } from "../telemetry/context.ts";
import { type Attrs, NOOP_SPAN, SpanKind, type SpanRecord } from "../telemetry/span.ts";
import { runInSpan } from "../telemetry/tracer.ts";
import { childSpan } from "../telemetry/instrument/child.ts";
import { fromWire, type JobBootstrap, type JobContext, jobDefinition, type JobTask } from "./context.ts";
import { currentJob, markJobWorker, runAsJob, setMainRelay } from "./on_main.ts";
import { type FromWorker, toWire, type ToWorker } from "./protocol.ts";

const post = (m: FromWorker) => self.postMessage(m);

let app: App | undefined;
let nextCall = 1;
const calls = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
/** Rows each run wrote (record events of this thread's writes, counted under the job that made them). */
const rows = new WeakMap<JobContext, number>();
const runIds = new WeakMap<JobContext, number>();

async function init(m: Extract<ToWorker, { type: "init" }>): Promise<void> {
  try {
    markJobWorker();
    setMainRelay(callMain);
    app = createApp({
      db: openDb(m.dbPath),
      auxDb: openDb(m.auxPath),
      storage: m.storageDir ? new FsStorage(m.storageDir) : undefined,
      adminUiDir: false,
    });
    onRecordEvent({
      changed: (e) => count(e.db),
      deleting: (e) => Promise.resolve(void count(e.db)),
    });
    for (const b of m.bootstrap) {
      const mod = await import(b);
      if (typeof mod.default === "function") await (mod.default as JobBootstrap)(app);
    }
    post({ type: "ready" });
  } catch (e) {
    post({ type: "initFailed", error: toWire(e) });
  }
}

function count(db: unknown): void {
  const job = currentJob();
  if (job && db === app?.db) rows.set(job, (rows.get(job) ?? 0) + 1);
}

const tag = (spans: SpanRecord[]): SpanRecord[] =>
  spans.map((s) => ({ ...s, attributes: { ...s.attributes, thread: "worker" } }));

async function run(m: Extract<ToWorker, { type: "run" }>): Promise<void> {
  const a = app!;
  const attrs: Attrs = {};
  const ctx: JobContext = {
    app: a,
    store: a.store,
    call: <T>(name: string, ...args: unknown[]) => callMain(name, args) as Promise<T>,
    settings: a.settings,
    input: m.input,
    span: (name, at, fn) => {
      const s = childSpan(name, { attributes: { ...at, thread: "worker" } });
      return s ? runInSpan(s, fn) : Promise.resolve().then(() => fn(NOOP_SPAN));
    },
    record: (x) => Object.assign(attrs, x),
    internalDb: (which) => which === "data" ? a.db : a.logs.db,
    inWorker: true,
  };
  runIds.set(ctx, m.runId);
  const body = async () => {
    // A run is an entry point: what the other threads committed since the last one invalidates this thread's caches.
    syncExternalCommits(a.db);
    return m.job
      ? await runJob(m.job, ctx)
      : await ((await import(m.module!)).default as JobTask)(m.input as never, ctx);
  };
  const { collector, traced } = traceRun(m.traceparent, m.traceSettings, m.job ?? m.module!);
  const done = (ok: boolean, extra: Partial<Extract<FromWorker, { type: "done" }>>) =>
    post({
      type: "done",
      runId: m.runId,
      ok,
      attrs: { ...attrs, "cron.rows_written": rows.get(ctx) ?? 0 },
      spans: tag(collector?.spans ?? []),
      ...extra,
    });
  try {
    done(true, { output: await traced(() => runAsJob(ctx, body)) });
  } catch (e) {
    done(false, { error: toWire(e) });
  }
}

function callMain(name: string, args: unknown[]): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const callId = nextCall++;
    calls.set(callId, { resolve, reject });
    const job = currentJob();
    post({ type: "call", callId, name, args, runId: job && runIds.get(job), parentSpanId: currentSpan()?.id });
  });
}

function runJob(id: string, ctx: JobContext): Promise<unknown> {
  const fn = jobDefinition(id);
  if (!fn) return Promise.reject(new Error(`job ${id} is not defined in the worker (missing bootstrap?)`));
  return Promise.resolve(fn(ctx));
}

/** The run's top span in the worker (`job <id>`, thread=worker), child of the main thread's span. */
function traceRun(traceparent: string | undefined, settings: TraceSettings | undefined, name: string) {
  const parent = parseTraceparent(traceparent);
  if (!parent || !settings) return { collector: undefined, traced: <T>(fn: () => Promise<T>) => fn() };
  const collector = new Collector({ ...settings, enabled: true, sampleRatio: 1, minDurationMs: 0, slowMs: 0 });
  const trace = new TraceBuffer(collector, parent.traceId, parent.sampled !== false);
  const label = name.includes("/") ? name.split("/").pop()!.replace(/\.ts$/, "") : name;
  const span = trace.start(`job ${label}`, parent.spanId, true, {
    kind: SpanKind.consumer,
    attributes: { thread: "worker", "job.name": label },
  });
  return { collector, traced: <T>(fn: () => Promise<T>) => runInSpan(span, fn) };
}

self.onmessage = (e: MessageEvent<ToWorker>) => {
  const m = e.data;
  if (m.type === "init") void init(m);
  else if (m.type === "run") void run(m);
  else if (m.type === "result") {
    const c = calls.get(m.callId);
    if (!c) return;
    calls.delete(m.callId);
    if (m.ok) c.resolve(m.value);
    else c.reject(fromWire(m.error ?? { message: "main-thread operation failed" }));
  }
};
