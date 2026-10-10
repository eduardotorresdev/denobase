import type { Hono } from "hono";
import type { AppEnv, Ctx } from "./app.ts";
import { notFound } from "../core/errors.ts";
import { requireSuperuser } from "./guards.ts";

/** PB cron routes: list the jobs and run one in the background. */
export function cronRoutes(app: Hono<AppEnv>, ctx: Ctx): void {
  app.use("/api/crons", async (c, next) => (requireSuperuser(c), await next()));
  app.use("/api/crons/*", async (c, next) => (requireSuperuser(c), await next()));
  app.get("/api/crons", (c) => c.json(ctx.cron.jobs().map((j) => ({ id: j.id, expression: j.expression }))));
  app.post("/api/crons/:id", (c) => {
    const job = ctx.cron.get(c.req.param("id"));
    if (!job) throw notFound("Missing or invalid cron job");
    void job.run("manual");
    return c.body(null, 204);
  });
}
