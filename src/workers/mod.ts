import type { DatabaseSync } from "node:sqlite";
import type { TaskRequest, TaskResponse } from "./types.ts";
import type { SpanRecord } from "../telemetry/span.ts";
import { TaskFailed, traceWorkerRun } from "../telemetry/instrument/worker.ts";
import type { TraceSettings } from "../telemetry/buffer.ts";

/**
 * Heavy work (backups, cron jobs) runs in Web Workers, Deno's threads. A task is a module
 * whose default export takes a structured-clonable input, since closures cannot cross threads; a worker that needs
 * the db opens its own connection by path (SQLite WAL lets it read while the main connection writes).
 */
export type Task<I, O> = (input: I) => O | Promise<O>;

const HOST = new URL("./host.ts", import.meta.url);

/**
 * Runs `module`'s default export in a fresh worker and resolves with its result; the worker always terminates.
 * Inside a trace the run is a `worker <task>` span and the worker gets its traceparent; what the worker records comes
 * back with the result and joins the trace.
 */
export function runTask<O>(module: URL, input: unknown): Promise<O> {
  return traceWorkerRun<O>(module, (traceparent, traceSettings) => spawn<O>(module, input, traceparent, traceSettings));
}

function spawn<O>(
  module: URL,
  input: unknown,
  traceparent?: string,
  traceSettings?: TraceSettings,
): Promise<{ output: O; spans?: SpanRecord[] }> {
  const worker = new Worker(HOST, { type: "module" });
  return new Promise((resolve, reject) => {
    worker.onmessage = (e: MessageEvent<TaskResponse>) => {
      worker.terminate();
      if (e.data.ok) resolve({ output: e.data.output as O, spans: e.data.spans as SpanRecord[] | undefined });
      else reject(new TaskFailed(e.data.message, e.data.spans as SpanRecord[] | undefined));
    };
    worker.onerror = (e) => {
      e.preventDefault();
      worker.terminate();
      reject(new Error(e.message));
    };
    worker.postMessage({ module: module.href, input, traceparent, traceSettings } satisfies TaskRequest);
  });
}

/** The file behind a connection, or null in memory: such a db cannot be opened from another thread. */
export function dbPath(db: DatabaseSync): string | null {
  return (db as DatabaseSync & { location(): string | null }).location() || null;
}
