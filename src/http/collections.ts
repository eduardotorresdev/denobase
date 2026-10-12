import type { Context, Hono } from "hono";
import type { AppEnv, Ctx } from "./app.ts";
import { badRequest, notFound } from "../core/errors.ts";
import { getCollection } from "../core/registry.ts";
import { exportCollection, scaffolds } from "../collections/export.ts";
import { superuser } from "./guards.ts";
import { collectionValidationError, fieldsOptionsErrors, importValidationError } from "../core/field_options.ts";

type Ctx2 = Context<AppEnv>;

const READ_ONLY = "Collections are declared in code and cannot be changed through the API.";

/**
 * PB collection routes, read-only: collections are declared in code, so list/view/scaffolds answer PB's JSON and
 * every write (create, update, delete, truncate, import) is refused with a 400 that says why.
 */
export function collectionRoutes(app: Hono<AppEnv>, ctx: Ctx): void {
  app.get("/api/collections/meta/scaffolds", superuser, (c) => c.json(scaffolds()));
  // PB lists every OAuth2 provider it can configure; we have none yet, so the UI shows no provider to set up.
  app.get("/api/collections/meta/oauth2-providers", superuser, (c) => c.json([]));

  // Only the collection-level paths: /api/collections/:c/records and the auth routes keep their own guards.
  app.get("/api/collections", superuser, (c) => {
    if (c.req.query("filter")) throw badRequest("Invalid filter format.");
    const all = ctx.collections;
    const desc = (c.req.query("sort") ?? "").startsWith("-");
    const items = [...all].sort((a, b) => a.slug.localeCompare(b.slug) * (desc ? -1 : 1))
      .map((col) => exportCollection(col, all));
    const perPage = Math.min(Math.max(1, Number(c.req.query("perPage")) || 30), 1000);
    const page = Math.max(1, Number(c.req.query("page")) || 1);
    return c.json({
      page,
      perPage,
      totalItems: items.length,
      totalPages: Math.ceil(items.length / perPage),
      items: items.slice((page - 1) * perPage, page * perPage),
    });
  });
  app.get("/api/collections/:c", superuser, (c) => {
    let col;
    try {
      col = getCollection(c.req.param("c"), ctx.collections);
    } catch {
      throw notFound();
    }
    return c.json(exportCollection(col, ctx.collections));
  });

  const refuse = (): never => {
    throw badRequest(READ_ONLY);
  };
  // A body PB would reject for its field settings gets PB's validation error first, so a client sees the same
  // answer it would from PB; only a valid one learns the collection is declared in code.
  const validated = (message: string) => async (c: Ctx2) => {
    const body = await c.req.json().catch(() => null) as { fields?: unknown } | null;
    const errs = fieldsOptionsErrors(body?.fields);
    if (errs) throw collectionValidationError(message, errs);
    refuse();
  };
  app.post("/api/collections", superuser, validated("Failed to create collection."));
  app.put("/api/collections/import", superuser, async (c) => {
    const body = await c.req.json().catch(() => null) as { collections?: unknown } | null;
    const list = Array.isArray(body?.collections) ? body.collections : [];
    for (const col of list as { name?: unknown; id?: unknown; fields?: unknown }[]) {
      const errs = fieldsOptionsErrors(col?.fields);
      if (errs) throw importValidationError(String(col.name ?? ""), String(col.id ?? ""), errs);
    }
    refuse();
  });
  app.patch("/api/collections/:c", superuser, validated("Failed to update collection."));
  app.delete("/api/collections/:c", superuser, refuse);
  app.delete("/api/collections/:c/truncate", superuser, refuse);
}
