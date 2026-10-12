import type { Hono } from "hono";
import type { AppEnv, Ctx } from "./app.ts";
import { badRequest } from "../core/errors.ts";
import { mergeSettings, publicSettings, saveSettings, type Settings, validateSettings } from "../settings/mod.ts";
import { renderTemplate, TEMPLATES } from "../auth/templates.ts";
import { readBody } from "./form.ts";
import { requireSuperuser } from "./guards.ts";
import { S3Storage } from "../files/s3/storage.ts";

const ALNUM = "abcdefghijklmnopqrstuvwxyz0123456789";

function randomString(n: number): string {
  const b = crypto.getRandomValues(new Uint8Array(n));
  return Array.from(b, (x) => ALNUM[x % ALNUM.length]).join("");
}

const TEST_TEMPLATES: Record<string, keyof typeof TEMPLATES | undefined> = {
  verification: "verification",
  "password-reset": "resetPassword",
  "email-change": "confirmEmailChange",
  otp: "otp",
  "login-alert": undefined,
};

/** PB settings routes: superuser-only GET/PATCH /api/settings and the test endpoints. */
export function settingsRoutes(app: Hono<AppEnv>, ctx: Ctx): void {
  app.use("/api/settings", async (c, next) => (requireSuperuser(c), await next()));
  app.use("/api/settings/*", async (c, next) => (requireSuperuser(c), await next()));

  app.get("/api/settings", (c) => c.json(publicSettings(ctx.settings)));

  app.patch("/api/settings", async (c) => {
    let body: Record<string, unknown>;
    try {
      body = await readBody(c);
    } catch {
      throw badRequest("An error occurred while loading the submitted data.");
    }
    const next = mergeSettings<Settings>(structuredClone(ctx.settings), body);
    const errs = validateSettings(next);
    if (Object.keys(errs).length) throw badRequest("An error occurred while saving the new settings.", errs);
    const prevS3 = structuredClone(ctx.settings.s3);
    saveSettings(ctx.db, next);
    // Same object everywhere (ctx, app.settings): routes and jobs read the new values from now on.
    Object.assign(ctx.settings, next);
    for (const fn of ctx.onSettingsChange) fn(ctx.settings);
    // The storage files lived on until now: what the UI offers to migrate from.
    await ctx.filesMigration.proposeFrom(prevS3, ctx.settings.s3);
    return c.json(publicSettings(ctx.settings));
  });

  app.post("/api/settings/test/email", async (c) => {
    const b = await readBody(c);
    const email = typeof b.email === "string" ? b.email : "";
    const template = typeof b.template === "string" ? b.template : "";
    const errs: Record<string, { code: string; message: string }> = {};
    if (!email) errs.email = { code: "validation_required", message: "Cannot be blank." };
    else if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
      errs.email = { code: "validation_is_email", message: "Must be a valid email address." };
    }
    if (!template) errs.template = { code: "validation_required", message: "Cannot be blank." };
    else if (!(template in TEST_TEMPLATES)) {
      errs.template = { code: "validation_in_invalid", message: "Must be a valid value." };
    }
    if (Object.keys(errs).length) throw badRequest("Failed to send the test email.", errs);
    const key = TEST_TEMPLATES[template];
    const mail = key
      ? renderTemplate(TEMPLATES[key], ctx.settings.meta, {
        "{TOKEN}": "_test_token_",
        "{OTP}": "123456",
        "{OTP_ID}": "_test_",
      })
      : { subject: "Login from a new location", html: "<p>Test login alert.</p>" };
    try {
      await ctx.mailer.send({ to: email, ...mail });
    } catch (e) {
      throw badRequest(`Failed to send the test email. Raw error: \n${(e as Error).message}`);
    }
    return c.body(null, 204);
  });

  // PB forms.TestS3Filesystem: write and delete a throwaway object with the saved config of that filesystem.
  app.post("/api/settings/test/s3", async (c) => {
    let b: Record<string, unknown>;
    try {
      b = await readBody(c);
    } catch {
      throw badRequest("An error occurred while loading the submitted data.");
    }
    const fs = typeof b.filesystem === "string" ? b.filesystem : "";
    if (!fs) {
      throw badRequest("Failed to test the S3 filesystem.", {
        filesystem: { code: "validation_required", message: "Cannot be blank." },
      });
    }
    if (fs !== "storage" && fs !== "backups") {
      throw badRequest("Failed to test the S3 filesystem.", {
        filesystem: { code: "validation_in_invalid", message: "Must be a valid value." },
      });
    }
    const cfg = fs === "backups" ? ctx.settings.backups.s3 : ctx.settings.s3;
    try {
      if (!cfg.enabled) throw new Error("S3 storage filesystem is not enabled");
      const s3 = new S3Storage(cfg);
      const key = `pb_settings_test/${randomString(5)}.txt`;
      await s3.put(key, new TextEncoder().encode("test"), { type: "text/plain" });
      await s3.delete(key);
    } catch (e) {
      throw badRequest(`Failed to test the S3 filesystem. Raw error: \n${(e as Error).message}`);
    }
    return c.body(null, 204);
  });
  // No OAuth2 providers yet: PB's raw-error answer says so instead of a silent 404.
  app.post("/api/settings/apple/generate-client-secret", () => {
    throw badRequest("Failed to generate client secret. Raw error: \nOAuth2 is not supported by this server.");
  });
}
