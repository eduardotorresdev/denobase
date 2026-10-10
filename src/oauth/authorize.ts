import type { Hono } from "hono";
import type { AppEnv } from "../http/app.ts";
import { isLoopback, redirectMatches, resolveClient } from "./clients.ts";
import { randomToken, safeEqual, sha256 } from "./pkce.ts";
import { resolveRequestedScopes, splitScope } from "./scopes.ts";
import { bindBrowser, loadSession, sameBrowser, startSession } from "./session.ts";
import { type ConsentData, renderPage } from "./pages.ts";
import { type C, canonicalResource, clientLabel, type Flow } from "./flow.ts";
import { decide, issueCode } from "./consent.ts";
import type { OAuthClient, OAuthGrant, OAuthRequest, OAuthSession } from "./types.ts";

const TXN_TTL_MS = 10 * 60 * 1000;
const CHALLENGE = /^[A-Za-z0-9._~-]{43,128}$/;
const PROMPTS = ["login", "consent", "none"];

/**
 * GET /oauth/authorize: validates the client's request, stores it in _oauth_requests (the pages only carry its id,
 * txn) and sends the browser on: login, the consent screen, or straight back with a code. Until the redirect_uri is
 * proven registered, errors are a page; after it, they go back to the client with error, state and iss.
 */
export function authorizeRoutes(app: Hono<AppEnv>, f: Flow): void {
  const o = f.o;
  const m = f.m;

  /**
   * A remembered grant of this user, client and resource covering every requested scope. Never for a loopback
   * redirect nor for a public client that is not configured in code: anyone can start such a request, and without a
   * screen the code would go to whatever listens there (RFC 9700 §4.1.1, RFC 8252 §8.6).
   */
  const remembered = (t: OAuthRequest, s: OAuthSession, client: OAuthClient): boolean => {
    if (!o.settings.rememberConsent || splitScope(t.prompt).includes("consent")) return false;
    if (isLoopback(new URL(t.redirectUri))) return false;
    if (client.kind !== "static" && client.authMethod === "none") return false;
    const g = o.db.prepare(
      `SELECT * FROM _oauth_grants WHERE clientId = ? AND collection = ? AND recordId = ? AND resource = ?`,
    ).get(t.clientId, s.collection, s.recordId, t.resource) as OAuthGrant | undefined;
    if (!g || g.revokedAt || !g.rememberConsent) return false;
    const have = splitScope(g.scope);
    return splitScope(t.scope).every((x) => have.includes(x));
  };

  /** Where a valid request goes next: login, straight to the code (remembered consent), or the consent screen. */
  const proceed = async (c: C, t: OAuthRequest) => {
    const client = await resolveClient(o, t.clientId);
    if (!client) return f.errorPage(c, m.unknownApp, m.appGone);
    const s = await loadSession(o, c, o.issuer(c));
    const prompts = splitScope(t.prompt);
    // A session of another collection does not count for this request: sign in again, with no word as to why.
    const fresh = s && s.collection === t.collection && (!prompts.includes("login") || s.created >= t.created);
    if (!s || !fresh) {
      // Once per request, before any login page: the web app's own session, if the browser has one (prompt=login
      // skips it). It comes back with a handoff code or without one; either way the request remembers it was tried.
      if (!prompts.includes("login")) {
        const web = f.tryWeb(t);
        if (web) return f.away(c, web);
      }
      if (prompts.includes("none")) {
        return f.consumeTxn(t) ? f.backError(c, t, "login_required", "The user is not signed in.") : f.expired(c);
      }
      return f.loginPage(c, t, client);
    }
    const user = f.userOf(s);
    if (!user) return f.loginPage(c, t, client);
    if (remembered(t, s, client)) {
      if (!f.consumeTxn(t)) return f.expired(c);
      const scopes = await decide(f, t, client, user);
      if (!scopes) return f.backError(c, t, "access_denied", "The authorization was refused.");
      return f.back(c, t, { code: await issueCode(f, t, s, scopes) });
    }
    if (prompts.includes("none")) {
      return f.consumeTxn(t)
        ? f.backError(c, t, "consent_required", "The user must approve this application.")
        : f.expired(c);
    }
    const redirect = new URL(t.redirectUri);
    const data: ConsentData = {
      appName: f.appName(),
      txn: t.id,
      csrf: s.csrf,
      client: {
        name: clientLabel(client, m.someApp),
        logoUri: client.logoUri,
        kind: client.kind,
        id: client.kind === "cimd" ? new URL(client.id).host : client.id,
        unverified: client.kind !== "static",
      },
      redirectHost: redirect.host,
      loopback: isLoopback(redirect),
      resource: t.resource,
      scopes: splitScope(t.scope).map((n) => ({
        name: n,
        description: m.scopeText[n] ?? o.scopes.get(n)?.description ?? "",
      })),
      user: { email: String(user.record.email ?? user.id) },
    };
    return f.page(c, renderPage(o.opts, "consent", data), 200, redirect.origin);
  };

  /** Validates the client's request; a Response when it ends here (page or redirect), else the stored txn. */
  const validate = async (c: C, q: Record<string, string>): Promise<Response | OAuthRequest> => {
    const client = await resolveClient(o, q.client_id ?? "");
    if (!client) return f.errorPage(c, m.unknownApp, m.clientIdUnknown);
    let redirectUri = q.redirect_uri;
    if (!redirectUri) {
      if (client.redirectUris.length !== 1) return f.errorPage(c, m.invalidRequest, m.redirectRequired);
      redirectUri = client.redirectUris[0];
    }
    if (!redirectMatches(redirectUri, client.redirectUris) || redirectUri.includes("#")) {
      return f.errorPage(c, m.invalidRedirect, m.redirectNotRegistered);
    }
    const t = { redirectUri, state: typeof q.state === "string" ? q.state : "" };
    const backError = (error: string, description: string) => f.backError(c, t, error, description);
    if (q.response_type !== "code") return backError("unsupported_response_type", "response_type must be code.");
    // state is optional: PKCE already binds the code to the client (OAuth 2.1 §4.1.1); the MCP SDK omits it.
    if (t.state.length > 2000) return backError("invalid_request", "state is too long.");
    if (!client.grantTypes.includes("authorization_code")) {
      return backError("unauthorized_client", "This client may not use the authorization code grant.");
    }
    if (!q.code_challenge || !CHALLENGE.test(q.code_challenge)) {
      return backError("invalid_request", "code_challenge (43 to 128 characters) is required.");
    }
    if (q.code_challenge_method !== "S256") return backError("invalid_request", "code_challenge_method must be S256.");
    // Clients spell the canonical URI differently (trailing slash, upper-case host, :443); keep ours.
    const asked = q.resource ? canonicalResource(q.resource) : null;
    const resource = q.resource ? o.resources(c).find((r) => canonicalResource(r) === asked) : o.resource(c);
    if (!resource || (q.resource && !asked)) return backError("invalid_target", "Unknown resource.");
    const scopes = resolveRequestedScopes(q.scope, o.scopes, client.scope);
    if (!scopes) return backError("invalid_scope", "Unknown or not allowed scope.");
    const prompt = splitScope(q.prompt);
    if (prompt.some((p) => !PROMPTS.includes(p)) || (prompt.includes("none") && prompt.length > 1)) {
      return backError("invalid_request", "Unsupported prompt.");
    }
    if (!o.collections().length) return backError("server_error", "No collection may authorize.");
    // Who starts the request picks the collection; the login page never shows nor changes it.
    const fixed = client.authCollection;
    if (fixed && q.auth_collection && q.auth_collection !== fixed) {
      return backError("invalid_request", "auth_collection does not match this client.");
    }
    const col = o.authCollection(fixed || q.auth_collection);
    if (!col) return backError("invalid_request", "auth_collection may not authorize.");
    const now = Date.now();
    const row: OAuthRequest = {
      id: randomToken(),
      clientId: client.id,
      redirectUri,
      state: t.state,
      codeChallenge: q.code_challenge,
      resource,
      scope: scopes.join(" "),
      prompt: prompt.join(" "),
      created: now,
      expires: now + TXN_TTL_MS,
      consumed: 0,
      redirectUriSent: q.redirect_uri ? 1 : 0,
      csrf: randomToken(),
      bindHash: await bindBrowser(c, o.issuer(c)),
      collection: col.slug,
      webTried: 0,
    };
    o.db.prepare(
      `INSERT INTO _oauth_requests (id, clientId, redirectUri, state, codeChallenge, resource, scope, prompt, created,
        expires, redirectUriSent, csrf, bindHash, collection) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      row.id,
      row.clientId,
      row.redirectUri,
      row.state,
      row.codeChallenge,
      row.resource,
      row.scope,
      row.prompt,
      row.created,
      row.expires,
      row.redirectUriSent,
      row.csrf,
      row.bindHash,
      row.collection,
    );
    return row;
  };

  /**
   * A handoff code (POST /oauth/handoff) turns into this browser's session: single use, for this request only, and
   * only in the browser that opened it, so a code someone else obtained cannot sign this browser in to their account.
   */
  const redeem = async (c: C, t: OAuthRequest, code: string): Promise<boolean> => {
    const key = await sha256(code);
    const h = f.handoffs.get(key);
    f.handoffs.delete(key);
    const iss = o.issuer(c);
    if (
      !h || splitScope(t.prompt).includes("login") || h.expires < Date.now() || !safeEqual(h.txn, t.id) ||
      h.collection !== t.collection ||
      !(await sameBrowser(c, iss, t.bindHash))
    ) {
      return false;
    }
    const cred = o.http.s.credentials(o.db, h.collection, { id: h.recordId });
    if (!cred) return false;
    await startSession(o, c, iss, h.collection, cred.id, cred.tokenKey);
    return true;
  };

  app.get("/oauth/authorize", async (c) => {
    if (!o.enabled) return f.off(c);
    const q = c.req.query();
    if (q.txn && !q.client_id) {
      const t = f.loadTxn(q.txn);
      if (!t) return f.expired(c);
      if (q.handoff) {
        // Off the URL that carried the code, whether or not it signed the browser in: a code that fails (spent,
        // expired, another browser, an account of another collection) ends on the same login page as no code at all.
        await redeem(c, t, q.handoff);
        return f.resume(c, t);
      }
      return await proceed(c, t);
    }
    const r = await validate(c, q);
    return r instanceof Response ? r : await proceed(c, r);
  });
}
