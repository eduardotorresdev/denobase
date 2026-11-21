import type { Hono } from "hono";
import type { AppEnv, Ctx } from "./app.ts";
import { notFound } from "../core/errors.ts";
import { requireSuperuser } from "./guards.ts";
import type { JobRow, JobStatus, QueueName } from "../queue/types.ts";
import { statusCounts } from "../queue/table.ts";
import { SCHEDULER_SERVICE as SCHEDULER, WAL_SCHEDULES } from "../queue/scheduler.ts";

const STATUSES = new Set(["pending", "running", "done", "failed", "canceled"]);
const QUEUES = new Set(["normal", "heavy"]);

/** A job as the admin sees it: times as ISO strings, the payload masked when it is sensitive. */
export function jobView(j: JobRow, full = false) {
  const iso = (v: number | null) => (v === null || v === undefined ? null : new Date(v).toISOString());
  const masked = j.sensitive;
  return {
    id: j.id,
    queue: j.queue,
    name: j.name,
    status: j.status,
    error: j.error,
    errorCode: j.errorCode,
    priority: j.priority,
    attempts: j.attempts,
    maxAttempts: j.maxAttempts,
    node: j.node,
    leaseUntil: iso(j.leaseUntil),
    runAt: iso(j.runAt),
    expiresAt: iso(j.expiresAt),
    schedule: j.schedule,
    dedupe: j.dedupe,
    traceId: j.traceId,
    cancel: j.cancel,
    isolate: j.isolate,
    created: iso(j.created),
    started: iso(j.started),
    finished: iso(j.finished),
    ...(full
      ? {
        payload: masked ? (j.payload === null ? null : "***") : j.payload,
        result: j.result,
        history: j.history,
        historyDropped: j.historyDropped,
        timeoutMs: j.timeoutMs,
        leaseMs: j.leaseMs,
        backoffMs: j.backoffMs,
        idem: j.idem ? "***" : null,
      }
      : {}),
  };
}

/** The queue's admin API (§14), superusers only. */
export function queueRoutes(app: Hono<AppEnv>, ctx: Ctx): void {
  app.use("/api/queue/*", async (c, next) => (requireSuperuser(c), await next()));
  app.get("/api/queue/health", (c) => {
    // The scheduler is a long service (it can be stopped, or go fatal): with none running on a live node no schedule
    // is enqueued, so the queue's health shows it as an alarm (§18).
    const sched = ctx.services().all().filter((s) => s.name === SCHEDULER && s.alive !== false);
    const scheduler = !sched.length
      ? null
      : sched.some((s) => s.state === "running")
      ? "running"
      : sched.some((s) => s.state === "fatal")
      ? "fatal"
      : sched[0].state;
    return c.json({ ...ctx.queue.health(), scheduler });
  });
  app.get("/api/queue/jobs", (c) => {
    const q = c.req.query();
    const r = ctx.queue.list({
      status: STATUSES.has(q.status) ? q.status as JobStatus : undefined,
      queue: QUEUES.has(q.queue) ? q.queue as QueueName : undefined,
      name: q.name || undefined,
      schedule: q.schedule || undefined,
      errorCode: q.errorCode || undefined,
      page: Number(q.page) || 1,
      perPage: Number(q.perPage) || 30,
    });
    const counts = statusCounts(ctx.queue.deps.db, {
      queue: QUEUES.has(q.queue) ? q.queue : undefined,
      name: q.name || undefined,
      schedule: q.schedule || undefined,
    });
    return c.json({ ...r, counts, items: r.items.map((j) => jobView(j)) });
  });
  app.get("/api/queue/jobs/:id", (c) => {
    const j = ctx.queue.get(c.req.param("id"));
    if (!j) throw notFound();
    return c.json(jobView(j, true));
  });
  app.post("/api/queue/jobs/:id/retry", async (c) => c.json(jobView(await ctx.queue.retry(c.req.param("id")), true)));
  app.post("/api/queue/jobs/:id/cancel", async (c) => c.json(jobView(await ctx.queue.cancel(c.req.param("id")), true)));
  app.delete("/api/queue/jobs/:id", async (c) => {
    await ctx.queue.remove(c.req.param("id"));
    return c.body(null, 204);
  });
  /** The crons page: each schedule with its newest jobs and the day's counts. */
  app.get("/api/queue/schedules", (c) => {
    const limit = Math.min(50, Math.max(1, Number(c.req.query("limit")) || 10));
    return c.json(
      ctx.queue.scheduleRuns(limit).filter((s) => !WAL_SCHEDULES.includes(s.id)).map((s) => ({
        id: s.id,
        expression: s.expression,
        job: s.job,
        system: s.system,
        runs24h: s.runs24h,
        failed24h: s.failed24h,
        jobs: s.jobs.map((j) => jobView(j)),
      })),
    );
  });
  app.post("/api/queue/schedules/:id/run", async (c) => {
    const t0 = Date.now();
    const j = await ctx.queue.runNow(c.req.param("id"));
    // The dedupe key held by a run still pending or running: that run comes back, made before this request.
    return c.json({ ...jobView(j), existing: j.created < t0 });
  });
}
