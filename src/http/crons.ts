import type { Hono } from "hono";
import type { AppEnv, Ctx } from "./app.ts";
import { requireSuperuser } from "./guards.ts";
import { cronList } from "../backups/ops.ts";

/** PB cron routes: list the schedules and run one in the background (it only enqueues, like the scheduler). */
export function cronRoutes(app: Hono<AppEnv>, ctx: Ctx): void {
  app.use("/api/crons", async (c, next) => (requireSuperuser(c), await next()));
  app.use("/api/crons/*", async (c, next) => (requireSuperuser(c), await next()));
  app.get("/api/crons", (c) => c.json(cronList(ctx.queue)));
  app.post("/api/crons/:id", async (c) => {
    await ctx.queue.runNow(c.req.param("id"));
    return c.body(null, 204);
  });
}
