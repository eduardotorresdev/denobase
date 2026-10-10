import type { Context } from "hono";
import type { AppEnv } from "../http/app.ts";
import { quoteIdent, tableName } from "../schema/mod.ts";
import type { AuthUser, CollectionConfig } from "../core/types.ts";
import { publicAuthRecord } from "../auth/jwt.ts";
import type { OAuthCtx } from "./context.ts";
import { hashPassword } from "../auth/password.ts";
import { randomToken, safeEqual } from "./pkce.ts";
import { isLoopback } from "./clients.ts";
import { sameBrowser, sameOrigin } from "./session.ts";
import { type LoginData, pageHeaders, renderPage } from "./pages.ts";
import { type Messages, messages } from "./messages.ts";
import type { OAuthClient, OAuthRequest, OAuthSession } from "./types.ts";

export type C = Context<AppEnv>;

/** A web app session handed to one pending request (POST /oauth/handoff), redeemed once by GET /oauth/authorize. */
export interface Handoff {
  txn: string;
  collection: string;
  recordId: string;
  expires: number;
}

/**
 * What the browser routes of the authorization server (authorize, login, consent) share: pages, the redirect back to
 * the client, and the pending request (txn) they all act on.
 */
export class Flow {
  readonly m: Messages;
  /** One-time codes of POST /oauth/handoff, by hash: short-lived and per process, like the rate limiter. */
  readonly handoffs = new Map<string, Handoff>();

  constructor(readonly o: OAuthCtx) {
    this.m = messages(o.opts.locale);
  }

  appName(): string {
    return this.o.opts.branding?.name || this.o.http.settings.meta.appName || "Denobase";
  }

  page(c: C, html: string, status = 200, frameSrc?: string): Response {
    return c.body(html, status as 200, pageHeaders(frameSrc));
  }

  errorPage(c: C, title: string, message: string, status = 400): Response {
    return this.page(c, renderPage(this.o.opts, "error", { appName: this.appName(), title, message }), status);
  }

  expired(c: C): Response {
    return this.errorPage(c, this.m.requestExpired, this.m.requestExpiredMsg);
  }

  off(c: C): Response {
    return this.errorPage(c, this.m.notAvailable, this.m.turnedOff, 404);
  }

  /** The answer to the client: only ever a redirect_uri already matched against the client's registration. */
  returnUrl(c: C, t: Pick<OAuthRequest, "redirectUri" | "state">, params: Record<string, string>): URL {
    const u = new URL(t.redirectUri);
    for (const [k, v] of Object.entries(params)) u.searchParams.set(k, v);
    if (t.state) u.searchParams.set("state", t.state);
    u.searchParams.set("iss", this.o.issuer(c));
    return u;
  }

  /** 303 back to the client, when no one decided on a page (errors, remembered consent). */
  back(c: C, t: Pick<OAuthRequest, "redirectUri" | "state">, params: Record<string, string>): Response {
    c.header("Cache-Control", "no-store");
    c.header("Referrer-Policy", "no-referrer");
    return c.redirect(this.returnUrl(c, t, params).href, 303);
  }

  /** The final page after the consent form: the result delivered to the client while the page says what happened. */
  done(
    c: C,
    t: OAuthRequest,
    who: { clientName: string; email: string },
    params: Record<string, string>,
  ): Response {
    const u = this.returnUrl(c, t, params);
    const loopback = isLoopback(u);
    return this.page(
      c,
      renderPage(this.o.opts, "done", {
        appName: this.appName(),
        allowed: "code" in params,
        clientName: who.clientName,
        email: who.email,
        returnUrl: u.href,
        loopback,
      }),
      200,
      loopback ? u.origin : undefined,
    );
  }

  backError(c: C, t: Pick<OAuthRequest, "redirectUri" | "state">, error: string, description: string): Response {
    return this.back(c, t, { error, error_description: description });
  }

  loadTxn(id: string | null | undefined): OAuthRequest | null {
    if (!id || id.length > 100) return null;
    const t = this.o.db.prepare(`SELECT * FROM _oauth_requests WHERE id = ?`).get(id) as OAuthRequest | undefined;
    return t && !t.consumed && t.expires > Date.now() ? t : null;
  }

  /** Single use: only the request that flips consumed issues the code or the error. */
  consumeTxn(t: OAuthRequest): boolean {
    const r = this.o.db.prepare(`UPDATE _oauth_requests SET consumed = 1 WHERE id = ? AND consumed = 0 AND expires > ?`)
      .run(t.id, Date.now());
    return Number(r.changes) === 1;
  }

  /** Back to GET /oauth/authorize for this request, which decides what comes next. */
  resume(c: C, t: OAuthRequest): Response {
    return c.redirect(`/oauth/authorize?txn=${encodeURIComponent(t.id)}`, 303);
  }

  otpOn(col: CollectionConfig): boolean {
    return typeof col.auth === "object" && !!col.auth.otp?.enabled;
  }

  /** The collection the request signs in against, as it was validated; never one sent by a form. */
  collectionOf(t: OAuthRequest): CollectionConfig | undefined {
    return this.o.collections().find((x) => x.slug === t.collection);
  }

  #dummyHash?: Promise<string>;
  /** A hash to verify against when there is no account, so a miss costs what a wrong password costs. */
  dummyHash(): Promise<string> {
    return this.#dummyHash ??= hashPassword(randomToken());
  }

  /**
   * The page that hands the web app's session to a request without a word (webLogin, else the admin UI when superusers
   * may authorize). The same for every request, whatever its collection; undefined when there is none.
   */
  webHandoff(t: OAuthRequest): string | undefined {
    const w = this.o.opts.webLogin;
    if (w) {
      const u = new URL(w.url);
      u.searchParams.set("oauth_txn", t.id);
      return u.href;
    }
    if (this.o.http.adminUi && this.o.collections().some((c) => c.slug === "_superusers")) {
      return `/_/#/oauth-handoff?txn=${encodeURIComponent(t.id)}`;
    }
    return undefined;
  }

  /**
   * Where the silent handoff goes, the first time only: the flag is flipped in the stored request before the browser
   * leaves, so coming back (with or without a code, or by hand) never tries it again.
   */
  tryWeb(t: OAuthRequest): string | undefined {
    if (t.webTried) return undefined;
    const href = this.webHandoff(t);
    if (!href) return undefined;
    const r = this.o.db.prepare(`UPDATE _oauth_requests SET webTried = 1 WHERE id = ? AND webTried = 0`).run(t.id);
    return Number(r.changes) === 1 ? href : undefined;
  }

  /** 303 to the handoff page, carrying nothing but the request id. */
  away(c: C, href: string): Response {
    c.header("Cache-Control", "no-store");
    c.header("Referrer-Policy", "no-referrer");
    return c.redirect(href, 303);
  }

  /** The same page whatever collection the request signs in against: no selector, no name, no other fields. */
  loginPage(c: C, t: OAuthRequest, client: OAuthClient, extra: Partial<LoginData> = {}, status = 200): Response {
    return this.page(
      c,
      renderPage(this.o.opts, "login", {
        appName: this.appName(),
        clientName: clientLabel(client, this.m.someApp),
        txn: t.id,
        csrf: t.csrf,
        otp: this.o.collections().some((col) => this.otpOn(col)),
        email: extra.email ?? "",
        error: extra.error ?? "",
      }),
      status,
    );
  }

  userOf(s: Pick<OAuthSession, "collection" | "recordId">): AuthUser | null {
    const row = this.o.db.prepare(`SELECT * FROM ${quoteIdent(tableName(s.collection))} WHERE id = ?`)
      .get(s.recordId) as Record<string, unknown> | undefined;
    return row ? { id: s.recordId, collection: s.collection, record: publicAuthRecord(row) } : null;
  }

  /**
   * The common start of every form POST: enabled, our own origin, the form and the pending request. `preSession`
   * forms (login, codes) also prove they come from the browser that opened the request, with its form token.
   */
  async post(
    c: C,
    preSession: boolean,
  ): Promise<{ res: Response } | { res?: undefined; iss: string; form: URLSearchParams; t: OAuthRequest }> {
    if (!this.o.enabled) return { res: this.off(c) };
    const iss = this.o.issuer(c);
    if (!sameOrigin(c, iss)) return { res: this.errorPage(c, this.m.forbidden, this.m.crossSite, 403) };
    const form = await formOf(c);
    const t = this.loadTxn(form.get("txn"));
    if (!t) return { res: this.expired(c) };
    if (preSession) {
      const sent = form.get("csrf") ?? "";
      if (!t.csrf || !sent || !safeEqual(sent, t.csrf) || !(await sameBrowser(c, iss, t.bindHash))) {
        return { res: this.errorPage(c, this.m.forbidden, this.m.invalidForm, 403) };
      }
    }
    return { iss, form, t };
  }
}

export function clientLabel(c: OAuthClient, fallback: string): string {
  if (c.name) return c.name;
  return c.kind === "cimd" ? new URL(c.id).host : fallback;
}

/**
 * A resource URI (RFC 8707) in one spelling, so equal ones compare equal: lower-case scheme and host, no default port
 * (URL drops both), no fragment, no trailing slash. null when it is not an absolute URL.
 */
export function canonicalResource(s: string): string | null {
  if (!URL.canParse(s)) return null;
  const u = new URL(s);
  u.hash = "";
  if (u.pathname.length > 1) u.pathname = u.pathname.replace(/\/+$/, "");
  return u.href.replace(/\/$/, "");
}

/** urlencoded or multipart form body; anything else is empty. */
export async function formOf(c: C): Promise<URLSearchParams> {
  const type = c.req.header("content-type") ?? "";
  if (type.startsWith("application/x-www-form-urlencoded")) return new URLSearchParams(await c.req.text());
  if (type.startsWith("multipart/form-data")) {
    const out = new URLSearchParams();
    for (const [k, v] of await c.req.formData()) if (typeof v === "string") out.append(k, v);
    return out;
  }
  return new URLSearchParams();
}
