import type { Hono } from "hono";
import type { AppEnv, Ctx } from "./app.ts";
import { badRequest, forbidden } from "../core/errors.ts";
import { verifyToken } from "../auth/jwt.ts";
import { backupName, isZip, validKey } from "../backups/mod.ts";
import { requireSuperuser } from "./guards.ts";
import { serveContent } from "./serve_content.ts";
import { boundaryOf, spoolMultipart } from "../files/spool.ts";

const NAME = /^[a-z0-9_-]+\.zip$/;

/** The first n bytes, read from the stream: a SpooledFile's bytes are on disk, so slice() would see none. */
async function head(file: File, n: number): Promise<Uint8Array> {
  const out = new Uint8Array(n);
  let got = 0;
  const reader = file.stream().getReader();
  try {
    while (got < n) {
      const r = await reader.read();
      if (r.done) break;
      const take = r.value.subarray(0, n - got);
      out.set(take, got);
      got += take.length;
    }
  } finally {
    await reader.cancel().catch(() => {});
  }
  return out.subarray(0, got);
}

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
    // Spooled to a temp file as it arrives: formData() would hold a multi-GB zip in memory.
    const boundary = boundaryOf(c.req.header("Content-Type") ?? "");
    try {
      const v = boundary
        ? (await spoolMultipart(c.req.raw.body, boundary, () => Number.MAX_SAFE_INTEGER)).get("file")
        : null;
      if (v instanceof File) file = v;
    } catch { /* missing file below */ }
    const fail = (code: string, message: string) =>
      badRequest("An error occurred while validating the submitted data.", { file: { code, message } });
    if (!file) throw fail("validation_required", "Cannot be blank.");
    // Only the magic is sniffed in memory; the zip itself streams to the store (a file, or an S3 multipart upload).
    if (!isZip(await head(file, 4))) {
      throw fail("validation_invalid_mime_type", `"${file.name}" mime type must be one of: application/zip.`);
    }
    if (!validKey(file.name) || await b.exists(file.name)) {
      throw fail("validation_backup_name_exists", "Backup file with the specified name already exists.");
    }
    try {
      await b.upload(file.name, file.stream());
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
    const info = await b.stat(key).catch(() => null);
    if (!info) throw badRequest("Missing or invalid backup file.");
    // PB serves backups through fsys.Serve (http.ServeContent): Range, Last-Modified, conditional requests.
    return await serveContent({
      request: c.req.raw,
      info,
      headers: new Headers({
        "Content-Disposition": `attachment; filename=${JSON.stringify(key)}`,
        "Content-Type": "application/zip",
        "Content-Security-Policy": "default-src 'none'; media-src 'self'; style-src 'unsafe-inline'; sandbox",
      }),
      open: async (range) => (await b.get(key, { range }))?.body ?? null,
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
