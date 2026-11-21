import type { DatabaseSync } from "node:sqlite";
import type { App } from "../app.ts";
import type { Settings } from "../settings/mod.ts";
import type { Store } from "../store/mod.ts";
import type { Attrs, Span } from "../telemetry/span.ts";

/** Where a job runs: `normal` in the node's long executor, `heavy` in a process of its own. */
export type QueueName = "normal" | "heavy";
export type JobStatus = "pending" | "running" | "done" | "failed" | "canceled";

/**
 * Why a job is failed or canceled, stable: what the admin filters by.
 * `handler`: the handler threw; `timeout`; `lease_expired`: nobody renewed it and the tries ran out; `expired`: its
 * deadline passed before it started; `crashed`: the process running it died; `restored`: a backup restore swept it; `canceled_pending`: canceled
 * before it started (safe to send again); `canceled_running`: canceled while it ran.
 */
export type JobErrorCode =
  | ""
  | "handler"
  | "timeout"
  | "lease_expired"
  | "expired"
  | "crashed"
  /** Given back by a clean stop of its node (SIGTERM, restore, shutdown): no try spent, not a crash. */
  | "stopped"
  | "restored"
  | "canceled_pending"
  | "canceled_running"
  | "unknown_job";

/** One attempt of a job, as kept in its history. */
export interface JobAttempt {
  n: number;
  node: string;
  start: number;
  end: number;
  ok: boolean;
  error?: string;
  code?: JobErrorCode;
  traceId?: string;
}

/** A row of _jobs (times in ms since the epoch). */
export interface JobRow {
  id: string;
  queue: QueueName;
  name: string;
  payload: unknown;
  result: unknown;
  status: JobStatus;
  error: string;
  errorCode: JobErrorCode;
  priority: number;
  runAt: number;
  expiresAt: number | null;
  attempts: number;
  maxAttempts: number;
  backoffMs: number;
  timeoutMs: number;
  leaseMs: number;
  leaseId: string | null;
  leaseUntil: number | null;
  node: string | null;
  cancel: boolean;
  requeues: number;
  isolate: boolean;
  history: JobAttempt[];
  /** Attempts dropped from the front of history by its cap (the newest are kept). */
  historyDropped: number;
  schedule: string | null;
  dedupe: string | null;
  idem: string | null;
  sensitive: boolean;
  traceparent: string | null;
  traceId: string | null;
  created: number;
  started: number | null;
  finished: number | null;
  updated: number;
}

export interface DefineOptions {
  /** `normal` (default) shares the node's long executor; `heavy` gets a process of its own (backups, big exports). */
  queue?: "normal" | "heavy";
  /** Tries before the job is failed; default 3. */
  maxAttempts?: number;
  /** First retry delay; doubles per try (±20% jitter, at most 1 h); default 10 s. */
  backoffMs?: number;
  /** How long a claim holds without a renewal; the supervisor renews it every third of it; default 60 s. */
  leaseMs?: number;
  /** Abort after this long (ctx.signal), kill 5 s later; default 15 min normal, 6 h heavy. */
  timeoutMs?: number;
  /** The payload is masked in the admin and the REST detail (phone numbers, tokens). */
  sensitive?: boolean;
}

export interface EnqueueOptions {
  delayMs?: number;
  /** ms since the epoch, or a Date. */
  runAt?: number | Date;
  priority?: number;
  /** At most one pending or running job per key: a second enqueue returns the one already there. */
  dedupe?: string;
  maxAttempts?: number;
  /** Not claimable after this (ms or Date): it fails as `expired` if nobody started it. */
  expiresAt?: number | Date | null;
  timeoutMs?: number;
}

/** What a handler gets, in an executor or inline. */
export interface JobCtx<P = unknown> {
  readonly app: App;
  readonly store: Store;
  readonly settings: Settings;
  readonly payload: P;
  /** 1 on the first try. */
  readonly attempt: number;
  readonly job: {
    readonly id: string;
    readonly name: string;
    readonly queue: QueueName;
    readonly schedule: string | null;
  };
  /** Aborted on timeout, cancel, lost lease or shutdown. */
  readonly signal: AbortSignal;
  /** A phase of the job: a child span. */
  span<T>(name: string, attrs: Attrs | undefined, fn: (s: Span) => T | Promise<T>): Promise<T>;
  /** Attributes for the run's root span (items, rows...). */
  record(attrs: Attrs): void;
  /** The connection to the data or the auxiliary db, for denobase's maintenance on internal tables. */
  internalDb(which: "data" | "aux"): DatabaseSync;
  /** Throws `lease_lost` when this run no longer owns the job; renews the lease otherwise (raw SQL writers call it). */
  fence(): Promise<void>;
}

export type JobHandler<P = unknown> = (ctx: JobCtx<P>) => unknown;

export interface JobDefinition {
  name: string;
  fn: JobHandler<never>;
  opts: Required<Omit<DefineOptions, "sensitive">> & { sensitive: boolean };
}

/** A registered schedule: the scheduler enqueues `job` with `payload` at every slot of `expression`. */
export interface ScheduleDef {
  id: string;
  expression: string;
  job: string;
  payload?: unknown;
  /** Replaces the no-overlap key `cron:<id>` (auto backups share `backups` with the manual ones and the restore). */
  dedupe?: string;
}

/** What a node publishes about itself in _queue_nodes. */
export interface NodeInfo {
  id: string;
  kind: "serve" | "worker";
  pid: number;
  host: string;
  queues: QueueName[];
  handlers: string[];
  started: number;
  beat: number;
  info: Record<string, unknown>;
}
