import type { DatabaseSync } from "node:sqlite";
import { ApiError, notFound, stableError } from "../core/errors.ts";
import { afterCommit, inTransaction, tx } from "../core/db.ts";
import { Schedule } from "../cron/schedule.ts";
import { currentSpan } from "../telemetry/context.ts";
import { formatTraceparent } from "../telemetry/propagation.ts";
import { dbPath } from "../workers/mod.ts";
import type { App } from "../app.ts";
import { runningJob } from "./context.ts";
import { listNodes, liveConsumer } from "./nodes.ts";
import { runJob } from "./run.ts";
import { enqueueDue, WAL_SCHEDULES } from "./scheduler.ts";
import {
  ack,
  cancelJob,
  claimById,
  claimLocked,
  cleanupJobs,
  Conflict,
  DEFAULT_RETENTION,
  getJob,
  heartbeat,
  insertJob,
  listJobs,
  type ListQuery,
  nack,
  type NewJob,
  pendingNames,
  queueStats,
  removeJob,
  type Retention,
  retryJob,
  scheduleDay,
  scheduleJobs,
} from "./table.ts";
import type {
  DefineOptions,
  EnqueueOptions,
  JobDefinition,
  JobHandler,
  JobRow,
  QueueName,
  ScheduleDef,
} from "./types.ts";
import { toWire } from "../services/wire.ts";

/** A page of jobs (`list`). */
export interface JobPage {
  page: number;
  perPage: number;
  totalItems: number;
  totalPages: number;
  items: JobRow[];
}

/** A schedule with its newest jobs and the day's counts (`scheduleRuns`). */
export interface ScheduleRuns extends ScheduleDef {
  system: boolean;
  jobs: JobRow[];
  runs24h: number;
  failed24h: number;
}

/** What /api/queue/health answers (`health`). */
export interface QueueHealth {
  now: number;
  mode: "distributed" | "inline";
  queues: Record<string, Record<string, number | null>>;
  nodes: ReturnType<typeof listNodes>;
  noConsumer: { queue: QueueName; name: string; n: number }[];
  normalConsumed: boolean;
  heavyConsumed: boolean;
  wal: unknown;
}

export interface QueueOptions {
  /** How long done and failed jobs are kept (§3). */
  retention?: Partial<Retention>;
}

const DEFAULTS = {
  maxAttempts: 3,
  backoffMs: 10_000,
  leaseMs: 60_000,
  normalTimeoutMs: 15 * 60_000,
  heavyTimeoutMs: 6 * 3_600_000,
};

const queues = new WeakMap<DatabaseSync, Queue>();

/** The queue of the app that owns store.db: `enqueue(req.store, ...)` from a hook or a route. */
export function queueOf(db: DatabaseSync): Queue {
  const q = queues.get(db);
  if (!q) throw new Error("this store has no app queue");
  return q;
}

/**
 * app.queue: one queue, persisted in _jobs, for every background job (§10). Definitions and schedules are per app;
 * the setup module declares them so every process (serve, executors) knows them. On a db with no file (tests) jobs
 * run inline, in this process, right after the commit that enqueued them; on a file the supervisors run them.
 */
export class Queue {
  readonly #defs = new Map<string, JobDefinition>();
  readonly #schedules = new Map<string, ScheduleDef>();
  readonly #scheduleListeners = new Set<() => void>();
  readonly #wake = new Set<() => void>();
  readonly retention: Retention;
  /** Inline runs: the pump in flight, and whether another round was asked meanwhile. */
  #pump: Promise<void> | null = null;
  #again = false;
  #closed = false;
  /** This process's node id once a supervisor runs here (the singleton check skips it). */
  nodeId: string | undefined;

  constructor(
    readonly deps: { app: () => App; db: DatabaseSync; aux: DatabaseSync; role?: () => string },
    opts: QueueOptions = {},
  ) {
    this.retention = { ...DEFAULT_RETENTION, ...opts.retention };
    queues.set(deps.db, this);
  }

  /** A file db: jobs run in supervisors and executors. In memory: inline, after the commit. */
  get distributed(): boolean {
    return !!dbPath(this.deps.db);
  }

  /**
   * A bare createApp on a file (a script, a test): it only enqueues (R3). Consuming is explicit: drain(), refused
   * while nodes are live, or run() of its own job when no node is.
   */
  get bare(): boolean {
    return this.distributed && (this.deps.role?.() ?? "app") === "app";
  }

  // --- definitions ---------------------------------------------------------------------------------------------

  define<P = unknown>(name: string, fn: JobHandler<P>, opts: DefineOptions = {}): void {
    if (!name) throw new Error("queue.define: empty name");
    const queue = opts.queue ?? "normal";
    this.#defs.set(name, {
      name,
      fn: fn as JobHandler<never>,
      opts: {
        queue,
        maxAttempts: Math.max(1, opts.maxAttempts ?? DEFAULTS.maxAttempts),
        backoffMs: opts.backoffMs ?? DEFAULTS.backoffMs,
        leaseMs: opts.leaseMs ?? DEFAULTS.leaseMs,
        timeoutMs: opts.timeoutMs ?? (queue === "heavy" ? DEFAULTS.heavyTimeoutMs : DEFAULTS.normalTimeoutMs),
        sensitive: !!opts.sensitive,
      },
    });
  }

  definition(name: string): JobDefinition | undefined {
    return this.#defs.get(name);
  }

  definitions(): JobDefinition[] {
    return [...this.#defs.values()];
  }

  // --- schedules -----------------------------------------------------------------------------------------------

  /** The scheduler (in the serve) enqueues `job` at every slot of `expression`; re-scheduling an id replaces it. */
  schedule(id: string, expression: string, job: string, payload?: unknown, opts: { dedupe?: string } = {}): void {
    new Schedule(expression);
    this.#schedules.set(id, { id, expression, job, payload, ...(opts.dedupe ? { dedupe: opts.dedupe } : {}) });
    for (const fn of this.#scheduleListeners) fn();
  }

  unschedule(id: string): void {
    if (this.#schedules.delete(id)) { for (const fn of this.#scheduleListeners) fn(); }
  }

  /** PB cronsList order: by id, system ones last. */
  schedules(): ScheduleDef[] {
    return [...this.#schedules.values()].sort((a, b) => {
      const sa = a.id.startsWith("__"), sb = b.id.startsWith("__");
      return sa !== sb ? (sa ? 1 : -1) : a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
    });
  }

  getSchedule(id: string): ScheduleDef | undefined {
    return this.#schedules.get(id);
  }

  onSchedulesChange(fn: () => void): () => void {
    this.#scheduleListeners.add(fn);
    return () => this.#scheduleListeners.delete(fn);
  }

  /** The admin's "run now": only enqueues, with the schedule's no-overlap key; returns the job (new or the one there). */
  async runNow(id: string): Promise<JobRow> {
    const d = this.#schedules.get(id);
    if (!d || WAL_SCHEDULES.includes(id)) throw notFound("Missing or invalid cron job");
    return (await this.#insert({
      ...this.#jobFields(d.job, d.payload),
      runAt: Date.now(),
      schedule: id,
      dedupe: d.dedupe ?? `cron:${id}`,
    })).row;
  }

  /** Enqueues the schedules due at `now` (the serve's scheduler calls it every minute; tests with a pinned date). */
  async tick(now: Date = new Date()): Promise<JobRow[]> {
    const tz = this.deps.app().settings.meta.timezone || "UTC";
    const db = this.deps.db;
    const out: JobRow[] = [];
    for (const d of this.schedules()) {
      const rows = await tx(
        db,
        () => enqueueDue(db, [d], now.getTime(), tz, (s) => this.#jobFields(s.job, s.payload), (fn) => fn()),
      );
      out.push(...rows);
    }
    if (out.length) this.#notify();
    return out;
  }

  // --- enqueue -------------------------------------------------------------------------------------------------

  /**
   * Enqueues a job. Inside a transaction on the app's db it is part of it: a rollback leaves no job. On a dedupe
   * conflict the job already pending or running comes back instead.
   */
  async enqueue(name: string, payload?: unknown, opts: EnqueueOptions = {}): Promise<JobRow> {
    return (await this.enqueued(name, payload, opts)).row;
  }

  /** enqueue, telling whether the job is new or the one a dedupe key already had. */
  async enqueued(
    name: string,
    payload?: unknown,
    opts: EnqueueOptions = {},
  ): Promise<{ row: JobRow; created: boolean }> {
    const at = (v: number | Date | undefined | null) => (v instanceof Date ? v.getTime() : v ?? undefined);
    const now = Date.now();
    const fields = this.#jobFields(name, payload);
    return await this.#insert({
      ...fields,
      runAt: at(opts.runAt) ?? now + (opts.delayMs ?? 0),
      priority: opts.priority ?? 0,
      dedupe: opts.dedupe ?? null,
      maxAttempts: opts.maxAttempts ?? fields.maxAttempts,
      timeoutMs: opts.timeoutMs ?? fields.timeoutMs,
      expiresAt: at(opts.expiresAt) ?? null,
    });
  }

  #jobFields(name: string, payload: unknown): Omit<NewJob, "runAt"> {
    const d = this.#defs.get(name);
    const queue: QueueName = d?.opts.queue ?? "normal";
    const span = currentSpan();
    return {
      queue,
      name,
      payload: toWire(payload),
      maxAttempts: d?.opts.maxAttempts ?? DEFAULTS.maxAttempts,
      backoffMs: d?.opts.backoffMs ?? DEFAULTS.backoffMs,
      leaseMs: d?.opts.leaseMs ?? DEFAULTS.leaseMs,
      timeoutMs: d?.opts.timeoutMs ?? (queue === "heavy" ? DEFAULTS.heavyTimeoutMs : DEFAULTS.normalTimeoutMs),
      sensitive: d?.opts.sensitive ?? false,
      traceparent: span?.isRecording
        ? formatTraceparent({ traceId: span.traceId, spanId: span.id, sampled: span.sampled })
        : null,
    };
  }

  async #insert(j: NewJob): Promise<{ row: JobRow; created: boolean }> {
    const db = this.deps.db;
    const now = Date.now();
    // Inside the caller's transaction the insert is part of it; the wake waits for its commit.
    const { row, created } = inTransaction(db) ? insertJob(db, j, now) : await tx(db, () => insertJob(db, j, now));
    if (created) {
      if (inTransaction(db)) afterCommit(db, () => this.#notify());
      else this.#notify();
    }
    return { row, created };
  }

  /** Something to run: wake the local supervisor (postMessage), or the inline pump. */
  onWake(fn: () => void): () => void {
    this.#wake.add(fn);
    return () => this.#wake.delete(fn);
  }

  #notify(): void {
    for (const fn of this.#wake) fn();
    if (!this.distributed && !this.#closed) this.#kick();
  }

  // --- waiting -------------------------------------------------------------------------------------------------

  /**
   * Enqueues and waits for the end; resolves with the result, rejects with the job's error. Fails fast with
   * `queue_unavailable` when no live node consumes the job's queue.
   */
  async run(
    name: string,
    payload?: unknown,
    opts: EnqueueOptions & { waitMs?: number; exclusive?: boolean } = {},
  ): Promise<unknown> {
    const queue = this.#defs.get(name)?.opts.queue ?? "normal";
    // A bare app with no node up runs the job it asked for itself (and only that one).
    if (this.bare && !this.#liveNodes()) {
      const { row, created } = await this.enqueued(name, payload, opts);
      if (!created && opts.exclusive) {
        throw stableError(409, "queue_dedupe_taken", "Another job with the same key is pending or running.");
      }
      const db = this.deps.db;
      const mine = await tx(db, () => claimById(db, row.id, "inline", Date.now()));
      if (mine) await this.#runRow(mine, Date.now(), false);
      const end = await this.wait(row.id, opts.waitMs);
      if (end.status === "done") return end.result;
      throw new ApiError(500, end.error || `job ${name} ${end.status}`, {}, end.errorCode || "job_failed");
    }
    if (this.distributed && !liveConsumer(this.deps.aux, queue, name, Date.now())) {
      throw new ApiError(503, `No worker consumes the ${queue} queue for ${name}.`, {}, "queue_unavailable");
    }
    const { row, created } = await this.enqueued(name, payload, opts);
    // exclusive: the dedupe key taken by another job is a refusal, not a wait on that one.
    if (!created && opts.exclusive) {
      throw stableError(409, "queue_dedupe_taken", "Another job with the same key is pending or running.");
    }
    const end = await this.wait(row.id, opts.waitMs);
    if (end.status === "done") return end.result;
    throw new ApiError(500, end.error || `job ${name} ${end.status}`, {}, end.errorCode || "job_failed");
  }

  /** Resolves once job id is done, failed or canceled. */
  async wait(id: string, waitMs = 24 * 3_600_000): Promise<JobRow> {
    const until = Date.now() + waitMs;
    for (;;) {
      // Inline, a job waiting on another runs it nested: the pump is busy running the caller.
      if (!this.distributed) await (runningJob() ? this.#runDue(Date.now()) : this.drain());
      const j = getJob(this.deps.db, id);
      if (!j) throw notFound("The job was removed.");
      if (j.status === "done" || j.status === "failed" || j.status === "canceled") return j;
      if (Date.now() > until) throw new ApiError(504, "Timed out waiting for the job.", {}, "queue_wait_timeout");
      await new Promise((r) => setTimeout(r, this.distributed ? 50 : 10));
    }
  }

  // --- inline runs (a db with no file) -------------------------------------------------------------------------

  #kick(): void {
    if (this.#pump) {
      this.#again = true;
      return;
    }
    this.#pump = (async () => {
      try {
        do {
          this.#again = false;
          await this.#runDue(Date.now());
        } while (this.#again);
      } finally {
        this.#pump = null;
      }
    })();
  }

  /**
   * Runs every due job here, in order, until none is left; `now` pins the clock (backoff and future runAt are due
   * once it is past them). Tests await it; inline apps also run it after each enqueue.
   */
  async drain(opts: { now?: number | Date } = {}): Promise<void> {
    // Live nodes own the jobs on this file: consuming here too would run them without their heartbeat (R3).
    if (this.distributed && this.#liveNodes()) {
      throw new Error("queue.drain: nodes are live on this db; they run the jobs");
    }
    while (this.#pump) await this.#pump;
    const now = opts.now instanceof Date ? opts.now.getTime() : opts.now;
    await this.#runDue(now ?? Date.now(), now !== undefined);
  }

  async #runDue(now: number, pinned = false): Promise<void> {
    const db = this.deps.db;
    const names = this.definitions().map((d) => d.name);
    for (let guard = 0; guard < 10_000; guard++) {
      const at = pinned ? now : Date.now();
      let row: JobRow | null = null;
      for (const q of ["normal", "heavy"] as QueueName[]) {
        const n = names;
        row = await tx(
          db,
          () =>
            claimLocked(db, { queue: q, names: n, ...(q === "normal" ? { isolate: false } : {}) }, "inline", at) ??
              (q === "normal" ? claimLocked(db, { queue: q, names: n, isolate: true }, "inline", at) : null),
        );
        if (row) break;
      }
      if (!row) return;
      await this.#runRow(row, now, pinned);
    }
  }

  #liveNodes(): boolean {
    return listNodes(this.deps.aux, Date.now()).some((n) => n.alive);
  }

  /** Runs one claimed job here and writes its outcome. */
  async #runRow(row: JobRow, now: number, pinned: boolean): Promise<void> {
    const app = this.deps.app();
    const db = this.deps.db;
    {
      const start = Date.now();
      const o = { id: row.id, leaseId: row.leaseId! };
      const ac = new AbortController();
      // On a file (a bare app's own run, or drain) the lease is renewed here as a supervisor would, so a worker that
      // comes up meanwhile never takes the job over while it runs (B1). In memory nobody else can claim it.
      let beating = false;
      const beat = this.distributed
        ? setInterval(() => {
          if (beating) return;
          beating = true;
          tx(db, () => heartbeat(db, o, Date.now()))
            .then((h) => {
              if (!h) ac.abort(new Error("lease lost"));
              else if (h.cancel) ac.abort(new Error("canceled"));
            }, () => {/* busy: the next beat */})
            .finally(() => (beating = false));
        }, Math.max(100, Math.min(5_000, Math.floor(row.leaseMs / 3))))
        : undefined;
      let r;
      try {
        r = await runJob({ app, db, signal: ac.signal, thread: "inline" }, row);
      } finally {
        clearInterval(beat);
      }
      const end = pinned ? now : Date.now();
      if (r.lost) return;
      await tx(
        db,
        () =>
          r.ok ? ack(db, o, r.result, { node: "inline", start, traceId: r.traceId }, end) : nack(
            db,
            o,
            r.error ?? "failed",
            r.code ?? "handler",
            { node: "inline", start, traceId: r.traceId },
            end,
            {
              final: r.code === "unknown_job",
            },
          ),
      );
    }
  }

  close(): void {
    this.#closed = true;
  }

  // --- admin ---------------------------------------------------------------------------------------------------

  get(id: string): JobRow | null {
    return getJob(this.deps.db, id);
  }

  list(q: ListQuery = {}): JobPage {
    return listJobs(this.deps.db, q);
  }

  async retry(id: string): Promise<JobRow> {
    const db = this.deps.db;
    try {
      const r = await tx(db, () => retryJob(db, id, Date.now()));
      if (!r) throw this.#missing(id, "Only failed or canceled jobs can be retried.");
      this.#notify();
      return r;
    } catch (e) {
      if (e instanceof Conflict) throw stableError(409, "queue_dedupe_taken", e.message);
      throw e;
    }
  }

  async cancel(id: string): Promise<JobRow> {
    const db = this.deps.db;
    const r = await tx(db, () => cancelJob(db, id, Date.now()));
    if (!r) throw this.#missing(id, "Only pending or running jobs can be canceled.");
    return r;
  }

  async remove(id: string): Promise<void> {
    const db = this.deps.db;
    const r = await tx(db, () => removeJob(db, id));
    if (r === "running") throw stableError(409, "queue_job_running", "A running job cannot be removed; cancel it.");
    if (!r) throw notFound();
  }

  #missing(id: string, msg: string): ApiError {
    return getJob(this.deps.db, id) ? stableError(409, "queue_bad_state", msg) : notFound();
  }

  async cleanup(now: number = Date.now()): Promise<number> {
    const db = this.deps.db;
    return await tx(db, () => cleanupJobs(db, this.retention, now));
  }

  /** The schedules with their newest jobs and the day's counts (the crons page, the home). */
  scheduleRuns(limit: number = 10): ScheduleRuns[] {
    const db = this.deps.db;
    const since = Date.now() - 86_400_000;
    return this.schedules().filter((s) => !WAL_SCHEDULES.includes(s.id)).map((s) => {
      const jobs = scheduleJobs(db, s.id, limit);
      const day = scheduleDay(db, s.id, since);
      return { ...s, system: s.id.startsWith("__"), jobs, runs24h: day.runs, failed24h: day.failed };
    });
  }

  /** /api/queue/health (§14). */
  health(): QueueHealth {
    const now = Date.now();
    const db = this.deps.db;
    const nodes = listNodes(this.deps.aux, now);
    const live = nodes.filter((n) => n.alive);
    const noConsumer = pendingNames(db).filter((p) =>
      !live.some((n) => n.queues.includes(p.queue) && n.handlers.includes(p.name))
    );
    return {
      now,
      mode: this.distributed ? "distributed" : "inline",
      queues: queueStats(db, now),
      nodes,
      noConsumer: this.distributed ? noConsumer : [],
      normalConsumed: !this.distributed || live.some((n) => n.queues.includes("normal")),
      heavyConsumed: !this.distributed || live.some((n) => n.queues.includes("heavy")),
      wal: live.find((n) => n.kind === "serve" && n.info.wal)?.info.wal ?? null,
    };
  }
}
