import type { Hono } from "hono";
import type { AppEnv, Ctx } from "./app.ts";
import { requireSuperuser } from "./guards.ts";
import { stamp } from "../core/time.ts";
import { selectRows } from "../sql/read.ts";
import { statsPayload } from "./stats.ts";

/**
 * The admin home's reads (Denobase-only; PB has no dashboard), one endpoint per card so a slow one never holds the
 * others: traffic, traces, jobs and the "needs attention" rules. All read rollups or a few indexed rows, and the
 * tracing and request counting skip /api/_denobase/*, so the home never shows up in its own figures.
 */
export function dashboardRoutes(app: Hono<AppEnv>, ctx: Ctx): void {
  app.use("/api/_denobase/*", async (c, next) => (requireSuperuser(c), await next()));
  app.get("/api/_denobase/traffic", (c) => c.json(cached(ctx, "traffic", () => ctx.requests.overview(new Date()))));
  app.get("/api/_denobase/traces", (c) => c.json(cached(ctx, "traces", () => tracesPayload(ctx))));
  app.get("/api/_denobase/jobs", async (c) => c.json(await jobsPayload(ctx)));
  app.get("/api/_denobase/attention", async (c) => c.json(await attentionPayload(ctx)));
}

/** Figures are recomputed at most once per TTL_MS however many tabs poll them. */
const TTL_MS = 15_000;
const caches = new WeakMap<object, Map<string, { at: number; value: unknown }>>();
function cached<T>(ctx: Ctx, key: string, fn: () => T): T {
  let m = caches.get(ctx);
  if (!m) caches.set(ctx, m = new Map());
  const hit = m.get(key);
  if (hit && performance.now() - hit.at < TTL_MS) return hit.value as T;
  const value = fn();
  m.set(key, { at: performance.now(), value });
  return value;
}

const DAY = 86_400_000;

export function tracesPayload(ctx: Ctx) {
  const now = new Date();
  const slowMs = ctx.settings.traces.slowMs;
  return { ...ctx.traces.overview(now), slowMs, problems: ctx.traces.problems(new Date(now.getTime() - DAY), slowMs) };
}

type Run = { status: "ok" | "error"; at: string; duration: number; traceId: string };
type CronRuns = { last: Run | null; runs24h: number; failed24h: number; lastFailure: Run | null };

const toRun = (r: Record<string, unknown> | undefined): Run | null =>
  r
    ? {
      status: Number(r.status) === 2 ? "error" : "ok",
      at: String(r.created),
      duration: Number(r.duration),
      traceId: String(r.traceId),
    }
    : null;

/**
 * A cron job's stored runs: its `cron <id>` roots (cron runs are always kept, whatever the sampling). The last run,
 * and the day's runs and failures, so a job that fails now and then stays visible after a good run. `+root` keeps
 * the planner on (name, created): walking the root index backwards took 100ms+ per job.
 */
function cronRuns(ctx: Ctx, id: string, since: string): CronRuns {
  const name = `cron ${id}`;
  const db = ctx.traces.db;
  const cols = `status, created, duration, "traceId"`;
  const last = db.prepare(`SELECT ${cols} FROM "_spans" WHERE name = ? AND +root = 1 ORDER BY created DESC LIMIT 1`)
    .get(name) as Record<string, unknown> | undefined;
  const day = db.prepare(
    `SELECT COUNT(*) AS n, COALESCE(SUM(status = 2), 0) AS f FROM "_spans" WHERE name = ? AND +root = 1 AND created >= ?`,
  ).get(name, since) as { n: number; f: number };
  const failed24h = Number(day.f);
  const lastFailure = failed24h
    ? toRun(
      db.prepare(
        `SELECT ${cols} FROM "_spans" WHERE name = ? AND +root = 1 AND +status = 2 ORDER BY created DESC LIMIT 1`,
      ).get(name) as Record<string, unknown>,
    )
    : null;
  return { last: toRun(last), runs24h: Number(day.n), failed24h, lastFailure };
}

const AUTO_BACKUP = "__pbAutoBackup__";

export async function jobsPayload(ctx: Ctx) {
  const now = Date.now();
  const since = stamp(new Date(now - DAY));
  const crons = ctx.cron.jobs().map((j) => ({
    id: j.id,
    expression: j.expression,
    system: j.id.startsWith("__"),
    running: j.running,
    ...cronRuns(ctx, j.id, since),
  }));
  let backup: { key: string; size: number; modified: string } | null = null;
  if (ctx.backups) {
    try {
      backup = (await ctx.backups.list()).toSorted((a, b) => (a.modified < b.modified ? 1 : -1))[0] ?? null;
    } catch { /* storage unreachable: the card shows no backup rather than an error */ }
  }
  // Failed mail spans per hour of the last two days, by the (status, created) index: mail.send is usually a child
  // of a request or a cron run, so the root rollup does not have it.
  const mail = ctx.traces.db.prepare(
    `SELECT substr(created, 1, 13) AS hour, COUNT(*) AS n FROM "_spans"
     WHERE status = 2 AND created >= ? AND name = 'mail.send' GROUP BY hour`,
  ).all(stamp(new Date(now - 2 * DAY))) as { hour: string; n: number }[];
  const mailFailed = mail.filter((r) => r.hour >= since.slice(0, 13)).reduce((a, r) => a + Number(r.n), 0);
  return {
    timezone: ctx.settings.meta.timezone || "UTC",
    crons,
    backup: {
      enabled: !!ctx.backups,
      cron: ctx.settings.backups.cron,
      last: backup,
      lastRun: crons.find((j) => j.id === AUTO_BACKUP)?.last ?? null,
    },
    mailFailed24h: mailFailed,
    notificationsFailed24h: notificationsFailed(ctx, since),
    failed: failedJobs(ctx, now, mail),
  };
}

/**
 * Work outside HTTP that failed (cron runs, mail, notifications): this day against the one before, and per hour,
 * for the home's "Failed jobs" figure, which the request figures do not cover.
 */
function failedJobs(ctx: Ctx, now: number, mail: { hour: string; n: number }[]) {
  const mid = stamp(new Date(now - DAY)).slice(0, 13);
  const cron = cached(ctx, "traces", () => tracesPayload(ctx)).cronFailed;
  const byHour = new Map<string, number>();
  let current = cron.current, previous = cron.previous;
  for (const h of cron.hours) byHour.set(h.date.slice(0, 13), h.failed);
  const notif = notificationsFailedByHour(ctx, stamp(new Date(now - 2 * DAY)));
  for (const r of [...mail, ...notif]) {
    if (r.hour < mid) {
      previous += Number(r.n);
      continue;
    }
    current += Number(r.n);
    byHour.set(r.hour, (byHour.get(r.hour) ?? 0) + Number(r.n));
  }
  return {
    current,
    previous,
    hours: [...byHour.entries()].map(([h, failed]) => ({ date: `${h}:00:00.000Z`, failed })),
  };
}

function hasNotifications(ctx: Ctx): boolean {
  return !!ctx.db.prepare(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = '_notifications'`).get();
}

function notificationsFailedByHour(ctx: Ctx, since: string): { hour: string; n: number }[] {
  if (!hasNotifications(ctx)) return [];
  return selectRows<{ hour: string; n: number }>(
    ctx.db,
    `SELECT substr(created, 1, 13) AS hour, COUNT(*) AS n FROM "_notifications"
     WHERE status = 'failed' AND created >= ? GROUP BY hour`,
    [since],
  );
}

/** Failed notifications of the last day, or null when the app has no notifications table. */
function notificationsFailed(ctx: Ctx, since: string): number | null {
  if (!hasNotifications(ctx)) return null;
  const [r] = selectRows<{ n: number }>(
    ctx.db,
    `SELECT COUNT(*) AS n FROM "_notifications" WHERE status = 'failed' AND created >= ?`,
    [since],
  );
  return Number(r?.n ?? 0);
}

export interface AttentionItem {
  id: string;
  severity: "error" | "warning";
  title: string;
  detail?: string;
  at?: string;
  /** Where to act; none for a notice with nothing to open. */
  href?: string;
}

/** Thresholds of the attention rules. */
export const ATTENTION = {
  minRequests: 20,
  errorRate: 0.01,
  p95Ratio: 2,
  resourcePct: 90,
  failedSignIns: 10,
  backupMaxAgeMs: 2 * DAY,
  restartWindowSec: 300,
};

/** What a superuser should act on now; an empty list is "all systems normal". */
export async function attentionPayload(ctx: Ctx): Promise<{ checked: string; items: AttentionItem[] }> {
  const items: AttentionItem[] = [];
  const jobs = await jobsPayload(ctx);
  for (const j of jobs.crons) {
    if (!j.lastFailure) continue;
    // Listed while any run of the day failed: an error while the last run failed, a warning once it recovered.
    const failing = j.last?.status === "error";
    const runs = `${j.failed24h} of ${j.runs24h} run${j.runs24h === 1 ? "" : "s"} in 24h`;
    items.push({
      id: `cron:${j.id}`,
      severity: failing ? "error" : "warning",
      title: `${j.id} failed ${j.failed24h}/${j.runs24h}`,
      detail: failing ? `Last run failed · ${runs}` : `Recovered · ${runs}`,
      at: j.lastFailure.at,
      href: `#/traces/${j.lastFailure.traceId}`,
    });
  }
  if (jobs.backup.enabled) {
    const b = jobs.backup;
    if (b.lastRun?.status === "error") {
      items.push({
        id: "backup:failed",
        severity: "error",
        title: "Backup failed",
        at: b.lastRun.at,
        href: "#/backups",
      });
    } else if (!b.last) {
      items.push({ id: "backup:none", severity: "warning", title: "No backup", href: "#/backups" });
    } else if (Date.now() - new Date(b.last.modified).getTime() > ATTENTION.backupMaxAgeMs) {
      items.push({
        id: "backup:old",
        severity: "warning",
        title: "Backup older than 2d",
        at: b.last.modified,
        href: "#/backups",
      });
    }
  }
  if (jobs.mailFailed24h) {
    items.push({
      id: "mail:failed",
      severity: "error",
      title: `${jobs.mailFailed24h} email${jobs.mailFailed24h === 1 ? "" : "s"} failed`,
      href: `#/traces?filter=${encodeURIComponent('name="mail.send"&&status=2')}`,
    });
  }
  if (jobs.notificationsFailed24h) {
    const n = jobs.notificationsFailed24h;
    items.push({
      id: "notifications:failed",
      severity: "error",
      title: `${n} notification${n === 1 ? "" : "s"} failed`,
      href: "#/notifications",
    });
  }
  const t = ctx.requests.overview(new Date());
  const errs = `#/traces?filter=${encodeURIComponent("kind=1&&status=2")}`;
  if (t.current.total >= ATTENTION.minRequests && t.current.e5xx / t.current.total > ATTENTION.errorRate) {
    items.push({
      id: "http:5xx",
      severity: "error",
      title: `${pct(t.current.e5xx / t.current.total)} 5xx`,
      detail: `${t.current.e5xx} of ${t.current.total}`,
      href: errs,
    });
  } else if (t.lastHour.total >= ATTENTION.minRequests && t.lastHour.e5xx / t.lastHour.total > ATTENTION.errorRate) {
    items.push({
      id: "http:5xx-hour",
      severity: "error",
      title: `${pct(t.lastHour.e5xx / t.lastHour.total)} 5xx · 1h`,
      detail: `${t.lastHour.e5xx} of ${t.lastHour.total}`,
      href: errs,
    });
  }
  const { current: c, previous: p } = t;
  if (
    c.p95 != null && p.p95 != null && c.total >= ATTENTION.minRequests && p.total >= ATTENTION.minRequests &&
    c.p95 > ATTENTION.p95Ratio * p.p95
  ) {
    items.push({
      id: "http:p95",
      severity: "warning",
      title: `p95 ${(c.p95 / p.p95).toFixed(1)}×`,
      detail: `${ms(c.p95)} against ${ms(p.p95)} the previous 24h`,
      href: "#/traces",
    });
  }
  if (t.lastHour.authFailed >= ATTENTION.failedSignIns) {
    items.push({
      id: "auth:failed",
      severity: "warning",
      title: `${t.lastHour.authFailed} failed sign-ins · 1h`,
      // Rejected sign-ins are kept as traces whatever the log level; the link opens them over the last hour.
      href: `#/traces?period=1h&filter=${
        encodeURIComponent('name~"auth-with-"&&attributes.http.response.status_code=400')
      }`,
    });
  }
  const s = statsPayload(ctx) as {
    memory: { total: number; available: number } | null;
    loadavg: number[];
    cpus: number;
    uptimeSec: number;
  };
  // A fresh start is worth seeing: a crash loop otherwise looks like a healthy process.
  if (s.uptimeSec < ATTENTION.restartWindowSec) {
    const m = Math.floor(s.uptimeSec / 60);
    items.push({
      id: "host:restarted",
      severity: "warning",
      title: `Restarted ${m ? `${m}m` : "<1m"} ago`,
    });
  }
  if (s.memory?.total) {
    const used = ((s.memory.total - s.memory.available) / s.memory.total) * 100;
    if (used >= ATTENTION.resourcePct) {
      items.push({ id: "host:memory", severity: "warning", title: `Memory ${used.toFixed(0)}%` });
    }
  }
  // The 5-minute average: the 1-minute one crosses the line back and forth between refreshes and the strip blinks.
  const load5 = s.loadavg?.[1] ?? s.loadavg?.[0];
  if (load5 != null && s.cpus && (load5 / s.cpus) * 100 >= ATTENTION.resourcePct) {
    items.push({
      id: "host:load",
      severity: "warning",
      title: `CPU load ${load5.toFixed(1)} / ${s.cpus}`,
      detail: "5-minute load average / cores",
    });
  }
  items.sort((a, b) => (a.severity === b.severity ? 0 : a.severity === "error" ? -1 : 1));
  return { checked: stamp(new Date()), items };
}

const pct = (x: number) => `${(x * 100).toFixed(x < 0.1 ? 1 : 0)}%`;
const ms = (v: number) => (v >= 1000 ? `${(v / 1000).toFixed(2)}s` : `${v.toFixed(v < 10 ? 1 : 0)}ms`);
