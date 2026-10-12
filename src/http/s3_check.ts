import type { Hono } from "hono";
import type { AppEnv, Ctx } from "./app.ts";
import { requireSuperuser } from "./guards.ts";
import { readBody } from "./form.ts";
import { badRequest, type ErrorData } from "../core/errors.ts";
import { checkS3 } from "../files/s3/check.ts";
import type { S3Config } from "../settings/model.ts";

const str = (v: unknown) => (typeof v === "string" ? v.trim() : "");

/**
 * Staged check of an unsaved S3 config (not a PB API: the admin UI checks a draft before it is saved, where PB's
 * POST /api/settings/test/s3 only tests the saved one).
 */
export function s3CheckRoutes(app: Hono<AppEnv>, ctx: Ctx): void {
  const path = "/api/_denobase/s3/check";
  app.use(path, async (c, next) => (requireSuperuser(c), await next()));
  app.post(path, async (c) => {
    let b: Record<string, unknown>;
    try {
      b = await readBody(c);
    } catch {
      throw badRequest("An error occurred while loading the submitted data.");
    }
    const fs = b.filesystem;
    if (fs !== "storage" && fs !== "backups") {
      throw badRequest("Failed to check the S3 filesystem.", {
        filesystem: { code: "validation_in_invalid", message: "Must be a valid value." },
      });
    }
    const d = (b.s3 && typeof b.s3 === "object" ? b.s3 : {}) as Record<string, unknown>;
    const saved = fs === "backups" ? ctx.settings.backups.s3 : ctx.settings.s3;
    const cfg: S3Config = {
      enabled: true,
      endpoint: str(d.endpoint),
      bucket: str(d.bucket),
      region: str(d.region),
      accessKey: str(d.accessKey),
      secret: str(d.secret),
      forcePathStyle: d.forcePathStyle === true,
    };
    // The secret never leaves the server, so a draft leaves it empty; it stays bound to the key it was saved with.
    if (!cfg.secret && saved.secret && cfg.accessKey === saved.accessKey) cfg.secret = saved.secret;
    const errs: ErrorData = {};
    for (const k of ["bucket", "region", "accessKey", "secret"] as const) {
      if (!cfg[k]) errs[k] = { code: "validation_required", message: "Cannot be blank." };
    }
    if (Object.keys(errs).length) throw badRequest("Failed to check the S3 filesystem.", errs);
    return c.json(await checkS3(cfg));
  });
}
