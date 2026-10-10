import type { Hono } from "hono";
import type { AppEnv } from "../http/app.ts";
import { loginAlert, otpMailFailed } from "../http/routes.ts";
import { realIp } from "../http/logs.ts";
import { resolveClient } from "./clients.ts";
import { randomToken, sha256 } from "./pkce.ts";
import { startSession } from "./session.ts";
import { renderPage } from "./pages.ts";
import { newId } from "../core/db.ts";
import { type C, clientLabel, type Flow, formOf } from "./flow.ts";
import { failureDelayMs, LIMITS } from "./ratelimit.ts";

const HANDOFF_TTL_MS = 60_000;

/**
 * How the user signs in to a pending request: password (POST /oauth/login), a code by email (/oauth/otp/*), or the
 * session they already have in the consumer's web app (POST /oauth/handoff, called by that app).
 */
export function loginRoutes(app: Hono<AppEnv>, f: Flow): void {
  const o = f.o;
  const m = f.m;
  const ip = (c: C) => realIp(c, o.http);

  /**
   * Failures count per account and IP (a hard stop) and per account from any IP (only a growing delay): someone failing
   * on purpose with another person's email must not lock that person out of this page.
   */
  const mayTry = async (c: C, account: string): Promise<boolean> => {
    if (o.limiter.count(`fail:${account}:${ip(c)}`) >= LIMITS.loginFail[0]) return false;
    const wait = failureDelayMs(o.limiter.count(`fail:${account}`));
    if (wait) await new Promise((r) => setTimeout(r, wait));
    return true;
  };
  const failed = (c: C, account: string) => {
    o.limiter.hit(`fail:${account}:${ip(c)}`, ...LIMITS.loginFail);
    o.limiter.hit(`fail:${account}`, ...LIMITS.accountFail);
  };

  app.post("/oauth/login", async (c) => {
    const p = await f.post(c, true);
    if (p.res) return p.res;
    const { iss, form, t } = p;
    const client = await resolveClient(o, t.clientId);
    if (!client) return f.expired(c);
    const email = (form.get("email") ?? "").trim();
    const password = form.get("password") ?? "";
    // The request's collection, never the form's: a "collection" field sent here is ignored.
    const col = f.collectionOf(t);
    const fail = (error: string, status = 400) => f.loginPage(c, t, client, { email, error }, status);
    if (!o.limiter.hit(`login:ip:${ip(c)}`, ...LIMITS.login)) return fail(m.tooManyAttempts, 429);
    if (!email || !password) return fail(m.enterEmailPassword);
    const cred = col ? o.http.s.credentials(o.db, col.slug, { email }) : null;
    const account = `${t.collection}:${cred?.id ?? email.toLowerCase()}`;
    if (!(await mayTry(c, account))) return fail(m.tooManyAttempts, 429);
    // One answer, at one cost, for a wrong password, an unknown email and an account of another collection: the hash
    // is checked even when there is no account, so neither accounts nor collections can be told apart.
    const ok = await o.http.s.verifyPassword(password, cred?.passwordHash || await f.dummyHash());
    if (!col || !cred || !cred.passwordHash || !ok) {
      failed(c, account);
      return fail(m.invalidCredentials);
    }
    await startSession(o, c, iss, col.slug, cred.id, cred.tokenKey);
    loginAlert(c, o.http, col, cred.id);
    return f.resume(c, t);
  });

  app.post("/oauth/otp/request", async (c) => {
    const p = await f.post(c, true);
    if (p.res) return p.res;
    const { form, t } = p;
    const client = await resolveClient(o, t.clientId);
    if (!client) return f.expired(c);
    const email = (form.get("email") ?? "").trim();
    const col = f.collectionOf(t);
    if (!email) return f.loginPage(c, t, client, { error: m.enterEmail }, 400);
    const to = email.toLowerCase();
    if (
      !o.limiter.hit(`otp:ip:${ip(c)}`, ...LIMITS.otp) || !o.limiter.hit(`otp:email:${to}:${ip(c)}`, ...LIMITS.otp) ||
      !o.limiter.hit(`otp:email:${to}`, ...LIMITS.otpEmail)
    ) {
      return f.loginPage(c, t, client, { email, error: m.tooManyCodes }, 429);
    }
    // The same page whether or not the account exists in this collection (or it has codes at all); only then is a
    // code sent, and a made-up id simply never verifies.
    const { otpId } = col && f.otpOn(col)
      ? await o.http.s.requestOtp(
        o.db,
        o.http.mailer,
        col.slug,
        email,
        o.http.settings.meta,
        (e) => otpMailFailed(o.http, e),
      )
      : { otpId: newId() };
    return f.page(
      c,
      renderPage(o.opts, "otp", {
        appName: f.appName(),
        clientName: clientLabel(client, m.someApp),
        txn: t.id,
        csrf: t.csrf,
        otpId,
        email,
        error: "",
      }),
    );
  });

  /** The account a code was sent to, for the failure counters; the code id itself when it is unknown. */
  const otpAccount = (collection: string, otpId: string): string => {
    try {
      const r = o.db.prepare(`SELECT recordId FROM _otps WHERE id = ? AND collection = ?`).get(otpId, collection) as
        | { recordId: string }
        | undefined;
      return `${collection}:${r?.recordId ?? `otp:${otpId}`}`;
    } catch {
      return `${collection}:otp:${otpId}`;
    }
  };

  app.post("/oauth/otp/verify", async (c) => {
    const p = await f.post(c, true);
    if (p.res) return p.res;
    const { iss, form, t } = p;
    const client = await resolveClient(o, t.clientId);
    if (!client) return f.expired(c);
    const col = f.collectionOf(t);
    const otpId = (form.get("otpId") ?? "").slice(0, 100);
    if (!o.limiter.hit(`login:ip:${ip(c)}`, ...LIMITS.login)) {
      return f.loginPage(c, t, client, { error: m.tooManyAttempts }, 429);
    }
    const account = otpAccount(t.collection, otpId);
    if (!(await mayTry(c, account))) return f.loginPage(c, t, client, { error: m.tooManyAttempts }, 429);
    let recordId: string;
    try {
      if (!col || !f.otpOn(col)) throw new Error("no codes");
      recordId = (await o.http.s.verifyOtp(o.db, col.slug, otpId, form.get("code") ?? "")).id;
    } catch {
      failed(c, account);
      return f.loginPage(c, t, client, { error: m.invalidCode }, 400);
    }
    const cred = o.http.s.credentials(o.db, col.slug, { id: recordId });
    if (!cred) return f.loginPage(c, t, client, { error: m.invalidCode }, 400);
    await startSession(o, c, iss, col.slug, cred.id, cred.tokenKey);
    loginAlert(c, o.http, col, cred.id);
    return f.resume(c, t);
  });

  /**
   * Called by the consumer's web app with its own auth token (Authorization header, so no cookie and no CSRF): hands
   * that session to the pending request `txn`. Answers the URL the app sends the browser to; the code in it works once,
   * for a minute, and only in the browser that opened the request.
   */
  app.post("/oauth/handoff", async (c) => {
    const json = (body: unknown, status: number) => c.json(body, status as 200, { "Cache-Control": "no-store" });
    if (!o.enabled) return json({ error: "invalid_request", error_description: "Authorization is turned off." }, 404);
    if (!o.limiter.hit(`handoff:${ip(c)}`, ...LIMITS.token)) {
      return json({ error: "slow_down", error_description: "Too many requests." }, 429);
    }
    const user = c.get("user");
    if (!user || !o.collections().some((col) => col.slug === user.collection)) {
      return json({ error: "invalid_token", error_description: "Sign in with an account that may authorize." }, 401);
    }
    let txn: string | null = null;
    if ((c.req.header("content-type") ?? "").startsWith("application/json")) {
      const body = await c.req.json().catch(() => null) as { txn?: unknown } | null;
      txn = typeof body?.txn === "string" ? body.txn : null;
    } else {
      txn = (await formOf(c)).get("txn");
    }
    const t = f.loadTxn(txn);
    if (!t) return json({ error: "invalid_request", error_description: "Unknown or expired request." }, 400);
    const now = Date.now();
    if (f.handoffs.size > 1_000) { for (const [k, h] of f.handoffs) if (h.expires < now) f.handoffs.delete(k); }
    const code = randomToken();
    f.handoffs.set(await sha256(code), {
      txn: t.id,
      collection: user.collection,
      recordId: user.id,
      expires: now + HANDOFF_TTL_MS,
    });
    const url = `${o.issuer(c)}/oauth/authorize?txn=${encodeURIComponent(t.id)}&handoff=${code}`;
    return json({ url }, 200);
  });
}
