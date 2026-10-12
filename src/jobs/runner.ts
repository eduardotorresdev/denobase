import type { DatabaseSync } from "node:sqlite";
import type { Store } from "../store/mod.ts";
import { CurrentStorage } from "../files/current.ts";
import { FsStorage } from "../files/storage.ts";
import { currentSpan } from "../telemetry/context.ts";
import { formatTraceparent } from "../telemetry/propagation.ts";
import { type Attrs, NOOP_SPAN, type Span, SpanKind } from "../telemetry/span.ts";
import { runInSpan, type Tracer } from "../telemetry/tracer.ts";
import { dbPath } from "../workers/mod.ts";
import type { App } from "../app.ts";
import { fromWire, type JobContext, jobDefinition, type JobTask } from "./context.ts";
import { type MainOp, mainOp, runAsJob, setMainOp } from "./on_main.ts";
import { type FromWorker, toWire, type ToWorker } from "./protocol.ts";

const HOST = new URL("./host.ts", import.meta.url);

/** What to run: a job a bootstrap module defined, or a task module (denobase's maintenance and backup). */
export type JobSpec = { job: string; module?: never } | { module: URL; job?: never };

interface Run {
  resolve: (v: unknown) => void;
  reject: (e: Error) => void;
  /** The main-thread span the run belongs to (the cron root). */
  span: Span;
}

export interface RunnerDeps {
  app: () => App;
  db: DatabaseSync;
  auxDb: DatabaseSync;
  store: Store;
  tracer: Tracer;
}

/**
 * The job runner (app.jobs): every cron job and backup runs in one long-lived worker, never on the main thread. The
 * worker writes on its own connection (SQLite serializes it with the HTTP threads); the main thread dispatches, owns
 * the singletons the jobs call by name (onMain), and receives each run's spans into the run's trace. A crashed worker
 * fails its runs and is replaced on the next run. A db without a file (tests) cannot be opened by the worker, so
 * there jobs run inline through the same context.
 */
export class JobRunner {
  readonly #bootstrap: URL[] = [];
  readonly #runs = new Map<number, Run>();
  #worker: Worker | undefined;
  #ready: Promise<void> | undefined;
  #nextRun = 1;
  #closed = false;
  /** Workers replaced after a crash, since start. */
  restarts = 0;

  constructor(readonly deps: RunnerDeps) {}

  /**
   * Whether runs go to the worker (both dbs are files) or run inline. DENOBASE_JOBS_INLINE=1 is the
   * fallback: every job runs on the main thread (backups keep a worker of their own).
   */
  get inWorker(): boolean {
    return !jobsInline() && !!dbPath(this.deps.db) && !!dbPath(this.deps.auxDb);
  }

  /**
   * A module the worker imports before any run: its default export, if any, sets the worker's app up (the
   * consumer's hooks, listeners, registries) and it defines its jobs (defineJob). A worker already started is
   * replaced on its next run, so it loads the new list.
   */
  use(bootstrap: URL): void {
    if (this.#bootstrap.some((b) => b.href === bootstrap.href)) return;
    this.#bootstrap.push(bootstrap);
    if (this.#worker) this.#stopWorker();
  }

  /** A named main-thread operation bound at runtime (it closes over main-thread state); module-level ones use onMain. */
  operation(name: string, fn: MainOp): void {
    setMainOp(name, fn);
  }

  /**
   * Runs a job and resolves with its output. Inside a trace (a cron run) the worker joins it: its spans come back
   * with the result, and what it recorded (rows written included) lands on the current span.
   */
  async run(spec: JobSpec, input?: unknown): Promise<unknown> {
    if (this.#closed) throw new Error("job runner terminated");
    const span = currentSpan() ?? NOOP_SPAN;
    if (!this.inWorker) return await this.#inline(spec, input, span);
    await this.#start();
    const id = this.#nextRun++;
    return await new Promise((resolve, reject) => {
      this.#runs.set(id, { resolve, reject, span });
      this.#post({
        type: "run",
        runId: id,
        job: spec.job,
        module: spec.module?.href,
        input,
        traceparent: span.isRecording
          ? formatTraceparent({ traceId: span.traceId, spanId: span.id, sampled: span.sampled })
          : undefined,
        traceSettings: span.isRecording ? span.trace!.sink.settings() : undefined,
      });
    });
  }

  /** Stops the worker (in-flight runs fail); later runs are refused. */
  terminate(): void {
    this.#closed = true;
    this.#stopWorker(new Error("job runner terminated"));
  }

  #post(m: ToWorker): void {
    this.#worker!.postMessage(m);
  }

  #start(): Promise<void> {
    if (this.#ready) return this.#ready;
    const worker = new Worker(HOST, { type: "module" });
    this.#worker = worker;
    this.#ready = new Promise<void>((resolve, reject) => {
      worker.onmessage = (e: MessageEvent<FromWorker>) => {
        const m = e.data;
        if (m.type === "ready") resolve();
        else if (m.type === "initFailed") {
          const err = fromWire(m.error);
          this.#stopWorker(err);
          reject(err);
        } else this.#onMessage(m);
      };
      worker.onerror = (e) => {
        e.preventDefault();
        const err = new Error(`job worker crashed: ${e.message}`);
        console.error(err.message);
        this.restarts++;
        this.#stopWorker(err);
        reject(err);
      };
    });
    // The worker builds its own app, which reads settings.s3 itself; what it needs is the local fallback.
    const current = this.deps.store.storage;
    const storage = current instanceof CurrentStorage ? current.local : current;
    this.#post({
      type: "init",
      bootstrap: this.#bootstrap.map((b) => b.href),
      dbPath: dbPath(this.deps.db)!,
      auxPath: dbPath(this.deps.auxDb)!,
      storageDir: storage instanceof FsStorage ? storage.root : undefined,
    });
    return this.#ready;
  }

  /** Terminates the worker; its runs fail with err (a crash, a shutdown) and the next run starts a fresh one. */
  #stopWorker(err = new Error("job worker restarted")): void {
    this.#worker?.terminate();
    this.#worker = undefined;
    this.#ready = undefined;
    const runs = [...this.#runs.values()];
    this.#runs.clear();
    for (const r of runs) r.reject(err);
  }

  #onMessage(m: FromWorker): void {
    if (m.type === "call") void this.#call(m);
    else if (m.type === "done") {
      const run = this.#runs.get(m.runId);
      if (!run) return;
      this.#runs.delete(m.runId);
      if (m.spans?.length && run.span.isRecording) run.span.trace!.adopt(m.spans);
      if (m.attrs) run.span.setAttributes(m.attrs);
      if (m.ok) run.resolve(m.output);
      else run.reject(fromWire(m.error ?? { message: "job failed" }));
    }
  }

  /** A main-thread operation the worker asked for; inside a run's trace it is a `job.principal <name>` span. */
  async #call(m: Extract<FromWorker, { type: "call" }>): Promise<void> {
    const work = () => callMainOp(this.deps.store, m.name, m.args);
    const run = m.runId === undefined ? undefined : this.#runs.get(m.runId);
    let reply: Extract<ToWorker, { type: "result" }>;
    try {
      const value = run?.span.isRecording
        ? await runInSpan(
          run.span.trace!.start(`job.principal ${m.name}`, m.parentSpanId ?? run.span.id, false, {
            kind: SpanKind.internal,
            attributes: { thread: "main", "job.operation": m.name },
          }),
          work,
        )
        : await work();
      reply = { type: "result", callId: m.callId, ok: true, value };
    } catch (e) {
      reply = { type: "result", callId: m.callId, ok: false, error: toWire(e) };
    }
    this.#worker?.postMessage(reply);
  }

  /** The same context on the main thread, for a db the worker cannot open: the job uses the app as it is. */
  async #inline(spec: JobSpec, input: unknown, span: Span): Promise<unknown> {
    const app = this.deps.app();
    for (const b of this.#bootstrap) await import(b.href);
    const attrs: Attrs = {};
    const ctx: JobContext = {
      app,
      store: this.deps.store,
      call: async <T>(name: string, ...args: unknown[]) => await callMainOp(this.deps.store, name, args) as T,
      settings: app.settings,
      input,
      span: (name, a, fn) => this.deps.tracer.span(name, a, fn),
      record: (a) => Object.assign(attrs, a),
      internalDb: (which) => which === "data" ? this.deps.db : this.deps.auxDb,
      inWorker: false,
    };
    try {
      return await runAsJob(ctx, async () => {
        if (spec.job) {
          const fn = jobDefinition(spec.job);
          if (!fn) throw new Error(`job ${spec.job} is not defined (missing bootstrap?)`);
          return await fn(ctx);
        }
        const task = (await import(spec.module!.href)).default as JobTask;
        return await task(input as never, ctx);
      });
    } finally {
      span.setAttributes(attrs);
    }
  }
}

function callMainOp(store: Store, name: string, args: unknown[]): Promise<unknown> {
  const o = mainOp(name);
  if (!o) return Promise.reject(new Error(`main-thread operation ${name} is not declared`));
  return Promise.resolve(o(store, ...args as never[]));
}

/** DENOBASE_JOBS_INLINE=1 (or "true"): jobs run inline on the main thread; read at every run. */
export function jobsInline(): boolean {
  const v = Deno.env.get("DENOBASE_JOBS_INLINE")?.trim().toLowerCase();
  return v === "1" || v === "true";
}
