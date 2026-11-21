import type { Hono } from "hono";
import type { DatabaseSync } from "node:sqlite";
import type { AppEnv, Ctx } from "./app.ts";
import { requireSuperuser } from "./guards.ts";
import { dashboardRoutes } from "./dashboard.ts";

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
  };
}

/** GET /api/_denobase/stats (superuser-only) and the home's card endpoints. */
export function statsRoutes(app: Hono<AppEnv>, ctx: Ctx): void {
  app.get("/api/_denobase/stats", (c) => {
    requireSuperuser(c);
    return c.json(statsPayload(ctx));
  });
  dashboardRoutes(app, ctx);
}
