import type { Hono } from "hono";
import type { AppEnv, Ctx } from "./app.ts";
import { notFound } from "../core/errors.ts";
import { requireSuperuser } from "./guards.ts";

const int = (v: string | undefined) => (v && /^\d+$/.test(v) ? Number(v) : undefined);
const TRACE_ID = /^[0-9a-f]{32}$/;

/**
 * Denobase-only traces API (PB has none), shaped like the logs API: superuser-only list, stats, view, truncate.
 * The tracing middleware skips these paths, so reading traces never records new ones.
 */
export function traceRoutes(app: Hono<AppEnv>, ctx: Ctx): void {
  app.use("/api/traces", async (c, next) => (requireSuperuser(c), await next()));
  app.use("/api/traces/*", async (c, next) => (requireSuperuser(c), await next()));
  app.get("/api/traces", (c) => {
    const q = c.req.query();
    return c.json(
      ctx.traces.listTraces({ filter: q.filter, sort: q.sort, page: int(q.page), perPage: int(q.perPage) }),
    );
  });
  app.delete("/api/traces", (c) => {
    ctx.traces.truncate();
    return c.body(null, 204);
  });
  app.get("/api/traces/stats", (c) => {
    const filter = c.req.query("filter");
    if (c.req.query("groupBy") === "name") return c.json(ctx.traces.slowest(filter));
    if (c.req.query("groupBy") === "total") return c.json(ctx.traces.overall(filter));
    if (c.req.query("groupBy") === "attribute") {
      return c.json(ctx.traces.byAttribute(c.req.query("key") ?? "", filter, int(c.req.query("limit"))));
    }
    return c.json(ctx.traces.stats(filter));
  });
  app.get("/api/traces/:traceId", (c) => {
    const id = c.req.param("traceId").toLowerCase();
    const trace = TRACE_ID.test(id) ? ctx.traces.getTrace(id) : null;
    if (!trace) throw notFound();
    const logs = ctx.logs.list({ filter: `data.traceId='${id}'`, sort: "created", perPage: 100 }).items;
    return c.json({ ...trace, logs });
  });
}
