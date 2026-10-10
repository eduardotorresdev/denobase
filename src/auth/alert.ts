import type { DatabaseSync } from "node:sqlite";
import { createHash } from "node:crypto";
import { type Mailer, sendInBackground } from "./mailer.ts";
import { newId } from "../core/db.ts";
import { quoteIdent } from "./jwt.ts";
import { isAuthCollection } from "../core/registry.ts";
import { renderTemplate, TEMPLATES } from "./templates.ts";
import { DEFAULT_SETTINGS, type Settings } from "../settings/mod.ts";

/** PB's cap on remembered auth origins: the oldest origins beyond it are dropped. */
export const MAX_AUTH_ORIGINS = 5;

/** PB _authOrigins system table: one row per (record, fingerprint) that has logged in. */
export function ensureAuthOriginsTable(db: DatabaseSync): void {
  db.exec(`CREATE TABLE IF NOT EXISTS _authOrigins (
    id TEXT PRIMARY KEY, collectionRef TEXT NOT NULL, recordRef TEXT NOT NULL, fingerprint TEXT NOT NULL,
    created TEXT NOT NULL, updated TEXT NOT NULL)`);
}

const escapeHtml = (s: string) =>
  s.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&#34;")
    .replaceAll("'", "&#39;");

/** PB types.DateTime string: "2006-01-02 15:04:05.000Z". */
const pbNow = () => new Date().toISOString().replace("T", " ");

export interface AuthAlertInput {
  collection: string;
  recordId: string;
  ip: string;
  userAgent: string;
  meta?: Settings["meta"];
  now?: () => string;
  /** Where a failed send is reported: the mail goes out after the login answered, so nobody awaits it. */
  onMailError?: (err: unknown) => void;
}

/**
 * PB authAlert: remembers the login origin (ip + user agent) and mails the record when it is a new one, except on
 * its very first login. Called after a successful password/OTP auth of a collection with authAlert enabled.
 *
 * Unlike PB, the login never waits for the mail: PB held the response up to 15s on a stuck provider (a production
 * login waited 14.8s on a Resend timeout). The origin is saved and the mail is sent in the background; a failed send
 * goes to onMailError and the origin stays known, so the next login from it does not alert again.
 */
export function authAlert(db: DatabaseSync, mailer: Mailer, i: AuthAlertInput): void {
  ensureAuthOriginsTable(db);
  if (!isAuthCollection(i.collection)) return;
  const record = db.prepare(`SELECT id, email FROM ${quoteIdent(i.collection)} WHERE id = ?`).get(i.recordId) as
    | { id: string; email: string | null }
    | undefined;
  if (!record) return;
  const ua = i.userAgent.length > 200 ? i.userAgent.slice(0, 200) + "..." : i.userAgent;
  const fingerprint = createHash("md5").update(i.ip + ua).digest("hex");
  const now = (i.now ?? pbNow)();
  const origins = db.prepare(
    `SELECT id, fingerprint FROM _authOrigins WHERE collectionRef = ? AND recordRef = ? ORDER BY updated DESC, rowid DESC`,
  ).all(i.collection, record.id) as { id: string; fingerprint: string }[];
  const current = origins.find((o) => o.fingerprint === fingerprint);

  if (current) {
    db.prepare(`UPDATE _authOrigins SET updated = ? WHERE id = ?`).run(now, current.id);
    return;
  }

  // Keep only the most recent MAX_AUTH_ORIGINS, counting the one about to be saved.
  for (const o of origins.slice(MAX_AUTH_ORIGINS - 1)) db.prepare(`DELETE FROM _authOrigins WHERE id = ?`).run(o.id);
  db.prepare(
    `INSERT INTO _authOrigins (id, collectionRef, recordRef, fingerprint, created, updated) VALUES (?,?,?,?,?,?)`,
  ).run(newId(), i.collection, record.id, fingerprint, now, now);

  if (origins.length > 0 && record.email) {
    const info = escapeHtml(`${now} - ${i.ip} ${ua}`);
    const mail = renderTemplate(TEMPLATES.authAlert, i.meta ?? DEFAULT_SETTINGS.meta, { "{ALERT_INFO}": info });
    const email = record.email;
    sendInBackground(
      () => mailer.send({ to: email, ...mail }),
      i.onMailError ?? ((err) => console.error("auth alert mail failed", err)),
    );
  }
}
