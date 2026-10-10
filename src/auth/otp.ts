import type { DatabaseSync } from "node:sqlite";
import { isAuthCollection } from "../core/registry.ts";
import { type Mailer, sendInBackground } from "./mailer.ts";
import type { Doc } from "../core/types.ts";
import { badRequest } from "../core/errors.ts";
import { newId } from "../core/db.ts";
import { publicAuthRecord, quoteIdent } from "./jwt.ts";
import { renderTemplate, TEMPLATES } from "./templates.ts";
import { deleteInBatches } from "../cron/tasks/batched_delete.ts";
import { DEFAULT_SETTINGS, type Settings } from "../settings/mod.ts";

export const OTP_TTL_SEC = 180;
export const OTP_MAX_ATTEMPTS = 5;
const OTP_LENGTH = 8;

/** Creates _otps table if missing (system table, not a migration-managed collection). */
export function ensureOtpTable(db: DatabaseSync): void {
  db.exec(`CREATE TABLE IF NOT EXISTS _otps (
    id TEXT PRIMARY KEY, collection TEXT NOT NULL, recordId TEXT NOT NULL, codeHash TEXT NOT NULL,
    attempts INTEGER NOT NULL DEFAULT 0, expires INTEGER NOT NULL, created TEXT NOT NULL)`);
}

async function sha256(s: string): Promise<string> {
  const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return Array.from(new Uint8Array(d), (x) => x.toString(16).padStart(2, "0")).join("");
}

function randomCode(): string {
  const b = crypto.getRandomValues(new Uint32Array(OTP_LENGTH));
  return Array.from(b, (x) => String(x % 10)).join("");
}

function authTable(collection: string): string {
  if (!isAuthCollection(collection)) throw badRequest("Invalid auth collection.");
  return quoteIdent(collection);
}

/** Drops expired codes (PB __pbOTPCleanup__). */
export async function deleteExpiredOtps(db: DatabaseSync, now: number = Date.now()): Promise<void> {
  ensureOtpTable(db);
  await deleteInBatches(db, "_otps", "expires < ?", [now]);
}

/**
 * Always returns an otpId, even for unknown emails, so emails can't be enumerated. The code mail goes out in the
 * background, as PB does: the answer never waits for the provider, and a failed send deletes
 * the otp and is reported to onMailError.
 */
export async function requestOtp(
  db: DatabaseSync,
  mailer: Mailer,
  collection: string,
  email: string,
  meta: Settings["meta"] = DEFAULT_SETTINGS.meta,
  onMailError: (err: unknown) => void = (err) => console.error("Failed to send OTP email", err),
): Promise<{ otpId: string }> {
  const table = authTable(collection);
  ensureOtpTable(db);
  const otpId = newId();
  const row = db.prepare(`SELECT id FROM ${table} WHERE email = ? COLLATE NOCASE`).get(email) as
    | { id: string }
    | undefined;
  if (!row) return { otpId };
  const code = randomCode();
  // Code is stored hashed so a DB leak does not grant logins inside the 3 min window.
  db.prepare(
    `INSERT INTO _otps (id, collection, recordId, codeHash, attempts, expires, created) VALUES (?,?,?,?,0,?,?)`,
  )
    .run(
      otpId,
      collection,
      row.id,
      await sha256(otpId + code),
      Date.now() + OTP_TTL_SEC * 1000,
      new Date().toISOString(),
    );
  sendInBackground(
    () => mailer.send({ to: email, ...renderTemplate(TEMPLATES.otp, meta, { "{OTP_ID}": otpId, "{OTP}": code }) }),
    (err) => {
      db.prepare(`DELETE FROM _otps WHERE id = ?`).run(otpId);
      onMailError(err);
    },
  );
  return { otpId };
}

/** Single use; counts attempts; throws ApiError 400 on bad/expired. Returns the auth record. */
export async function verifyOtp(db: DatabaseSync, collection: string, otpId: string, code: string): Promise<Doc> {
  const table = authTable(collection);
  ensureOtpTable(db);
  const fail = () => badRequest("Invalid or expired OTP.");
  const otp = db.prepare(`SELECT * FROM _otps WHERE id = ? AND collection = ?`).get(otpId, collection) as
    | { recordId: string; codeHash: string }
    | undefined;
  if (!otp) throw fail();
  // Claim an attempt atomically before awaiting the hash, so parallel guesses cannot all pass a stale count.
  const claimed = db.prepare(`UPDATE _otps SET attempts = attempts + 1 WHERE id = ? AND attempts < ? AND expires >= ?`)
    .run(otpId, OTP_MAX_ATTEMPTS, Date.now());
  if (Number(claimed.changes) === 0) {
    db.prepare(`DELETE FROM _otps WHERE id = ?`).run(otpId);
    throw fail();
  }
  if ((await sha256(otpId + String(code))) !== otp.codeHash) throw fail();
  // Another request may have consumed it while hashing; only the one that deletes it logs in.
  if (Number(db.prepare(`DELETE FROM _otps WHERE id = ?`).run(otpId).changes) === 0) throw fail();
  const row = db.prepare(`SELECT * FROM ${table} WHERE id = ?`).get(otp.recordId) as
    | Record<string, unknown>
    | undefined;
  if (!row) throw fail();
  // PB marks the email verified once an OTP proves mailbox ownership.
  if (!row.verified) {
    db.prepare(`UPDATE ${table} SET verified = 1 WHERE id = ?`).run(otp.recordId);
    row.verified = 1;
  }
  return publicAuthRecord(row);
}
