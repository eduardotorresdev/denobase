import type { Context, Hono } from "hono";
import { type AppEnv, type Ctx, tokenFromHeader } from "./app.ts";
import { tokenClaims } from "../auth/jwt.ts";
import type { CollectionConfig, Doc } from "../core/types.ts";
import { badRequest, forbidden, notFound, unauthorized } from "../core/errors.ts";
import { isSameAuth } from "../realtime/mod.ts";
import { getCollection } from "../core/registry.ts";
import { readBody } from "./form.ts";
import { authAlert } from "../auth/alert.ts";
import { realIp } from "./logs.ts";
import { LEVEL } from "../logs/mod.ts";

const BASE = "/api/collections/:c";

function int(v: string | undefined, def: number): number {
  const n = Number(v);
  return Number.isInteger(n) && n > 0 ? n : def;
}

function authCollection(ctx: Ctx, slug: string): CollectionConfig {
  const col = getCollection(slug, ctx.collections);
  if (!col.auth) throw notFound("Missing or invalid auth collection context.");
  return col;
}

function otpEnabled(col: CollectionConfig): boolean {
  return typeof col.auth === "object" && !!col.auth.otp?.enabled;
}

/**
 * PB recordAuthResponse: a failed login alert is logged as a warning and never fails the login. The alert mail is
 * sent after the response (authAlert), so its failure is logged from the background.
 */
export function loginAlert(c: Context<AppEnv>, ctx: Ctx, col: CollectionConfig, recordId: string): void {
  if (typeof col.auth !== "object" || !col.auth.authAlert?.enabled) return;
  const avisar = (e: unknown) => {
    const error = e instanceof Error ? e.message : String(e);
    try {
      ctx.logs.add(LEVEL.warn, "[recordAuthResponse] Failed to send login alert", { error }, 0);
    } catch {
      console.error("login alert failed", error);
    }
  };
  try {
    authAlert(ctx.db, ctx.mailer, {
      collection: col.slug,
      recordId,
      ip: realIp(c, ctx),
      userAgent: c.req.header("user-agent") ?? "",
      meta: ctx.settings.meta,
      onMailError: avisar,
    });
  } catch (e) {
    avisar(e);
  }
}

/** PB logs a failed OTP mail as an error; the request already answered with the otpId. */
export function otpMailFailed(ctx: Ctx, e: unknown): void {
  const error = e instanceof Error ? e.message : String(e);
  try {
    ctx.logs.add(LEVEL.error, "Failed to send OTP email", { error }, 0);
  } catch {
    console.error("Failed to send OTP email", error);
  }
}

/** PB RequestInfo headers: lower-cased, dashes as underscores (@request.headers.x_token). */
function requestHeaders(c: Context<AppEnv>): Record<string, string> {
  const out: Record<string, string> = {};
  c.req.raw.headers.forEach((v, k) => (out[k.toLowerCase().replaceAll("-", "_")] = v));
  return out;
}

/** GET/POST /api/collections/:c/records, GET/PATCH/DELETE /records/:id. */
export function recordRoutes(app: Hono<AppEnv>, ctx: Ctx): void {
  const { s } = ctx;
  const col = (c: Context<AppEnv>) => getCollection(c.req.param("c") ?? "", ctx.collections);
  const slug = (c: Context<AppEnv>) => col(c).slug;
  const req = (c: Context<AppEnv>) => s.makeReq(ctx.store, c.get("user"));

  app.get(`${BASE}/records`, async (c) => {
    const q = c.req.query();
    const out = await s.find({
      collection: slug(c),
      req: req(c),
      filter: q.filter || undefined,
      sort: q.sort || undefined,
      page: int(q.page, 1),
      perPage: Math.min(int(q.perPage, 30), 1000),
      expand: q.expand || undefined,
      fields: q.fields || undefined,
      requestInfo: { query: q, headers: requestHeaders(c) },
      skipTotal: ["1", "t", "true"].includes((q.skipTotal ?? "").toLowerCase()),
    });
    return c.json(out);
  });
  app.get(`${BASE}/records/:id`, async (c) => {
    const q = c.req.query();
    const doc = await s.findById({
      collection: slug(c),
      req: req(c),
      id: c.req.param("id"),
      expand: q.expand || undefined,
      fields: q.fields || undefined,
    });
    return c.json(doc);
  });
  const shape = (c: Context<AppEnv>) => ({
    expand: c.req.query("expand") || undefined,
    fields: c.req.query("fields") || undefined,
  });
  app.post(`${BASE}/records`, async (c) => {
    const doc = await s.create({ collection: slug(c), req: req(c), data: await readBody(c, col(c)), ...shape(c) });
    return c.json(doc);
  });
  app.patch(`${BASE}/records/:id`, async (c) => {
    const doc = await s.update({
      collection: slug(c),
      req: req(c),
      id: c.req.param("id"),
      data: await readBody(c, col(c)),
      ...shape(c),
    });
    return c.json(doc);
  });
  app.delete(`${BASE}/records/:id`, async (c) => {
    await s.remove({ collection: slug(c), req: req(c), id: c.req.param("id") });
    return c.body(null, 204);
  });
}

/**
 * The auth response record: read as its own owner so afterRead hooks (virtual permissoes) see the right principal.
 * Honours ?expand and ?fields like PB does on every auth response (the front logs in with expand=cargo).
 */
export function ownRecord(ctx: Ctx, col: CollectionConfig, id: string, c?: Context<AppEnv>): Promise<Doc> {
  const self = { id, collection: col.slug, record: { id } as Doc };
  return ctx.s.findById({
    collection: col.slug,
    req: ctx.s.makeReq(ctx.store, self),
    id,
    overrideAccess: true,
    expand: c?.req.query("expand") || undefined,
    fields: c?.req.query("fields") || undefined,
  });
}

/** auth-with-password, request-otp, auth-with-otp, auth-refresh -> {token, record}. */
export function authRoutes(app: Hono<AppEnv>, ctx: Ctx): void {
  const { s, db } = ctx;

  async function authResponse(c: Context<AppEnv>, col: CollectionConfig, id: string, token?: string) {
    const cred = s.credentials(db, col.slug, { id });
    if (!cred) throw badRequest("Failed to authenticate.");
    return c.json({ token: token ?? await s.signAuthToken(col.slug, cred), record: await ownRecord(ctx, col, id, c) });
  }

  app.post(`${BASE}/auth-with-password`, async (c) => {
    const col = authCollection(ctx, c.req.param("c") ?? "");
    const b = await readBody(c);
    const identity = typeof b.identity === "string" ? b.identity.trim() : "";
    const password = typeof b.password === "string" ? b.password : "";
    if (!identity || !password) {
      const blank = { code: "validation_required", message: "Cannot be blank." };
      throw badRequest("Failed to authenticate.", {
        ...(identity ? {} : { identity: blank }),
        ...(password ? {} : { password: blank }),
      });
    }
    const cred = s.credentials(db, col.slug, { email: identity });
    // Same message for unknown email and wrong password so accounts can't be enumerated.
    if (!cred || !cred.passwordHash || !(await s.verifyPassword(password, cred.passwordHash))) {
      throw badRequest("Failed to authenticate.");
    }
    const res = await authResponse(c, col, cred.id);
    loginAlert(c, ctx, col, cred.id);
    return res;
  });

  app.post(`${BASE}/request-otp`, async (c) => {
    const col = authCollection(ctx, c.req.param("c") ?? "");
    if (!otpEnabled(col)) throw badRequest("The collection is not configured to allow OTP authentication.");
    const b = await readBody(c);
    const email = typeof b.email === "string" ? b.email.trim() : "";
    if (!email) {
      throw badRequest("An error occurred while validating the submitted data.", {
        email: { code: "validation_required", message: "Cannot be blank." },
      });
    }
    return c.json(
      await s.requestOtp(db, ctx.mailer, col.slug, email, ctx.settings.meta, (e) => otpMailFailed(ctx, e)),
    );
  });

  app.post(`${BASE}/auth-with-otp`, async (c) => {
    const col = authCollection(ctx, c.req.param("c") ?? "");
    if (!otpEnabled(col)) throw badRequest("The collection is not configured to allow OTP authentication.");
    const b = await readBody(c);
    const otpId = typeof b.otpId === "string" ? b.otpId : "";
    const password = typeof b.password === "string" ? b.password : "";
    if (!otpId || !password) throw badRequest("Failed to authenticate.");
    const doc = await s.verifyOtp(db, col.slug, otpId, password);
    const res = await authResponse(c, col, doc.id);
    loginAlert(c, ctx, col, doc.id);
    return res;
  });

  app.post(`${BASE}/auth-refresh`, (c) => {
    const col = authCollection(ctx, c.req.param("c") ?? "");
    const user = c.get("user");
    if (!user) throw unauthorized();
    if (user.collection !== col.slug) throw forbidden("The request requires valid record authorization token.");
    // Impersonate's static tokens are not refreshable: PB hands the same token back.
    const token = tokenFromHeader(c.req.header("Authorization"))!;
    return authResponse(c, col, user.id, tokenClaims(token).refreshable ? undefined : token);
  });
}

/** GET /api/realtime (SSE) and POST /api/realtime (set subscriptions), as in PB. */
export function realtimeRoutes(app: Hono<AppEnv>, ctx: Ctx): void {
  const rt = ctx.realtime;
  // Deno.serve hands the connection info to Hono as env; app.request in tests has none, so the IP check is skipped.
  const ipOf = clientIp;

  // No request.signal: Deno aborts it once the response starts; the stream's cancel() is the disconnect signal.
  app.get("/api/realtime", (c) => rt.connect(ipOf(c)));

  app.post("/api/realtime", async (c) => {
    let b: unknown;
    try {
      b = await c.req.json();
    } catch {
      throw badRequest();
    }
    const form = (b && typeof b === "object" && !Array.isArray(b) ? b : {}) as Record<string, unknown>;
    const clientId = typeof form.clientId === "string" ? form.clientId : "";
    const subs = Array.isArray(form.subscriptions) ? form.subscriptions : form.subscriptions == null ? [] : null;
    const errs: Record<string, { code: string; message: string }> = {};
    if (!clientId) errs.clientId = { code: "validation_required", message: "Cannot be blank." };
    else if (clientId.length > 255) {
      errs.clientId = { code: "validation_length_out_of_range", message: "The length must be between 1 and 255." };
    }
    if (subs === null || subs.some((s) => typeof s !== "string")) {
      errs.subscriptions = { code: "validation_invalid_value", message: "Must be a list of strings." };
    } else if (subs.length > 1000) {
      errs.subscriptions = { code: "validation_length_too_long", message: "The length must be no more than 1000." };
    }
    if (Object.keys(errs).length) throw badRequest(undefined, errs);

    const client = rt.clients.get(clientId);
    if (!client) throw notFound("Missing or invalid client id.");
    if (client.ip !== "" && client.ip !== ipOf(c)) throw badRequest("Invalid realtime client.");
    const auth = c.get("user");
    if (client.auth && !isSameAuth(client.auth, auth)) {
      throw forbidden("The current and the previous request authorization don't match.");
    }
    await rt.subscribe(client, auth, subs as string[]);
    return c.body(null, 204);
  });
}

/** GET /api/health, PB health: superusers also get canBackup, realIP and possibleProxyHeader. */
export function healthRoutes(app: Hono<AppEnv>): void {
  app.get("/api/health", (c) => {
    let data: Record<string, unknown> = {};
    if (c.get("user")?.collection === "_superusers") {
      const proxy = ["CF-Connecting-IP", "Fly-Client-IP", "X-Forwarded-For"].find((h) => c.req.header(h));
      // Keys come out sorted.
      data = { canBackup: true, possibleProxyHeader: proxy ?? "", realIP: clientIp(c) };
    }
    return c.json({ message: "API is healthy.", code: 200, data });
  });
}

/** PB e.RealIP without trusted proxy headers: the connection's remote address. */
export function clientIp(c: Context<AppEnv>): string {
  return (c.env as { remoteAddr?: { hostname?: string } } | undefined)?.remoteAddr?.hostname ?? "";
}
