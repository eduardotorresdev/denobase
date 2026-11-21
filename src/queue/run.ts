import type { DatabaseSync } from "node:sqlite";
import { syncExternalCommits } from "../core/coherence.ts";
import { childSpan } from "../telemetry/instrument/child.ts";
import { parseTraceparent } from "../telemetry/propagation.ts";
import { type Attrs, NOOP_SPAN, SpanKind } from "../telemetry/span.ts";
import { runInSpan } from "../telemetry/tracer.ts";
import type { App } from "../app.ts";
import { fenceNow, installFence, type RunningJob, runUnder } from "./context.ts";
import type { JobCtx, JobErrorCode, JobRow } from "./types.ts";
import { errorToWire, fromWire, toWire } from "../services/wire.ts";

export interface RunResult {
  ok: boolean;
  result?: unknown;
  error?: string;
  code?: JobErrorCode;
  traceId?: string;
  /** The run must not be acked: its lease is gone (lease_lost), the supervisor already knows. */
  lost?: boolean;
}

export interface RunEnv {
  app: App;
  /** The connection the fence renews on (the app's data db). */
  db: DatabaseSync;
  signal: AbortSignal;
  /** Thread label on the run's spans: executor, inline. */
  thread: string;
  /** False once the data dir was swapped under this process (§16 N6). */
  sameFile?: () => boolean;
}

/**
 * One try of a job, wherever it runs (an executor, inline): the handler under its context, its writes fenced by
 * the lease, inside its trace. Scheduled runs are a trace of their own, `cron <id>` (what the crons page reads);
 * the others `job <name>`, a child of whoever enqueued them when the traceparent came along.
 */
export async function runJob(env: RunEnv, row: JobRow): Promise<RunResult> {
  const { app } = env;
  const def = app.queue.definition(row.name);
  if (!def) {
    return { ok: false, error: `job ${row.name} is not defined in this process`, code: "unknown_job" };
  }
  installFence();
  const attrs: Attrs = {};
  const ctx: JobCtx = {
    app,
    store: app.store,
    settings: app.settings,
    payload: fromWire(row.payload),
    attempt: row.attempts,
    job: { id: row.id, name: row.name, queue: row.queue, schedule: row.schedule },
    signal: env.signal,
    span: (name, at, fn) => {
      const s = childSpan(name, { attributes: { ...at, thread: env.thread } });
      return s ? runInSpan(s, fn) : Promise.resolve().then(() => fn(NOOP_SPAN));
    },
    record: (a) => Object.assign(attrs, a),
    internalDb: (which) => (which === "data" ? app.db : app.logs.db),
    fence: () => Promise.resolve(fenceNow(running)),
  };
  const running: RunningJob = {
    ctx,
    owner: { id: row.id, leaseId: row.leaseId! },
    db: env.db,
    guarded: new Set([app.db, app.logs.db]),
    calls: new Map(),
    sameFile: env.sameFile ?? (() => true),
  };
  const root = startRoot(app, row, env.thread);
  const traceId = root.isRecording ? root.traceId : undefined;
  try {
    const result = await runInSpan(root, async () => {
      // A run is an entry point: what other connections committed invalidates this process's caches.
      syncExternalCommits(app.db);
      return await runUnder(running, async () => {
        const out = await def.fn(ctx as never);
        if (env.signal.aborted) throw env.signal.reason ?? new Error("aborted");
        return out;
      });
    }).finally(() => root.setAttributes(attrs));
    return { ok: true, result: toWire(result), traceId };
  } catch (e) {
    const w = errorToWire(e);
    if (w.code === "lease_lost") return { ok: false, error: w.message, code: "handler", traceId, lost: true };
    const reason = env.signal.aborted ? String((env.signal.reason as Error)?.message ?? env.signal.reason) : "";
    const code: JobErrorCode = reason === "timeout"
      ? "timeout"
      : reason === "canceled"
      ? "canceled_running"
      : "handler";
    return { ok: false, error: w.message || String(e), code, traceId };
  } finally {
    app.tracer.flush();
  }
}

function startRoot(app: App, row: JobRow, thread: string) {
  const common = { "job.id": row.id, "job.name": row.name, "job.queue": row.queue, "job.attempt": row.attempts };
  if (row.schedule) {
    return app.tracer.startRoot(`cron ${row.schedule}`, {
      kind: SpanKind.internal,
      keep: true,
      attributes: {
        ...common,
        "cron.job.id": row.schedule,
        "cron.name": row.schedule,
        "cron.trigger": row.expiresAt ? "schedule" : "manual",
        thread,
      },
    });
  }
  return app.tracer.startRoot(`job ${row.name}`, {
    kind: SpanKind.consumer,
    // System jobs are kept like cron runs were; the consumer's follow the sampling (errors and slow ones kept).
    keep: row.name.startsWith("__"),
    parent: parseTraceparent(row.traceparent),
    attributes: { ...common, thread },
  });
}
