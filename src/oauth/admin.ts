import type { Hono } from "hono";
import type { AppEnv } from "../http/app.ts";
import { requireSuperuser } from "../http/guards.ts";
import { badRequest, notFound } from "../core/errors.ts";
import { quoteIdent, tableName } from "../schema/mod.ts";
import type { OAuthCtx } from "./context.ts";
import { rowToClient } from "./clients.ts";
import { revokeGrant } from "./tables.ts";
import type { OAuthGrant } from "./types.ts";

/** Superuser API of the admin UI: clients (remove = revoke their grants) and grants (revoke). */
export function adminRoutes(app: Hono<AppEnv>, o: OAuthCtx): void {
  app.use("/api/oauth/*", async (c, next) => (requireSuperuser(c), await next()));

  app.get("/api/oauth/clients", (c) => {
    const counts = new Map(
      (o.db.prepare(
        `SELECT clientId, COUNT(*) AS n FROM _oauth_grants WHERE revokedAt IS NULL GROUP BY clientId`,
      ).all() as { clientId: string; n: number }[]).map((r) => [r.clientId, Number(r.n)]),
    );
    const stored = (o.db.prepare(`SELECT * FROM _oauth_clients ORDER BY created DESC`).all() as Record<
      string,
      unknown
    >[]).map(rowToClient);
    const statics = o.opts.clients.map((s) => o.staticClient(s.id)!.client);
    const items = [...statics, ...stored].map(({ secretHash: _s, ...c }) => ({
      ...c,
      redirectHosts: [...new Set(c.redirectUris.map((u) => URL.canParse(u) ? new URL(u).host : u))],
      activeGrants: counts.get(c.id) ?? 0,
    }));
    return c.json({ items });
  });

  app.delete("/api/oauth/clients/:id", (c) => {
    const id = c.req.param("id");
    if (o.staticClient(id)) throw badRequest("Static clients are configured in code.");
    const row = o.db.prepare(`SELECT id FROM _oauth_clients WHERE id = ?`).get(id);
    if (!row) throw notFound();
    for (const g of o.db.prepare(`SELECT id FROM _oauth_grants WHERE clientId = ?`).all(id) as { id: string }[]) {
      revokeGrant(o.db, g.id);
    }
    o.db.prepare(`DELETE FROM _oauth_clients WHERE id = ?`).run(id);
    return c.body(null, 204);
  });

  app.get("/api/oauth/grants", (c) => {
    const rows = o.db.prepare(`SELECT * FROM _oauth_grants ORDER BY created DESC LIMIT 500`)
      .all() as unknown as OAuthGrant[];
    const names = new Map(
      (o.db.prepare(`SELECT id, name FROM _oauth_clients`).all() as { id: string; name: string }[]).map((r) => [
        r.id,
        r.name,
      ]),
    );
    for (const s of o.opts.clients) names.set(s.id, s.name);
    const email = (col: string, id: string) => {
      try {
        const r = o.db.prepare(`SELECT email FROM ${quoteIdent(tableName(col))} WHERE id = ?`).get(id) as
          | { email: string }
          | undefined;
        return r?.email ?? "";
      } catch {
        return "";
      }
    };
    const items = rows.map((g) => ({
      ...g,
      rememberConsent: !!g.rememberConsent,
      clientName: names.get(g.clientId) ?? "",
      email: email(g.collection, g.recordId),
    }));
    return c.json({ items });
  });

  /** Every live access of one user, at once (a lost laptop, someone leaving). */
  app.delete("/api/oauth/grants", (c) => {
    const collection = c.req.query("collection") ?? "";
    const recordId = c.req.query("recordId") ?? "";
    if (!collection || !recordId) throw badRequest("collection and recordId are required.");
    const ids = o.db.prepare(
      `SELECT id FROM _oauth_grants WHERE collection = ? AND recordId = ? AND revokedAt IS NULL`,
    ).all(collection, recordId) as { id: string }[];
    for (const g of ids) revokeGrant(o.db, g.id);
    return c.json({ revoked: ids.length });
  });

  app.delete("/api/oauth/grants/:id", (c) => {
    const id = c.req.param("id");
    if (!o.db.prepare(`SELECT id FROM _oauth_grants WHERE id = ?`).get(id)) throw notFound();
    revokeGrant(o.db, id);
    return c.body(null, 204);
  });
}
