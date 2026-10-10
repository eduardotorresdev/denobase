import type { Context } from "hono";
import type { AppEnv } from "../http/app.ts";
import { realIp } from "../http/logs.ts";
import type { OAuthCtx } from "./context.ts";
import { randomToken, safeEqual, sha256 } from "./pkce.ts";
import type { OAuthSession } from "./types.ts";

const NAME = "denobase_oauth";

/** __Host- needs Secure, so plain-http (local dev) issuers use the bare name. */
export function cookieName(issuer: string): string {
  return issuer.startsWith("https:") ? `__Host-${NAME}` : NAME;
}

export function readCookie(c: Context<AppEnv>, name: string): string | null {
  const header = c.req.header("cookie") ?? "";
  for (const part of header.split(";")) {
    const i = part.indexOf("=");
    if (i > 0 && part.slice(0, i).trim() === name) return part.slice(i + 1).trim() || null;
  }
  return null;
}

export function setSessionCookie(c: Context<AppEnv>, issuer: string, id: string, maxAge: number): void {
  const secure = issuer.startsWith("https:") ? "; Secure" : "";
  c.header(
    "Set-Cookie",
    `${cookieName(issuer)}=${id}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${secure}`,
    { append: true },
  );
}

export function clearSessionCookie(c: Context<AppEnv>, issuer: string): void {
  setSessionCookie(c, issuer, "", 0);
}

/**
 * The browser session of /oauth/*, or null: unknown or expired id, or the user is gone or changed tokenKey
 * (password change, logout everywhere). Only the id's hash is stored.
 */
export async function loadSession(o: OAuthCtx, c: Context<AppEnv>, issuer: string): Promise<OAuthSession | null> {
  const id = readCookie(c, cookieName(issuer));
  if (!id || id.length > 100) return null;
  const s = o.db.prepare(`SELECT * FROM _oauth_sessions WHERE idHash = ?`).get(await sha256(id)) as
    | OAuthSession
    | undefined;
  if (!s || s.expires <= Date.now()) return null;
  if (!o.collections().some((col) => col.slug === s.collection)) return null;
  const cred = o.http.s.credentials(o.db, s.collection, { id: s.recordId });
  if (!cred || !safeEqual(await sha256(cred.tokenKey), s.keyHash)) return null;
  return s;
}

/**
 * A new session after a login, always under a fresh id (no fixation): the previous one, if any, is deleted.
 */
export async function startSession(
  o: OAuthCtx,
  c: Context<AppEnv>,
  issuer: string,
  collection: string,
  recordId: string,
  tokenKey: string,
): Promise<OAuthSession> {
  const old = readCookie(c, cookieName(issuer));
  if (old) o.db.prepare(`DELETE FROM _oauth_sessions WHERE idHash = ?`).run(await sha256(old));
  const id = randomToken();
  const now = Date.now();
  const ttl = o.settings.sessionTTL;
  const s: OAuthSession = {
    idHash: await sha256(id),
    collection,
    recordId,
    csrf: randomToken(),
    keyHash: await sha256(tokenKey),
    created: now,
    expires: now + ttl * 1000,
  };
  o.db.prepare(
    `INSERT INTO _oauth_sessions (idHash, collection, recordId, csrf, keyHash, userAgent, ipHash, created, expires)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    s.idHash,
    collection,
    recordId,
    s.csrf,
    s.keyHash,
    (c.req.header("user-agent") ?? "").slice(0, 200),
    await sha256(realIp(c, o.http)),
    now,
    s.expires,
  );
  setSessionCookie(c, issuer, id, ttl);
  return s;
}

export async function endSession(o: OAuthCtx, c: Context<AppEnv>, issuer: string): Promise<void> {
  const id = readCookie(c, cookieName(issuer));
  if (id) o.db.prepare(`DELETE FROM _oauth_sessions WHERE idHash = ?`).run(await sha256(id));
  clearSessionCookie(c, issuer);
}

const BIND = "denobase_oauth_b";
const bindName = (issuer: string) => issuer.startsWith("https:") ? `__Host-${BIND}` : BIND;

/**
 * The browser's binding id: a cookie for the life of the browser session, set the first time it opens
 * /oauth/authorize. A pending request remembers its hash, so only that browser can sign in to it (no login CSRF, no
 * handoff code used elsewhere).
 */
export async function bindBrowser(c: Context<AppEnv>, issuer: string): Promise<string> {
  let id = readCookie(c, bindName(issuer));
  if (!id || id.length > 100) {
    id = randomToken();
    const secure = issuer.startsWith("https:") ? "; Secure" : "";
    c.header("Set-Cookie", `${bindName(issuer)}=${id}; Path=/; HttpOnly; SameSite=Lax${secure}`, { append: true });
  }
  return await sha256(id);
}

/** Whether this request comes from the browser whose binding hash is `bindHash`. */
export async function sameBrowser(c: Context<AppEnv>, issuer: string, bindHash: string): Promise<boolean> {
  const id = readCookie(c, bindName(issuer));
  return !!id && !!bindHash && id.length <= 100 && safeEqual(await sha256(id), bindHash);
}

/**
 * A state-changing POST came from our own page: Origin is the issuer's (or, without Origin or with `Origin: null`, Sec-Fetch-Site says
 * same-origin). A request with neither is refused: every browser that renders these forms sends one of them.
 */
export function sameOrigin(c: Context<AppEnv>, issuer: string): boolean {
  const site = c.req.header("sec-fetch-site");
  if (site && site !== "same-origin") return false;
  const origin = c.req.header("origin");
  // Our pages send Referrer-Policy: no-referrer, so Chrome posts their forms with `Origin: null`: then only
  // Sec-Fetch-Site (same-origin) vouches for the request.
  if (origin && origin !== "null") return origin === new URL(issuer).origin;
  return site === "same-origin";
}

/** Double-submit CSRF bound to the session, compared in constant time. */
export function csrfValid(s: OAuthSession | null, sent: string | null | undefined): boolean {
  return !!s && typeof sent === "string" && sent.length > 0 && safeEqual(sent, s.csrf);
}
