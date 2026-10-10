import type { Context, Hono } from "hono";
import { z } from "zod";
import type { AppEnv, Ctx } from "./app.ts";
import type { CollectionConfig } from "../core/types.ts";
import { ApiError, badRequest, forbidden, notFound, unauthorized } from "../core/errors.ts";
import { getCollection } from "../core/registry.ts";
import { quoteIdent, tableName } from "../schema/mod.ts";
import { MIN_PASSWORD } from "../engine/auth.ts";
import { signToken, tokenClaims, type TokenType, verifyToken } from "../auth/jwt.ts";
import { renderTemplate, TEMPLATES } from "../auth/templates.ts";
import { sendInBackground } from "../auth/mailer.ts";
import { LEVEL } from "../logs/mod.ts";
import { verifyPassword } from "../auth/password.ts";
import { ownRecord } from "./routes.ts";

/**
 * PB verification, password reset and email change flows, auth-methods and impersonate. Messages, codes
 * and statuses mirror PB so the official JS SDK works unchanged.
 */

type FieldError = { code: string; message: string };
const BASE = "/api/collections/:c";
const SUPERUSERS = "_superusers";
const RESEND_MS = 2 * 60 * 1000;
const required: FieldError = { code: "validation_required", message: "Cannot be blank." };
const invalidToken: FieldError = { code: "validation_invalid_token", message: "Invalid or expired token." };
const collectionMismatch: FieldError = {
  code: "validation_token_collection_mismatch",
  message: "The provided token is for different auth collection.",
};

/** PB BindBody: an empty body binds nothing; anything but a JSON object is a load error. */
async function form(c: Context<AppEnv>): Promise<Record<string, unknown>> {
  const text = await c.req.text();
  if (!text.trim()) return {};
  try {
    const b = JSON.parse(text);
    if (b && typeof b === "object" && !Array.isArray(b)) return b;
  } catch { /* falls through */ }
  throw badRequest("An error occurred while loading the submitted data.");
}

const str = (v: unknown) => (typeof v === "string" ? v : "");

function length(v: string, min: number, max: number): FieldError | null {
  return v.length < min || v.length > max
    ? { code: "validation_length_out_of_range", message: `The length must be between ${min} and ${max}.` }
    : null;
}

function emailError(v: string): FieldError | null {
  if (!v) return required;
  return length(v, 1, 255) ??
    (z.email().safeParse(v).success
      ? null
      : { code: "validation_is_email", message: "Must be a valid email address." });
}

/** ozzo ValidateStruct: every failing field at once, under PB's generic message. */
function validate(fields: Record<string, FieldError | null>): void {
  const data: Record<string, FieldError> = {};
  for (const [k, e] of Object.entries(fields)) if (e) data[k] = e;
  if (Object.keys(data).length) throw badRequest("An error occurred while validating the submitted data.", data);
}

export function authFlowRoutes(app: Hono<AppEnv>, ctx: Ctx): void {
  const { s, db } = ctx;
  const system = () => s.makeReq(ctx.store, null);
  // PB app.Store() resend keys: one mail per record and kind every 2 minutes.
  const sentAt = new Map<string, number>();
  const throttled = (key: string) => (sentAt.get(key) ?? 0) > Date.now();

  function authCol(c: Context<AppEnv>): CollectionConfig {
    let col: CollectionConfig | undefined;
    try {
      col = getCollection(c.req.param("c") ?? "", ctx.collections);
    } catch { /* 404 below */ }
    if (!col?.auth) throw notFound("Missing or invalid auth collection context.");
    return col;
  }

  type Row = { id: string; email: string; verified: unknown; tokenKey: string; passwordHash: string };
  const byEmail = (col: CollectionConfig, email: string) =>
    db.prepare(`SELECT * FROM ${quoteIdent(tableName(col.slug))} WHERE email = ? COLLATE NOCASE LIMIT 1`)
      .get(email) as Row | undefined;
  const byId = (col: CollectionConfig, id: string) =>
    db.prepare(`SELECT * FROM ${quoteIdent(tableName(col.slug))} WHERE id = ?`).get(id) as Row | undefined;

  async function mailOf(
    to: string,
    template: keyof typeof TEMPLATES,
    col: CollectionConfig,
    row: Row,
    type: TokenType,
    extra: { newEmail?: string } = {},
  ) {
    const token = await signToken(col.slug, row, type, { email: row.email, ...extra });
    return { to, ...renderTemplate(TEMPLATES[template], ctx.settings.meta, { "{TOKEN}": token }) };
  }

  async function mail(...args: Parameters<typeof mailOf>) {
    await ctx.mailer.send(await mailOf(...args));
  }

  /**
   * PB sends the verification and reset mails in the background (the client sees 204 either way): the request never
   * waits for the provider. The resend window starts only once the mail went out; a failure is logged.
   */
  async function mailInBackground(key: string, message: string, ...args: Parameters<typeof mailOf>) {
    const m = await mailOf(...args);
    sendInBackground(
      () => ctx.mailer.send(m).then(() => void sentAt.set(key, Date.now() + RESEND_MS)),
      (err) => ctx.logs.add(LEVEL.error, message, { error: err instanceof Error ? err.message : String(err) }, 0),
    );
  }

  /** Verified token of `type` for this route's collection, or the field error PB reports for it. */
  async function checkToken(col: CollectionConfig, token: string, type: TokenType) {
    if (!token) return { error: required };
    const v = await verifyToken(db, token, type);
    if (!v) return { error: invalidToken };
    if (v.collection.slug !== col.slug) return { error: collectionMismatch };
    return { v };
  }

  const save = (col: CollectionConfig, id: string, data: Record<string, unknown>) =>
    s.update({ collection: col.slug, req: system(), id, data, overrideAccess: true });

  app.get(`${BASE}/auth-methods`, (c) => {
    const col = authCol(c);
    const otp = typeof col.auth === "object" ? col.auth.otp : undefined;
    return c.json({
      password: { identityFields: ["email"], enabled: true },
      oauth2: { providers: [], enabled: false },
      mfa: { enabled: false, duration: 0 },
      otp: { enabled: !!otp?.enabled, duration: otp?.enabled ? otp.duration ?? 180 : 0 },
      // Legacy fields; PB answers the untouched providers list as null.
      authProviders: null,
      usernamePassword: false,
      emailPassword: true,
    });
  });

  app.post(`${BASE}/request-verification`, async (c) => {
    const col = authCol(c);
    if (col.slug === SUPERUSERS) throw badRequest("All superusers are verified by default.");
    const email = str((await form(c)).email);
    validate({ email: emailError(email) });
    const row = byEmail(col, email);
    const key = `verification:${col.slug}:${row?.id}`;
    // Unknown email, resend window or already verified all answer 204, so accounts cannot be enumerated.
    if (row && !row.verified && !throttled(key)) {
      await mailInBackground(
        key,
        "Failed to send verification email",
        row.email,
        "verification",
        col,
        row,
        "verification",
      );
    }
    return c.body(null, 204);
  });

  app.post(`${BASE}/confirm-verification`, async (c) => {
    const col = authCol(c);
    if (col.slug === SUPERUSERS) throw badRequest("All superusers are verified by default.");
    const token = str((await form(c)).token);
    let error: FieldError | null = null;
    let found: Awaited<ReturnType<typeof checkToken>>["v"];
    if (!token) error = required;
    else if (!tokenClaims(token).email) {
      error = { code: "validation_invalid_token_claims", message: "Missing email token claim." };
    } else {
      const r = await checkToken(col, token, "verification");
      error = r.error ?? null;
      found = r.v;
      if (found && found.row.email !== found.claims.email) {
        error = {
          code: "validation_token_email_mismatch",
          message: "The record email doesn't match with the requested token claims.",
        };
      }
    }
    validate({ token: error });
    if (!found!.row.verified) await save(col, found!.claims.id, { verified: true });
    sentAt.delete(`verification:${col.slug}:${found!.claims.id}`);
    return c.body(null, 204);
  });

  app.post(`${BASE}/request-password-reset`, async (c) => {
    const col = authCol(c);
    const email = str((await form(c)).email);
    validate({ email: emailError(email) });
    const row = byEmail(col, email);
    const key = `passwordReset:${col.slug}:${row?.id}`;
    if (row && !throttled(key)) {
      await mailInBackground(
        key,
        "Failed to send password reset email",
        row.email,
        "resetPassword",
        col,
        row,
        "passwordReset",
      );
    }
    return c.body(null, 204);
  });

  app.post(`${BASE}/confirm-password-reset`, async (c) => {
    const col = authCol(c);
    const b = await form(c);
    const [token, password, passwordConfirm] = [str(b.token), str(b.password), str(b.passwordConfirm)];
    const t = token ? await checkToken(col, token, "passwordReset") : { error: undefined, v: undefined };
    validate({
      token: token ? t.error ?? null : required,
      password: password ? length(password, MIN_PASSWORD, 255) : required,
      passwordConfirm: !passwordConfirm
        ? required
        : passwordConfirm !== password
        ? { code: "validation_values_mismatch", message: "Values don't match." }
        : null,
    });
    const { row, claims } = t.v!;
    // A reset link proves mailbox ownership, so PB also verifies the email it was sent to.
    const verify = !row.verified && row.email === claims.email ? { verified: true } : {};
    await save(col, claims.id, { password, passwordConfirm, ...verify });
    sentAt.delete(`passwordReset:${col.slug}:${claims.id}`);
    return c.body(null, 204);
  });

  app.post(`${BASE}/request-email-change`, async (c) => {
    const col = authCol(c);
    const user = c.get("user");
    if (!user) throw unauthorized("The request requires valid record authorization token.");
    if (user.collection !== col.slug) throw forbidden("The request requires valid record authorization token.");
    if (col.slug === SUPERUSERS) throw badRequest("All superusers can change their emails directly.");
    const newEmail = str((await form(c)).newEmail);
    const row = byId(col, user.id)!;
    let error = emailError(newEmail);
    if (!error && newEmail === row.email) {
      error = { code: "validation_not_in_invalid", message: "Must not be in list." };
    }
    const taken = !error && byEmail(col, newEmail);
    if (taken && taken.id !== row.id) {
      error = { code: "validation_invalid_new_email", message: "Invalid new email address." };
    }
    validate({ newEmail: error });
    try {
      await mail(newEmail, "confirmEmailChange", col, row, "emailChange", { newEmail });
    } catch {
      throw badRequest("Failed to request email change.");
    }
    return c.body(null, 204);
  });

  app.post(`${BASE}/confirm-email-change`, async (c) => {
    const col = authCol(c);
    if (col.slug === SUPERUSERS) throw badRequest("All superusers can change their emails directly.");
    const b = await form(c);
    const [token, password] = [str(b.token), str(b.password)];
    let tokenError: FieldError | null = null;
    let found: Awaited<ReturnType<typeof checkToken>>["v"];
    const newEmail = str(tokenClaims(token).newEmail);
    if (!token) tokenError = required;
    else if (!newEmail) {
      tokenError = {
        code: "validation_invalid_token_payload",
        message: "Invalid token payload - newEmail must be set.",
      };
    } else {
      const r = await checkToken(col, token, "emailChange");
      tokenError = r.error ?? null;
      found = r.v;
      if (found && byEmail(col, newEmail)) {
        tokenError = { code: "validation_invalid_token_email", message: "The new email address is invalid." };
        found = undefined;
      }
    }
    let passwordError = password ? length(password, 1, 100) : required;
    if (!passwordError && !(found && await verifyPassword(password, String(found.row.passwordHash ?? "")))) {
      passwordError = { code: "validation_invalid_password", message: "Missing or invalid auth record password." };
    }
    validate({ token: tokenError, password: passwordError });
    await save(col, found!.claims.id, { email: newEmail, verified: true });
    return c.body(null, 204);
  });

  app.post(`${BASE}/impersonate/:id`, async (c) => {
    const user = c.get("user");
    if (!user) throw unauthorized("The request requires superuser authorization token.");
    if (user.collection !== SUPERUSERS) throw forbidden("The authorized record is not allowed to perform this action.");
    const col = authCol(c);
    const row = byId(col, c.req.param("id") ?? "");
    if (!row) throw notFound();
    const duration = (await form(c)).duration ?? 0;
    if (typeof duration !== "number" || !Number.isInteger(duration) || duration < 0) {
      throw new ApiError(400, "An error occurred while validating the submitted data.", {
        duration: { code: "validation_min_greater_equal_than_required", message: "Must be no less than 0." },
      });
    }
    // PB NewStaticAuthToken: zero falls back to the collection's auth duration.
    const token = await signToken(col.slug, row, "auth", {
      ttl: duration > 0 ? duration : undefined,
      refreshable: false,
    });
    return c.json({ token, record: await ownRecord(ctx, col, row.id, c) });
  });
}
