import { AsyncLocalStorage } from "node:async_hooks";
import type { DatabaseSync } from "node:sqlite";
import { ApiError } from "../core/errors.ts";
import { holdsTransaction, setBeginGuard, setCommitGuard, tx } from "../core/db.ts";
import { fence as fenceRow, type Owner } from "./table.ts";
import type { JobCtx } from "./types.ts";

/** What the runtime keeps about the job the caller runs under (one per try). */
export interface RunningJob {
  ctx: JobCtx;
  owner: Owner;
  /** The data connection the fence renews on (the job's _jobs row is there). */
  db: DatabaseSync;
  /** Connections whose top-level transactions the fence guards: the job's data and auxiliary dbs. */
  guarded: Set<DatabaseSync>;
  /** Service calls made so far in this try, per idempotency hash: the k of `<hash>:<k>` (§17). */
  calls: Map<string, number>;
  /** Checked before the fence: false when the data dir was swapped by a restore (§16 N6). */
  sameFile: () => boolean;
}

const als = new AsyncLocalStorage<RunningJob>();

const here = { executor: false };
/** True in an executor subprocess (set before the setup loads). */
export function inExecutor(): boolean {
  return here.executor;
}
export function markExecutor(): void {
  here.executor = true;
}

export function runUnder<T>(job: RunningJob, fn: () => T): T {
  return als.run(job, fn);
}

export function runningJob(): RunningJob | undefined {
  return als.getStore();
}

/** The job the caller runs under (in an executor or inline); undefined in a request. */
export function currentJob(): JobCtx | undefined {
  return als.getStore()?.ctx;
}

export const leaseLost = () =>
  new ApiError(409, "This job run lost its lease: another run owns it now.", {}, "lease_lost");

/** Renews the lease and checks this run still owns the job; throws `lease_lost` otherwise. */
export function fenceNow(job: RunningJob): void {
  if (!job.sameFile() || !fenceRow(job.db, job.owner, Date.now())) throw leaseLost();
}

/**
 * The fence on every top-level transaction a job opens (§16 N3): the _jobs UPDATE runs inside the transaction when it
 * is on the data db (so the job's writes and the check commit together), right before the COMMIT of one on the
 * auxiliary db. Installed once per process.
 */
let installed = false;
export function installFence(): void {
  if (installed) return;
  installed = true;
  setBeginGuard((db) => {
    const job = als.getStore();
    if (job && job.guarded.has(db) && db === job.db) fenceNow(job);
  });
  setCommitGuard(async (db) => {
    const job = als.getStore();
    if (!job || !job.guarded.has(db)) return;
    // Inside its own data transaction (an aux tx opened within it, R5) the bare statement joins that transaction:
    // queueing one would wait on the transaction that is waiting on us.
    if (db === job.db || holdsTransaction(job.db)) return fenceNow(job);
    // Another job of this executor may hold a transaction on the shared data connection: a bare statement would join
    // it, so the fence of an auxiliary-db transaction queues as one of its own.
    await tx(job.db, () => fenceNow(job));
  });
}
