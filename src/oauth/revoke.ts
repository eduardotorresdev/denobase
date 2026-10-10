import type { Hono } from "hono";
import type { AppEnv } from "../http/app.ts";
import { tokenClaims, verifyToken } from "../auth/jwt.ts";
import type { OAuthCtx } from "./context.ts";
import { authenticateClient } from "./clients.ts";
import { sha256 } from "./pkce.ts";
import { grantActive, revokeGrant } from "./tables.ts";
import { formOf } from "./flow.ts";
import { realIp } from "../http/logs.ts";
import { LIMITS } from "./ratelimit.ts";
import { oauthErrorResponse } from "./token.ts";
import { type OAuthClient, OAuthError, type OAuthGrant } from "./types.ts";

const NO_STORE = { "Cache-Control": "no-store" };

/** POST /oauth/revoke (RFC 7009) and, when enabled, POST /oauth/introspect (RFC 7662). */
export function revokeRoutes(app: Hono<AppEnv>, o: OAuthCtx): void {
  app.post("/oauth/revoke", async (c) => {
    let client: OAuthClient;
    const form = await formOf(c);
    try {
      if (!o.enabled) throw new OAuthError("invalid_request", "Authorization is turned off.", 404);
      // Same budget as /oauth/token: every call hashes and may verify a JWT.
      if (!o.limiter.hit(`revoke:${realIp(c, o.http)}`, ...LIMITS.token)) {
        throw new OAuthError("slow_down", "Too many requests.", 429);
      }
      client = await authenticateClient(o, c.req.raw.headers, form);
    } catch (e) {
      return oauthErrorResponse(c, e);
    }
    const token = form.get("token") ?? "";
    // RFC 7009 §2.2: an unknown, foreign or already revoked token is still 200.
    if (token) await revoke(o, client, token);
    return c.body(null, 200, NO_STORE);
  });

  if (!o.opts.introspection) return;
  app.post("/oauth/introspect", async (c) => {
    if (!o.enabled) return c.json({ error: "invalid_request" }, 404);
    if (!o.limiter.hit(`introspect:${realIp(c, o.http)}`, ...LIMITS.token)) {
      return c.json({ error: "slow_down" }, 429);
    }
    const form = await formOf(c);
    const su = c.get("user")?.collection === "_superusers";
    if (!su) {
      try {
        const client = await authenticateClient(o, c.req.raw.headers, form);
        if (client.authMethod === "none") throw new OAuthError("invalid_client", "Confidential clients only.", 401);
      } catch (e) {
        return oauthErrorResponse(c, e);
      }
    }
    return c.json(await introspect(o, form.get("token") ?? "", o.issuer(c)), 200, NO_STORE);
  });
}

async function revoke(o: OAuthCtx, client: OAuthClient, token: string): Promise<void> {
  const row = o.db.prepare(
    `SELECT r.familyId, g.clientId FROM _oauth_refresh_tokens r JOIN _oauth_grants g ON g.id = r.grantId
     WHERE r.hash = ?`,
  ).get(await sha256(token)) as { familyId: string; clientId: string } | undefined;
  if (row) {
    if (row.clientId === client.id) {
      o.db.prepare(`DELETE FROM _oauth_refresh_tokens WHERE familyId = ?`).run(row.familyId);
    }
    return;
  }
  // An access token is stateless: revoking it revokes its grant (gid), which /api/mcp checks on every request.
  const claims = tokenClaims(token);
  if (!claims.gid || claims.cid !== client.id) return;
  if (await verifyToken(o.db, token, "auth")) revokeGrant(o.db, claims.gid);
}

async function introspect(o: OAuthCtx, token: string, iss: string): Promise<Record<string, unknown>> {
  const inactive = { active: false };
  if (!token) return inactive;
  const r = o.db.prepare(`SELECT * FROM _oauth_refresh_tokens WHERE hash = ?`).get(await sha256(token)) as
    | { grantId: string; scope: string; expires: number; consumedAt: number | null }
    | undefined;
  if (r) {
    if (r.consumedAt !== null || r.expires < Date.now() || !grantActive(o.db, r.grantId)) return inactive;
    const g = o.db.prepare(`SELECT * FROM _oauth_grants WHERE id = ?`).get(r.grantId) as unknown as OAuthGrant;
    return {
      active: true,
      token_type: "refresh_token",
      scope: r.scope,
      client_id: g.clientId,
      sub: g.recordId,
      aud: g.resource,
      iss,
      exp: Math.floor(r.expires / 1000),
    };
  }
  const v = await verifyToken(o.db, token, "auth");
  if (!v?.claims.gid || !grantActive(o.db, v.claims.gid)) return inactive;
  return {
    active: true,
    token_type: "Bearer",
    scope: v.claims.scope ?? "",
    client_id: v.claims.cid,
    sub: v.claims.id,
    aud: v.claims.aud,
    iss,
    exp: v.claims.exp,
  };
}
