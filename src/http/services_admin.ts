import type { Hono } from "hono";
import type { AppEnv, Ctx } from "./app.ts";
import { requireSuperuser } from "./guards.ts";

/** The long services (§18), superusers only: every node's, and start/stop/restart on the serve answering. */
export function serviceRoutes(app: Hono<AppEnv>, ctx: Ctx): void {
  app.use("/api/services", async (c, next) => (requireSuperuser(c), await next()));
  app.use("/api/services/*", async (c, next) => (requireSuperuser(c), await next()));
  app.get("/api/services", (c) => {
    // A socket outside pb_data (pb_data too deep for a socket address): only processes on this host's temp dir reach
    // it; a worker in another container sharing pb_data does not.
    const dir = ctx.backups?.dataDir;
    const items = ctx.services().all().map((v) => ({
      ...v,
      socketOutside: !!(dir && v.addr && !v.addr.startsWith(`${dir}/`)),
    }));
    return c.json({ now: Date.now(), node: ctx.services().nodeId, items });
  });
  for (const op of ["start", "stop", "restart"] as const) {
    app.post(`/api/services/:name/${op}`, async (c) => c.json(await ctx.services()[op](c.req.param("name"))));
  }
}
