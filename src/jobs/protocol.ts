/**
 * The messages between the thread that dispatches (the main thread, owner of the singletons) and the job worker.
 * Writes never cross: the worker writes on its own connection. What crosses is a run (by job name or task module) and
 * its result with the spans, and calls to main-thread operations that need a singleton (the WhatsApp session).
 */
import type { Attrs, SpanRecord } from "../telemetry/span.ts";
import type { TraceSettings } from "../telemetry/buffer.ts";

/** An error as it crosses threads; status/data/code rebuild an ApiError on the other side. */
export interface WireError {
  message: string;
  name?: string;
  status?: number;
  data?: Record<string, unknown>;
  code?: string;
}

export type ToWorker =
  | {
    type: "init";
    /** Consumer modules: each may export a default setup(app) that registers what the worker's app needs. */
    bootstrap: string[];
    dbPath: string;
    auxPath: string;
    /** pb_data/storage, when the app keeps files on disk. */
    storageDir?: string;
  }
  | {
    type: "run";
    runId: number;
    /** A job registered with defineJob... */
    job?: string;
    /** ...or a task module whose default export takes (input, ctx), for denobase's own maintenance and backups. */
    module?: string;
    input: unknown;
    traceparent?: string;
    traceSettings?: TraceSettings;
  }
  | { type: "result"; callId: number; ok: boolean; value?: unknown; error?: WireError };

export type FromWorker =
  | { type: "ready" }
  | { type: "initFailed"; error: WireError }
  | {
    type: "call";
    callId: number;
    name: string;
    args: unknown[];
    /** The run and worker span the call came from, so its main-thread span joins that trace. */
    runId?: number;
    parentSpanId?: string;
  }
  | {
    type: "done";
    runId: number;
    ok: boolean;
    output?: unknown;
    error?: WireError;
    spans?: SpanRecord[];
    /** What the job recorded with ctx.record, plus the rows it wrote, for the root span. */
    attrs?: Attrs;
  };

export function toWire(e: unknown): WireError {
  if (!(e instanceof Error)) return { message: String(e) };
  const x = e as Error & { status?: unknown; data?: unknown; code?: unknown };
  return {
    message: e.message,
    name: e.name,
    status: typeof x.status === "number" ? x.status : undefined,
    data: x.data && typeof x.data === "object" ? x.data as Record<string, unknown> : undefined,
    code: typeof x.code === "string" ? x.code : undefined,
  };
}
