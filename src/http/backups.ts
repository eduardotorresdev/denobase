import type { Hono } from "hono";
import type { AppEnv, Ctx } from "./app.ts";
import { badRequest, forbidden } from "../core/errors.ts";
import { verifyToken } from "../auth/jwt.ts";
import { backupName, isZip, validKey } from "../backups/mod.ts";
import { requireSuperuser } from "./guards.ts";

const NAME = /^[a-z0-9_-]+\.zip$/;

/** PB backup routes. Without a pb_data dir (tests, in-memory dbs) every call answers PB's filesystem error. */
export function backupRoutes(app: Hono<AppEnv>, ctx: Ctx): void {
  const fs = () => {
    if (!ctx.backups) throw badRequest("Failed to load backups filesystem.");
    return ctx.backups;
  };

  app.get("/api/backups", async (c) => {
    requireSuperuser(c);
    return c.json(await fs().list());
  });

  app.post("/api/backups", async (c) => {
    requireSuperuser(c);
    const b = fs();
    if (b.active) throw badRequest("Try again later - another backup/restore process has already been started");
    let body: { name?: unknown } = {};
    const text = await c.req.text();
    if (text.trim()) {
      try {
        body = JSON.parse(text);
      } catch {
        throw badRequest("An error occurred while loading the submitted data.");
      }
    }
    let name = typeof body.name === "string" ? body.name : "";
    if (name) {
      let error: { code: string; message: string } | null = null;
      if (name.length > 150) {
        error = { code: "validation_length_too_long", message: "The length must be no more than 150." };
      } else if (!NAME.test(name)) error = { code: "validation_match_invalid", message: "Must be in a valid format." };
      else if (await b.exists(name)) {
        error = {
          code: "validation_backup_name_exists",
          message: "The backup file name is invalid or already exists.",
        };
      }
      if (error) throw badRequest("An error occurred while validating the submitted data.", { name: error });
    } else name = backupName(ctx.settings.meta.appName, "pb_backup_");
    try {
      await b.create(name);
    } catch (e) {
      console.error("Failed to create backup", name, e);
      throw badRequest("Failed to create backup.");
    }
    return c.body(null, 204);
  });

  app.post("/api/backups/upload", async (c) => {
    requireSuperuser(c);
    const b = fs();
    let file: File | undefined;
    try {
      const v = (await c.req.raw.formData()).get("file");
      if (v instanceof File) file = v;
    } catch { /* missing file below */ }
    const fail = (code: string, message: string) =>
      badRequest("An error occurred while validating the submitted data.", { file: { code, message } });
    if (!file) throw fail("validation_required", "Cannot be blank.");
    const data = new Uint8Array(await file.arrayBuffer());
    if (!isZip(data)) {
      throw fail("validation_invalid_mime_type", `"${file.name}" mime type must be one of: application/zip.`);
    }
    if (!validKey(file.name) || await b.exists(file.name)) {
      throw fail("validation_backup_name_exists", "Backup file with the specified name already exists.");
    }
    try {
      await b.upload(file.name, data);
    } catch {
      throw badRequest("Failed to upload backup.");
    }
    return c.body(null, 204);
  });

  // No auth middleware: a superuser file token in ?token= is the credential, so browsers can download directly.
  app.get("/api/backups/:key", async (c) => {
    const v = await verifyToken(ctx.db, c.req.query("token") ?? "", "file");
    if (!v || v.collection.slug !== "_superusers") throw forbidden("Insufficient permissions to access the resource.");
    const key = c.req.param("key");
    const b = fs();
    if (!(await b.exists(key))) throw badRequest("Missing or invalid backup file.");
    const data = await b.read(key);
    return new Response(data, {
      headers: {
        "Content-Disposition": `attachment; filename=${JSON.stringify(key)}`,
        "Content-Type": "application/zip",
        "Content-Security-Policy": "default-src 'none'; media-src 'self'; style-src 'unsafe-inline'; sandbox",
        "Content-Length": String(data.byteLength),
      },
    });
  });

  app.delete("/api/backups/:key", async (c) => {
    requireSuperuser(c);
    const key = c.req.param("key");
    const b = fs();
    if (b.active === key) throw badRequest("The backup is currently being used and cannot be deleted.");
    if (!(await b.exists(key))) throw badRequest("Invalid or already deleted backup file. Raw error: \nnot found");
    await b.delete(key);
    return c.body(null, 204);
  });

  app.post("/api/backups/:key/restore", async (c) => {
    requireSuperuser(c);
    const b = fs();
    if (b.active) throw badRequest("Try again later - another backup/restore process has already been started.");
    const key = c.req.param("key");
    if (!(await b.exists(key))) throw badRequest("Missing or invalid backup file.");
    // PB answers first and restores a second later, in the background.
    setTimeout(() => b.restore(key).catch((e) => console.error("Failed to restore backup", key, e)), 1000);
    return c.body(null, 204);
  });
}
