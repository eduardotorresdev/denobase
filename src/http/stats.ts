import type { Hono } from "hono";
import type { DatabaseSync } from "node:sqlite";
import type { AppEnv, Ctx } from "./app.ts";
import { requireSuperuser } from "./guards.ts";

/** Size in bytes of the main db file, or null for :memory: and whatever cannot be stat'ed (the path stays private). */
export function dbSizeBytes(db: DatabaseSync): number | null {
  try {
    const rows = db.prepare("PRAGMA database_list").all() as { name: string; file: string }[];
    const file = rows.find((r) => r.name === "main")?.file;
    if (!file) return null;
    return Deno.statSync(file).size;
  } catch {
    return null;
  }
}

/** Host and process figures for the admin dashboard (Denobase-only; PB has none). */
export function statsPayload(ctx: Ctx): Record<string, unknown> {
  let loadavg: number[] = [];
  try {
    loadavg = Deno.loadavg();
  } catch { /* permission or platform without it */ }
  let memory: { total: number; free: number; available: number } | null = null;
  try {
    const m = Deno.systemMemoryInfo();
    memory = { total: m.total, free: m.free, available: m.available };
  } catch { /* permission or platform without it */ }
  let hostname = "";
  try {
    hostname = Deno.hostname();
  } catch { /* permission */ }
  const p = Deno.memoryUsage();
  return {
    hostname,
    os: Deno.build.os,
    arch: Deno.build.arch,
    deno: Deno.version.deno,
    uptimeSec: performance.now() / 1000,
    cpus: navigator.hardwareConcurrency,
    loadavg,
    memory,
    process: { rss: p.rss, heapTotal: p.heapTotal, heapUsed: p.heapUsed },
    collections: ctx.collections.length,
    dbSizeBytes: dbSizeBytes(ctx.db),
    traces: tracesSummary(ctx),
  };
}

/** The 24h trace figures, computed at most once per SUMMARY_TTL_MS however often the dashboard polls. */
const SUMMARY_TTL_MS = 30_000;
const summaries = new WeakMap<object, { at: number; value: { count24h: number; errors24h: number; p95: number } }>();
function tracesSummary(ctx: Ctx) {
  const hit = summaries.get(ctx.traces);
  if (hit && performance.now() - hit.at < SUMMARY_TTL_MS) return hit.value;
  const s = ctx.traces.summary(new Date(Date.now() - 86_400_000));
  const value = { count24h: s.count, errors24h: s.errors, p95: s.p95 };
  summaries.set(ctx.traces, { at: performance.now(), value });
  return value;
}

/** The dashboard's 24h request traffic, scanned at most once per SUMMARY_TTL_MS however often it is opened. */
const traffics = new WeakMap<object, { at: number; value: ReturnType<Ctx["logs"]["traffic"]> }>();
export function trafficPayload(ctx: Ctx) {
  const hit = traffics.get(ctx.logs);
  if (hit && performance.now() - hit.at < SUMMARY_TTL_MS) return hit.value;
  const value = ctx.logs.traffic(new Date(Date.now() - 86_400_000));
  traffics.set(ctx.logs, { at: performance.now(), value });
  return value;
}

/** GET /api/_denobase/stats and /api/_denobase/traffic, superuser-only. */
export function statsRoutes(app: Hono<AppEnv>, ctx: Ctx): void {
  app.get("/api/_denobase/stats", (c) => {
    requireSuperuser(c);
    return c.json(statsPayload(ctx));
  });
  app.get("/api/_denobase/traffic", (c) => {
    requireSuperuser(c);
    return c.json(trafficPayload(ctx));
  });
}
