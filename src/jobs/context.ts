import type { DatabaseSync } from "node:sqlite";
import { ApiError, type ErrorData } from "../core/errors.ts";
import type { Settings } from "../settings/mod.ts";
import type { Store } from "../store/mod.ts";
import type { Attrs, Span } from "../telemetry/span.ts";
import type { App } from "../app.ts";
import type { WireError } from "./protocol.ts";

/**
 * What a job gets, in the worker or inline (a db with no file, tests). The worker has an App of its own on its own
 * connection: the job reads and writes through `store` directly, its hooks run there, SQLite serializes it with the
 * other threads' writes, and its record events reach the other threads' realtime.
 */
export interface JobContext {
  readonly app: App;
  readonly store: Store;
  /** Runs a named main-thread operation (onMain, app.jobs.operation) and resolves with its result. */
  call<T = unknown>(name: string, ...args: unknown[]): Promise<T>;
  /** The app's settings (kept in step with the other threads'). */
  readonly settings: Settings;
  /** What the dispatcher passed (structured-clonable). */
  readonly input: unknown;
  /** A phase of the job: a child span (thread=worker in the worker). */
  span<T>(name: string, attrs: Attrs | undefined, fn: (s: Span) => T | Promise<T>): Promise<T>;
  /** Attributes for the run's root span on the main thread (items, drift, rows...). */
  record(attrs: Attrs): void;
  /** The thread's connection to the data or the auxiliary db, for denobase's maintenance on internal tables. */
  internalDb(which: "data" | "aux"): DatabaseSync;
  /** True in the job worker; false when the job runs inline because the db has no file. */
  readonly inWorker: boolean;
}

export type JobFn = (ctx: JobContext) => unknown;

/** A task module (denobase's maintenance and backup) exports this as default. */
export type JobTask = (input: never, ctx: JobContext) => unknown;

/** A bootstrap module's default export: what the worker's app needs (modules' hooks and listeners, registries). */
export type JobBootstrap = (app: App) => unknown;

const jobs = new Map<string, JobFn>();

/** Registers a job by id, from a bootstrap module (app.jobs.use). Re-defining replaces. */
export function defineJob(id: string, fn: JobFn): void {
  jobs.set(id, fn);
}

export function jobDefinition(id: string): JobFn | undefined {
  return jobs.get(id);
}

/** An error back from the other thread: an ApiError again when it was one, so callers can still tell a 4xx. */
export function fromWire(w: WireError): Error {
  const e = typeof w.status === "number"
    ? new ApiError(w.status, w.message, (w.data ?? {}) as ErrorData, w.code)
    : new Error(w.message);
  if (w.name && typeof w.status !== "number") e.name = w.name;
  return e;
}
