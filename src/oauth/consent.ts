import type { Hono } from "hono";
import type { AppEnv } from "../http/app.ts";
import type { AuthUser } from "../core/types.ts";
import { resolveClient, touchClient } from "./clients.ts";
import { randomToken, sha256 } from "./pkce.ts";
import { splitScope } from "./scopes.ts";
import { csrfValid, endSession, loadSession, sameOrigin } from "./session.ts";
import { clientLabel, type Flow, formOf } from "./flow.ts";
import type { OAuthClient, OAuthGrant, OAuthRequest, OAuthSession } from "./types.ts";

/** onAuthorize's last word: the scopes to grant, or null (access_denied). */
export async function decide(f: Flow, t: OAuthRequest, client: OAuthClient, user: AuthUser): Promise<string[] | null> {
  const scopes = splitScope(t.scope);
  const hook = f.o.opts.onAuthorize;
  if (!hook) return scopes;
  const r = await hook({
    user,
    client: { id: client.id, name: client.name, kind: client.kind },
    scopes,
    resource: t.resource,
  });
  if (r === false) return null;
  if (Array.isArray(r)) {
    const narrowed = scopes.filter((s) => r.includes(s));
    return narrowed.length ? narrowed : null;
  }
  return scopes;
}

/** Records the grant (scopes merged, consent remembered) and returns a fresh code for the client. */
export async function issueCode(f: Flow, t: OAuthRequest, s: OAuthSession, scopes: string[]): Promise<string> {
  const o = f.o;
  const now = new Date().toISOString();
  const db = o.db;
  let g = db.prepare(
    `SELECT * FROM _oauth_grants WHERE clientId = ? AND collection = ? AND recordId = ? AND resource = ?`,
  ).get(t.clientId, s.collection, s.recordId, t.resource) as OAuthGrant | undefined;
  if (g?.revokedAt) {
    // A revoked grant never comes back to life: its gid stays dead, the new authorization gets a new one.
    db.prepare(`DELETE FROM _oauth_grants WHERE id = ?`).run(g.id);
    g = undefined;
  }
  const remember = o.settings.rememberConsent ? 1 : 0;
  let grantId: string;
  if (g) {
    grantId = g.id;
    const merged = [...new Set([...splitScope(g.scope), ...scopes])].join(" ");
    db.prepare(`UPDATE _oauth_grants SET scope = ?, rememberConsent = ?, lastUsed = ? WHERE id = ?`)
      .run(merged, remember, now, g.id);
  } else {
    grantId = randomToken(16);
    db.prepare(
      `INSERT INTO _oauth_grants (id, clientId, collection, recordId, resource, scope, rememberConsent, created,
        lastUsed) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(grantId, t.clientId, s.collection, s.recordId, t.resource, scopes.join(" "), remember, now, now);
  }
  const code = randomToken();
  db.prepare(
    `INSERT INTO _oauth_codes (codeHash, grantId, clientId, redirectUri, codeChallenge, resource, scope, collection,
      recordId, expires, redirectUriSent) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    await sha256(code),
    grantId,
    t.clientId,
    t.redirectUri,
    t.codeChallenge,
    t.resource,
    scopes.join(" "),
    s.collection,
    s.recordId,
    Date.now() + o.settings.codeTTL * 1000,
    t.redirectUriSent,
  );
  touchClient(db, t.clientId);
  return code;
}

/** POST /oauth/consent (allow or deny) and POST /oauth/logout ("use another account"). */
export function consentRoutes(app: Hono<AppEnv>, f: Flow): void {
  const o = f.o;
  const m = f.m;

  app.post("/oauth/consent", async (c) => {
    const p = await f.post(c, false);
    if (p.res) return p.res;
    const { iss, form, t } = p;
    const s = await loadSession(o, c, iss);
    if (!s) return f.errorPage(c, m.signedOut, m.sessionEnded, 401);
    if (!csrfValid(s, form.get("csrf"))) return f.errorPage(c, m.forbidden, m.invalidForm, 403);
    const client = await resolveClient(o, t.clientId);
    const user = f.userOf(s);
    if (!client || !user) return f.expired(c);
    if (!f.consumeTxn(t)) return f.expired(c);
    const who = { clientName: clientLabel(client, m.someApp), email: String(user.record.email ?? user.id) };
    const denied = (description: string) =>
      f.done(c, t, who, { error: "access_denied", error_description: description });
    if (form.get("action") !== "allow") return denied("The user denied the request.");
    const scopes = await decide(f, t, client, user);
    if (!scopes) return denied("The authorization was refused.");
    return f.done(c, t, who, { code: await issueCode(f, t, s, scopes) });
  });

  app.post("/oauth/logout", async (c) => {
    if (!o.enabled) return f.off(c);
    const iss = o.issuer(c);
    if (!sameOrigin(c, iss)) return f.errorPage(c, m.forbidden, m.crossSite, 403);
    const form = await formOf(c);
    const s = await loadSession(o, c, iss);
    if (s && !csrfValid(s, form.get("csrf"))) return f.errorPage(c, m.forbidden, m.invalidForm, 403);
    await endSession(o, c, iss);
    const t = f.loadTxn(form.get("txn"));
    if (t) return f.resume(c, t);
    return f.errorPage(c, m.signedOut, m.youSignedOut, 200);
  });
}
