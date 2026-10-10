import type { Hono } from "hono";
import type { AppEnv, Ctx } from "./app.ts";
import type { CollectionConfig, Doc } from "../core/types.ts";
import { notFound, unauthorized } from "../core/errors.ts";
import { getCollection } from "../core/registry.ts";
import { findOne } from "../store/sqlite.ts";
import { signToken, verifyToken } from "../auth/jwt.ts";
import { allFields } from "../engine/fields.ts";
import { recordDir } from "../engine/files.ts";

/** PB file routes: POST /api/files/token and GET /api/files/{collection}/{recordId}/{filename}. */

const INLINE = new Set([
  "image/png",
  "image/jpg",
  "image/jpeg",
  "image/gif",
  "image/webp",
  "image/x-icon",
  "image/bmp",
  "video/webm",
  "video/mp4",
  "video/3gpp",
  "video/quicktime",
  "video/x-ms-wmv",
  "audio/basic",
  "audio/aiff",
  "audio/mpeg",
  "audio/midi",
  "audio/mp3",
  "audio/wave",
  "audio/wav",
  "audio/x-wav",
  "audio/x-mpeg",
  "audio/x-m4a",
  "audio/aac",
  "application/pdf",
  "application/x-pdf",
]);

/** By extension when the upload carried no type (and PB's manual overrides). */
const BY_EXT: Record<string, string> = {
  ".svg": "image/svg+xml",
  ".css": "text/css",
  ".js": "text/javascript",
  ".mjs": "text/javascript",
  ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".pdf": "application/pdf",
  ".txt": "text/plain; charset=utf-8",
  ".json": "application/json",
  ".csv": "text/csv",
  ".mp4": "video/mp4",
  ".mp3": "audio/mpeg",
};

function contentType(name: string, uploaded: string): string {
  const ext = name.slice(name.lastIndexOf(".")).toLowerCase();
  const manual = ext === ".svg" || ext === ".css" || ext === ".js" || ext === ".mjs" || ext === ".xlsx";
  if (manual) return BY_EXT[ext];
  return uploaded || BY_EXT[ext] || "application/octet-stream";
}

const truthy = (v: string | undefined) => ["1", "t", "true"].includes((v ?? "").toLowerCase());

export function fileRoutes(app: Hono<AppEnv>, ctx: Ctx): void {
  app.post("/api/files/token", async (c) => {
    const user = c.get("user");
    if (!user) throw unauthorized();
    const cred = ctx.s.credentials(ctx.db, user.collection, { id: user.id });
    if (!cred) throw unauthorized();
    const token = await signToken(user.collection, cred, "file");
    return c.json({ token });
  });

  app.get("/api/files/:c/:id/:filename", async (c) => {
    let col: CollectionConfig;
    try {
      col = getCollection(c.req.param("c"), ctx.collections);
    } catch {
      throw notFound();
    }
    const id = c.req.param("id");
    const filename = c.req.param("filename");
    const doc = findOne(ctx.db, col, id) as Doc | undefined;
    if (!doc) throw notFound();
    const field = allFields(col).find((f) => {
      if (f.type !== "file") return false;
      const v = doc[f.name];
      return Array.isArray(v) ? v.includes(filename) : v === filename;
    });
    if (!field || field.type !== "file") throw notFound();
    if (field.protected) {
      // Only the ?token= file token counts, never the Authorization header (PB RequestInfoContextProtectedFile).
      const v = await verifyToken(ctx.db, c.req.query("token") ?? "", "file");
      const user = v && { id: v.claims.id, collection: v.collection.slug, record: { id: v.claims.id } as Doc };
      try {
        await ctx.s.findById({ collection: col.slug, req: ctx.s.makeReq(ctx.store, user), id });
      } catch {
        throw notFound();
      }
    }
    const stored = await ctx.store.storage.get(recordDir(col, id) + filename);
    if (!stored) throw notFound();
    // Thumbs are not generated yet; PB itself serves the original when a thumb cannot be made.
    const type = contentType(filename, stored.type);
    const disposition = !truthy(c.req.query("download")) && INLINE.has(type.split(";")[0]) ? "inline" : "attachment";
    return new Response(stored.data, {
      headers: {
        "Content-Disposition": `${disposition}; filename=${JSON.stringify(filename)}`,
        "Content-Type": type,
        "Content-Security-Policy": "default-src 'none'; media-src 'self'; style-src 'unsafe-inline'; sandbox",
        "Cache-Control": "max-age=2592000, stale-while-revalidate=86400",
        "Content-Length": String(stored.data.byteLength),
      },
    });
  });
}
