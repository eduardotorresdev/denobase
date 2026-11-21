/** The one queue (§10 of docs/queue-design.md): jobs, schedules, long services, the worker. */
export { Queue, queueOf, type QueueOptions } from "./queue.ts";
export * from "../services/mod.ts";
export { currentJob } from "./context.ts";
export { DEFAULT_RETENTION, type ListQuery, type Retention } from "./table.ts";
export type {
  DefineOptions,
  EnqueueOptions,
  JobAttempt,
  JobCtx,
  JobErrorCode,
  JobHandler,
  JobRow,
  JobStatus,
  NodeInfo,
  QueueName,
  ScheduleDef,
} from "./types.ts";

import type { Store } from "../store/mod.ts";
import { queueOf } from "./queue.ts";
import type { EnqueueOptions, JobRow } from "./types.ts";

/**
 * Enqueues on the queue of the app that owns `store` (hooks and access fns have req.store, not the app). Inside a
 * transaction on that store it is part of it.
 */
export function enqueue(
  store: Pick<Store, "db">,
  name: string,
  payload?: unknown,
  opts?: EnqueueOptions,
): Promise<JobRow> {
  return queueOf(store.db).enqueue(name, payload, opts);
}
