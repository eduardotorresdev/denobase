import { assert, assertEquals } from "@std/assert";
import type { App, AppOptions } from "../app.ts";
import { type Fixture, fixture } from "../mcp/testkit.ts";
import type { OAuthOptions } from "./types.ts";
import { tokenFor } from "../testing/mod.ts";

/** settings.meta.appURL's default: the issuer, the MCP resource's base and the Origin the pages accept. */
export const ISSUER = "http://localhost:8090";
export const RESOURCE = `${ISSUER}/api/mcp`;
export const REDIRECT = "http://127.0.0.1:33418/callback";
export const VERIFIER = "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk";
export const CHALLENGE = "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM";

export interface OAuthFixture extends Fixture {
  /** A public DCR client registered with REDIRECT. */
  clientId: string;
  /** The superuser's plain session token, for /api/oauth/*. */
  suSession: string;
}

/** The MCP fixture (mt_users: ana, bia; su) with OAuth authorizing _superusers and mt_users, and a DCR client. */
export async function oauthFixture(
  oauth: OAuthOptions = {},
  opts: Partial<AppOptions> = {},
): Promise<OAuthFixture> {
  const t = await fixture({
    ...opts,
    mcp: { ...opts.mcp, oauth: { collections: ["mt_users", "_superusers"], ...oauth } },
  });
  const reg = await register(t.app, {
    redirect_uris: [REDIRECT],
    client_name: "Test client",
    token_endpoint_auth_method: "none",
  });
  assertEquals(reg.status, 201);
  return { ...t, clientId: (await reg.json()).client_id, suSession: await tokenFor(t.app.db, "_superusers", t.su) };
}

export function register(app: App, body: unknown): Promise<Response> {
  return Promise.resolve(app.fetch(
    new Request("http://localhost/oauth/register", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
  ));
}

/** A minimal browser: one cookie jar, same-origin form posts. */
export class Browser {
  cookie = "";
  constructor(readonly app: App) {}

  #keep(res: Response) {
    for (const sc of res.headers.getSetCookie()) {
      const [pair] = sc.split(";");
      const [name, value] = [pair.slice(0, pair.indexOf("=")), pair.slice(pair.indexOf("=") + 1)];
      const others = this.cookie.split("; ").filter((p) => p && !p.startsWith(`${name}=`));
      this.cookie = [...others, ...(value ? [`${name}=${value}`] : [])].join("; ");
    }
    return res;
  }

  async get(path: string): Promise<Response> {
    const headers: Record<string, string> = this.cookie ? { cookie: this.cookie } : {};
    return this.#keep(await this.app.fetch(new Request(`http://localhost${path}`, { headers })));
  }

  async post(path: string, fields: Record<string, string>, headers: Record<string, string> = {}): Promise<Response> {
    return this.#keep(
      await this.app.fetch(
        new Request(`http://localhost${path}`, {
          method: "POST",
          headers: {
            "content-type": "application/x-www-form-urlencoded",
            origin: ISSUER,
            ...(this.cookie ? { cookie: this.cookie } : {}),
            ...headers,
          },
          body: new URLSearchParams(fields).toString(),
        }),
      ),
    );
  }
}

export function authorizeQuery(clientId: string, extra: Record<string, string> = {}): string {
  return "/oauth/authorize?" + new URLSearchParams({
    response_type: "code",
    client_id: clientId,
    redirect_uri: REDIRECT,
    state: "st-1",
    code_challenge: CHALLENGE,
    code_challenge_method: "S256",
    ...extra,
  });
}

/** A hidden input's value in a rendered page. */
export function hidden(html: string, name: string): string {
  const m = html.match(new RegExp(`name="${name}" value="([^"]*)"`));
  assert(m, `no hidden ${name} in page`);
  return m[1];
}

/** A pending request's form token, as its login page renders it (also when the page shown is another one). */
export function txnCsrf(app: App, txn: string): string {
  return (app.db.prepare(`SELECT csrf FROM _oauth_requests WHERE id = ?`).get(txn) as { csrf: string }).csrf;
}

/** The request's auth_collection: the one `who` belongs to, when named; else the server's default (mt_users here). */
function withCollection(who: { collection?: string }, extra: Record<string, string>): Record<string, string> {
  return who.collection ? { auth_collection: who.collection, ...extra } : extra;
}

/** Login (password) from a fresh authorize, through to the consent page; returns its txn and csrf. */
export async function toConsent(
  b: Browser,
  clientId: string,
  who: { email: string; collection?: string } = { email: "ana@x.io" },
  extra: Record<string, string> = {},
): Promise<{ txn: string; csrf: string; html: string }> {
  const login = await b.get(authorizeQuery(clientId, withCollection(who, extra)));
  assertEquals(login.status, 200);
  const loginHtml = await login.text();
  const txn = hidden(loginHtml, "txn");
  const res = await b.post("/oauth/login", {
    txn,
    csrf: txnCsrf(b.app, txn),
    email: who.email,
    password: "12345678",
  });
  assertEquals(res.status, 303);
  const consent = await b.get(res.headers.get("location")!);
  assertEquals(consent.status, 200);
  const html = await consent.text();
  return { txn, csrf: hidden(html, "csrf"), html };
}

/** The redirect back to the client, parsed. */
export function callback(res: Response): URL {
  assertEquals(res.status, 303);
  const u = new URL(res.headers.get("location")!);
  assertEquals(u.origin + u.pathname, REDIRECT);
  return u;
}

/**
 * The final page after the consent form, and the result it delivers to the client: the hidden frame's URL for a
 * loopback redirect (the link carries the same), parsed.
 */
export async function delivered(res: Response, redirect = REDIRECT): Promise<URL> {
  assertEquals(res.status, 200);
  const html = await res.text();
  const href = (html.match(/<a class="oa-return" href="([^"]+)"/) ?? [])[1];
  if (!href) throw new Error("no return link on the final page");
  const u = new URL(href.replaceAll("&amp;", "&"));
  assertEquals(u.origin + u.pathname, redirect);
  return u;
}

/** Full authorization: consent allowed (or already remembered for this user and client), the code returned. */
export async function authorizeCode(
  b: Browser,
  clientId: string,
  who: { email: string; collection?: string } = { email: "ana@x.io" },
  extra: Record<string, string> = {},
): Promise<string> {
  const login = await b.get(authorizeQuery(clientId, withCollection(who, extra)));
  const loginHtml = await login.text();
  const txn = hidden(loginHtml, "txn");
  const res = await b.post("/oauth/login", {
    txn,
    csrf: txnCsrf(b.app, txn),
    email: who.email,
    password: "12345678",
  });
  const next = await b.get(res.headers.get("location")!);
  if (next.status === 303) return callback(next).searchParams.get("code")!;
  const csrf = hidden(await next.text(), "csrf");
  const u = await delivered(await b.post("/oauth/consent", { txn, csrf, action: "allow" }));
  return u.searchParams.get("code")!;
}

export async function token(app: App, fields: Record<string, string>, headers: Record<string, string> = {}) {
  const res = await app.fetch(
    new Request("http://localhost/oauth/token", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", ...headers },
      body: new URLSearchParams(fields).toString(),
    }),
  );
  return { status: res.status, body: await res.json(), headers: res.headers };
}

export function exchange(app: App, clientId: string, code: string, extra: Record<string, string> = {}) {
  return token(app, {
    grant_type: "authorization_code",
    client_id: clientId,
    code,
    redirect_uri: REDIRECT,
    code_verifier: VERIFIER,
    ...extra,
  });
}

/** Authorization through tokens in one go. */
export async function tokens(t: OAuthFixture, who?: { email: string; collection?: string }) {
  const code = await authorizeCode(new Browser(t.app), t.clientId, who);
  const r = await exchange(t.app, t.clientId, code);
  assertEquals(r.status, 200, JSON.stringify(r.body));
  return r.body as { access_token: string; refresh_token: string; scope: string; expires_in: number };
}

export function admin(app: App, suToken: string, method: string, path: string) {
  return app.fetch(new Request(`http://localhost${path}`, { method, headers: { Authorization: suToken } }));
}
