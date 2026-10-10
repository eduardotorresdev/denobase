import type { Context, Hono } from "hono";
import type { AppEnv } from "../http/app.ts";
import { realIp } from "../http/logs.ts";
import { signToken } from "../auth/jwt.ts";
import type { OAuthCtx } from "./context.ts";
import { authenticateClient, touchClient } from "./clients.ts";
import { randomToken, safeEqual, sha256, verifyS256 } from "./pkce.ts";
import { OFFLINE_ACCESS, splitScope } from "./scopes.ts";
import { grantActive, revokeGrant } from "./tables.ts";
import { canonicalResource, formOf } from "./flow.ts";
import { LIMITS } from "./ratelimit.ts";
import { type OAuthClient, OAuthError, type OAuthGrant } from "./types.ts";

const NO_STORE = { "Cache-Control": "no-store", Pragma: "no-cache" };

interface CodeRow {
  codeHash: string;
  grantId: string;
  clientId: string;
  redirectUri: string;
  codeChallenge: string;
  resource: string;
  scope: string;
  collection: string;
  recordId: string;
  expires: number;
  used: number;
  redirectUriSent: number;
}

interface RefreshRow {
  hash: string;
  grantId: string;
  familyId: string;
  scope: string;
  keyHash: string;
  expires: number;
  consumedAt: number | null;
}

/** An OAuth error as the token endpoints answer it (RFC 6749 §5.2). */
export function oauthErrorResponse(c: Context<AppEnv>, e: unknown): Response {
  if (!(e instanceof OAuthError)) throw e;
  if (e.error === "invalid_client" && c.req.header("authorization")?.startsWith("Basic ")) {
    c.header("WWW-Authenticate", 'Basic realm="oauth"');
  }
  return c.json({ error: e.error, error_description: e.description }, e.status as 400, NO_STORE);
}

/** POST /oauth/token: authorization_code (PKCE S256) and refresh_token (rotated, reuse revokes the family). */
export function tokenRoutes(app: Hono<AppEnv>, o: OAuthCtx): void {
  app.post("/oauth/token", async (c) => {
    try {
      if (!o.enabled) throw new OAuthError("invalid_request", "Authorization is turned off.", 404);
      const [max, win] = LIMITS.token;
      if (!o.limiter.hit(`token:${realIp(c, o.http)}`, max, win)) {
        throw new OAuthError("slow_down", "Too many requests.", 429);
      }
      if (!(c.req.header("content-type") ?? "").startsWith("application/x-www-form-urlencoded")) {
        throw new OAuthError("invalid_request", "The body must be application/x-www-form-urlencoded.");
      }
      const form = await formOf(c);
      const client = await authenticateClient(o, c.req.raw.headers, form);
      const type = form.get("grant_type");
      if (type !== "authorization_code" && type !== "refresh_token") {
        throw new OAuthError("unsupported_grant_type", "grant_type must be authorization_code or refresh_token.");
      }
      if (!client.grantTypes.includes(type)) {
        throw new OAuthError("unauthorized_client", `This client may not use ${type}.`);
      }
      const body = type === "authorization_code" ? await byCode(o, client, form) : await byRefresh(o, client, form);
      return c.json(body, 200, NO_STORE);
    } catch (e) {
      return oauthErrorResponse(c, e);
    }
  });
}

const invalidGrant = (msg: string) => new OAuthError("invalid_grant", msg);

async function byCode(o: OAuthCtx, client: OAuthClient, form: URLSearchParams) {
  const code = form.get("code") ?? "";
  if (!code) throw new OAuthError("invalid_request", "code is required.");
  const hash = await sha256(code);
  const row = o.db.prepare(`SELECT * FROM _oauth_codes WHERE codeHash = ?`).get(hash) as CodeRow | undefined;
  if (!row) throw invalidGrant("Invalid authorization code.");
  // Everything that proves the caller is the client the code was issued to comes first: someone who only saw the
  // code (a log, a Referer) must neither burn it nor, by replaying it, revoke the user's authorization.
  if (row.clientId !== client.id) throw invalidGrant("The code was issued to another client.");
  if (!(await verifyS256(form.get("code_verifier") ?? "", row.codeChallenge))) {
    throw invalidGrant("PKCE verification failed.");
  }
  // RFC 9700 §4.14: a code replayed with its verifier means it leaked; everything issued from it goes.
  const replayed = () => (revokeGrant(o.db, row.grantId), invalidGrant("Invalid authorization code."));
  if (row.used) throw replayed();
  if (row.expires < Date.now()) throw invalidGrant("The authorization code expired.");
  // Required only when the authorization request carried it (RFC 6749 §4.1.3).
  const redirectUri = form.get("redirect_uri");
  if ((redirectUri !== null || row.redirectUriSent) && redirectUri !== row.redirectUri) {
    throw invalidGrant("redirect_uri does not match.");
  }
  const resource = form.get("resource");
  if (resource && canonicalResource(resource) !== canonicalResource(row.resource)) {
    throw new OAuthError("invalid_target", "resource does not match.");
  }
  // Atomic single use: only the request that flips used gets the code; a concurrent one is a replay.
  const claimed = o.db.prepare(`UPDATE _oauth_codes SET used = 1 WHERE codeHash = ? AND used = 0`).run(hash);
  if (Number(claimed.changes) !== 1) throw replayed();
  const grant = activeGrant(o, row.grantId);
  return await issue(o, client, grant, splitScope(row.scope), randomToken(16), splitScope(row.scope));
}

async function byRefresh(o: OAuthCtx, client: OAuthClient, form: URLSearchParams) {
  const token = form.get("refresh_token") ?? "";
  if (!token) throw new OAuthError("invalid_request", "refresh_token is required.");
  const hash = await sha256(token);
  const row = o.db.prepare(`SELECT * FROM _oauth_refresh_tokens WHERE hash = ?`).get(hash) as RefreshRow | undefined;
  if (!row) throw invalidGrant("Invalid refresh token.");
  const grant = o.db.prepare(`SELECT * FROM _oauth_grants WHERE id = ?`).get(row.grantId) as OAuthGrant | undefined;
  // Checked before consuming, so another client cannot burn someone's token.
  if (!grant || grant.clientId !== client.id) throw invalidGrant("Invalid refresh token.");
  // RFC 9700 §4.14.2: a reused refresh token may have been stolen, and the thief may already hold an access token of
  // this grant, so the whole authorization goes, not only this family.
  const reused =
    () => (revokeGrant(o.db, grant.id), invalidGrant("Refresh token reused; the authorization was revoked."));
  if (row.consumedAt !== null) throw reused();
  if (row.expires < Date.now()) throw invalidGrant("The refresh token expired.");
  // A bad request must not spend the token (a retry would then look like reuse and revoke everything).
  const have = splitScope(row.scope);
  const asked = form.get("scope");
  const scopes = asked === null ? have : splitScope(asked);
  if (!scopes.length || scopes.some((s) => !have.includes(s))) {
    throw new OAuthError("invalid_scope", "A refresh may only keep or narrow the scope.");
  }
  const claimed = o.db.prepare(
    `UPDATE _oauth_refresh_tokens SET consumedAt = ? WHERE hash = ? AND consumedAt IS NULL`,
  ).run(Date.now(), hash);
  if (Number(claimed.changes) !== 1) throw reused();
  activeGrant(o, grant.id);
  const cred = o.http.s.credentials(o.db, grant.collection, { id: grant.recordId });
  if (!cred || !safeEqual(await sha256(cred.tokenKey), row.keyHash)) {
    o.db.prepare(`DELETE FROM _oauth_refresh_tokens WHERE familyId = ?`).run(row.familyId);
    throw invalidGrant("The user's credentials changed; authorize again.");
  }
  // The new refresh token keeps the family's scope (RFC 6749 §6): narrowing applies to this access token only.
  return await issue(o, client, grant, scopes, row.familyId, have);
}

function activeGrant(o: OAuthCtx, id: string): OAuthGrant {
  if (!grantActive(o.db, id)) throw invalidGrant("The authorization was revoked.");
  return o.db.prepare(`SELECT * FROM _oauth_grants WHERE id = ?`).get(id) as unknown as OAuthGrant;
}

/**
 * The access token is the app's own auth JWT (signed with the record's tokenKey, so a password change kills it),
 * non-refreshable, with aud = the resource and the scope/cid/gid claims; the refresh token is opaque and stored
 * hashed, tied to the tokenKey it was issued under, and carries `refreshScope` (the family's, never narrowed).
 */
async function issue(
  o: OAuthCtx,
  client: OAuthClient,
  grant: OAuthGrant,
  scopes: string[],
  familyId: string,
  refreshScope: string[],
) {
  const cred = o.http.s.credentials(o.db, grant.collection, { id: grant.recordId });
  if (!cred) throw invalidGrant("The user no longer exists.");
  const scope = scopes.join(" ");
  const ttl = o.settings.accessTokenTTL;
  const access = await signToken(grant.collection, cred, "auth", {
    ttl,
    refreshable: false,
    aud: grant.resource,
    oauth: { scope, cid: client.id, gid: grant.id },
  });
  const wantsRefresh = client.grantTypes.includes("refresh_token") &&
    (refreshScope.includes(OFFLINE_ACCESS) || o.opts.refreshWithoutOfflineAccess);
  let refresh: string | undefined;
  const now = Date.now();
  if (wantsRefresh) {
    refresh = randomToken();
    o.db.prepare(
      `INSERT INTO _oauth_refresh_tokens (hash, grantId, familyId, scope, keyHash, expires, created)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      await sha256(refresh),
      grant.id,
      familyId,
      refreshScope.join(" "),
      await sha256(cred.tokenKey),
      now + o.settings.refreshTokenTTL * 1000,
      now,
    );
  }
  o.db.prepare(`UPDATE _oauth_grants SET lastUsed = ? WHERE id = ?`).run(new Date(now).toISOString(), grant.id);
  touchClient(o.db, client.id);
  return {
    access_token: access,
    token_type: "Bearer",
    expires_in: ttl,
    ...(refresh ? { refresh_token: refresh } : {}),
    scope,
  };
}
