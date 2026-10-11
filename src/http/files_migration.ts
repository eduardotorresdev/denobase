import type { Hono } from "hono";
import type { AppEnv, Ctx } from "./app.ts";
import { requireSuperuser } from "./guards.ts";
import { readBody } from "./form.ts";
import { badRequest } from "../core/errors.ts";

/**
 * Superuser controls of the files migration (not a PB API: PB leaves moving files to the operator). Progress also goes
 * out on the realtime topic FILES_MIGRATION_TOPIC.
 */
export function filesMigrationRoutes(app: Hono<AppEnv>, ctx: Ctx): void {
  const base = "/api/_denobase/files-migration";
  app.use(base, async (c, next) => (requireSuperuser(c), await next()));
  app.use(`${base}/*`, async (c, next) => (requireSuperuser(c), await next()));

  app.get(base, (c) => c.json(ctx.filesMigration.status()));

  app.post(base, async (c) => {
    let b: Record<string, unknown>;
    try {
      b = await readBody(c);
    } catch {
      throw badRequest("An error occurred while loading the submitted data.");
    }
    // The source is always the recorded proposal: credentials of the old bucket never travel through this API.
    return c.json(await ctx.filesMigration.start({ deleteSource: b.deleteSource === true }));
  });

  app.post(`${base}/resume`, (c) => c.json(ctx.filesMigration.resume()));
  app.post(`${base}/cancel`, (c) => c.json(ctx.filesMigration.cancel()));
}
