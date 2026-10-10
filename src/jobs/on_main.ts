import { AsyncLocalStorage } from "node:async_hooks";
import type { Store } from "../store/mod.ts";
import type { JobContext } from "./context.ts";

/**
 * Writes need no main thread: every thread writes on its own connection and SQLite serializes them. What does need it
 * is a singleton the main thread owns (the WhatsApp session, the mailer it was built with): a unit declared with onMain
 * runs there when called from the job worker, by name, with structured-clonable args and result; anywhere else it is a
 * plain call.
 */
export type MainOp = (store: Store, ...args: never[]) => unknown;

const ops = new Map<string, MainOp>();
const current = new AsyncLocalStorage<JobContext>();
const thread = { worker: false };

/** True inside the job worker (set before the bootstraps load). */
export function inJobWorker(): boolean {
  return thread.worker;
}

export function markJobWorker(): void {
  thread.worker = true;
}

/** The job the caller runs under, in the worker or inline; undefined in a request. */
export function currentJob(): JobContext | undefined {
  return current.getStore();
}

export function runAsJob<T>(ctx: JobContext, fn: () => T): T {
  return current.run(ctx, fn);
}

/** The relay to the main thread, set by the worker host. */
let relay: ((name: string, args: unknown[]) => Promise<unknown>) | undefined;

export function setMainRelay(fn: (name: string, args: unknown[]) => Promise<unknown>): void {
  relay = fn;
}

/** Declares fn as a main-thread unit named `name` (module-scoped, so the worker and the main thread both know it). */
export function onMain<A extends unknown[], R, S extends Pick<Store, "db"> = Store>(
  name: string,
  fn: (store: S, ...args: A) => R | Promise<R>,
): (store: S, ...args: A) => Promise<R> {
  const declared = fn as unknown as MainOp;
  if (ops.has(name) && ops.get(name) !== declared) throw new Error(`onMain: ${name} is already declared`);
  ops.set(name, declared);
  return (store, ...args) => {
    if (relay) return relay(name, args) as Promise<R>;
    return Promise.resolve(fn(store, ...args));
  };
}

export function mainOp(name: string): MainOp | undefined {
  return ops.get(name);
}

/** A named op bound at runtime (app.jobs.operation), for one that closes over main-thread state. */
export function setMainOp(name: string, op: MainOp): void {
  ops.set(name, op);
}
