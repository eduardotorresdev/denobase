import type { DatabaseSync } from "node:sqlite";

/** Days an unused dynamically registered client is kept. */
export const DCR_UNUSED_DAYS = 30;

/**
 * The authorization server's system tables (like _otps: created on demand, no migration). Every bearer secret
 * (code, refresh token, session id, client secret) is stored only as its SHA-256.
 */
export function ensureOAuthTables(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS _oauth_clients (
      id TEXT PRIMARY KEY, kind TEXT NOT NULL, name TEXT NOT NULL DEFAULT '', uri TEXT NOT NULL DEFAULT '',
      logoUri TEXT NOT NULL DEFAULT '', redirectUris TEXT NOT NULL DEFAULT '[]', grantTypes TEXT NOT NULL DEFAULT '[]',
      scope TEXT NOT NULL DEFAULT '', authMethod TEXT NOT NULL DEFAULT 'none', secretHash TEXT NOT NULL DEFAULT '',
      metadataJSON TEXT NOT NULL DEFAULT '{}', fetchedAt INTEGER NOT NULL DEFAULT 0, expiresAt INTEGER NOT NULL DEFAULT 0,
      created TEXT NOT NULL, lastUsed TEXT NOT NULL DEFAULT '');
    CREATE TABLE IF NOT EXISTS _oauth_requests (
      id TEXT PRIMARY KEY, clientId TEXT NOT NULL, redirectUri TEXT NOT NULL, state TEXT NOT NULL,
      codeChallenge TEXT NOT NULL, resource TEXT NOT NULL, scope TEXT NOT NULL, prompt TEXT NOT NULL DEFAULT '',
      created INTEGER NOT NULL, expires INTEGER NOT NULL, consumed INTEGER NOT NULL DEFAULT 0,
      redirectUriSent INTEGER NOT NULL DEFAULT 1, csrf TEXT NOT NULL DEFAULT '', bindHash TEXT NOT NULL DEFAULT '',
      collection TEXT NOT NULL DEFAULT '', webTried INTEGER NOT NULL DEFAULT 0);
    CREATE TABLE IF NOT EXISTS _oauth_codes (
      codeHash TEXT PRIMARY KEY, grantId TEXT NOT NULL, clientId TEXT NOT NULL, redirectUri TEXT NOT NULL,
      codeChallenge TEXT NOT NULL, resource TEXT NOT NULL, scope TEXT NOT NULL, collection TEXT NOT NULL,
      recordId TEXT NOT NULL, expires INTEGER NOT NULL, used INTEGER NOT NULL DEFAULT 0,
      redirectUriSent INTEGER NOT NULL DEFAULT 1);
    CREATE TABLE IF NOT EXISTS _oauth_grants (
      id TEXT PRIMARY KEY, clientId TEXT NOT NULL, collection TEXT NOT NULL, recordId TEXT NOT NULL,
      resource TEXT NOT NULL, scope TEXT NOT NULL, rememberConsent INTEGER NOT NULL DEFAULT 0, created TEXT NOT NULL,
      lastUsed TEXT NOT NULL DEFAULT '', revokedAt TEXT);
    CREATE UNIQUE INDEX IF NOT EXISTS _oauth_grants_owner ON _oauth_grants (clientId, collection, recordId, resource);
    CREATE TABLE IF NOT EXISTS _oauth_refresh_tokens (
      hash TEXT PRIMARY KEY, grantId TEXT NOT NULL, familyId TEXT NOT NULL, scope TEXT NOT NULL,
      keyHash TEXT NOT NULL, expires INTEGER NOT NULL, consumedAt INTEGER, created INTEGER NOT NULL);
    CREATE INDEX IF NOT EXISTS _oauth_refresh_family ON _oauth_refresh_tokens (familyId);
    CREATE INDEX IF NOT EXISTS _oauth_refresh_grant ON _oauth_refresh_tokens (grantId);
    CREATE TABLE IF NOT EXISTS _oauth_sessions (
      idHash TEXT PRIMARY KEY, collection TEXT NOT NULL, recordId TEXT NOT NULL, csrf TEXT NOT NULL,
      keyHash TEXT NOT NULL, userAgent TEXT NOT NULL DEFAULT '', ipHash TEXT NOT NULL DEFAULT '',
      created INTEGER NOT NULL, expires INTEGER NOT NULL);
  `);
  // Tables created before these columns existed (CREATE IF NOT EXISTS leaves them as they were).
  addColumn(db, "_oauth_requests", "redirectUriSent", "INTEGER NOT NULL DEFAULT 1");
  addColumn(db, "_oauth_requests", "csrf", "TEXT NOT NULL DEFAULT ''");
  addColumn(db, "_oauth_requests", "bindHash", "TEXT NOT NULL DEFAULT ''");
  addColumn(db, "_oauth_requests", "collection", "TEXT NOT NULL DEFAULT ''");
  addColumn(db, "_oauth_requests", "webTried", "INTEGER NOT NULL DEFAULT 0");
  addColumn(db, "_oauth_codes", "redirectUriSent", "INTEGER NOT NULL DEFAULT 1");
}

function addColumn(db: DatabaseSync, table: string, column: string, def: string): void {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[];
  if (!cols.some((c) => c.name === column)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${def}`);
}

const tableExists = (db: DatabaseSync, name: string) =>
  !!db.prepare(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?`).get(name);

/**
 * Hourly system job: expired requests, codes, sessions and refresh tokens; revoked grants after a month; DCR clients
 * never used for DCR_UNUSED_DAYS; grants whose user is gone (the cascade of a deleted record). Reads no registry, so
 * it runs in the maintenance worker too.
 */
export function cleanupOAuth(db: DatabaseSync, now: number = Date.now()): void {
  if (!tableExists(db, "_oauth_grants")) return;
  db.prepare(`DELETE FROM _oauth_requests WHERE expires < ?`).run(now);
  // Used codes linger until they expire so a replay inside the window still revokes the grant.
  db.prepare(`DELETE FROM _oauth_codes WHERE expires < ?`).run(now);
  db.prepare(`DELETE FROM _oauth_sessions WHERE expires < ?`).run(now);
  db.prepare(`DELETE FROM _oauth_refresh_tokens WHERE expires < ?`).run(now);
  const month = new Date(now - 30 * 86_400_000).toISOString();
  const revoked = db.prepare(`SELECT id FROM _oauth_grants WHERE revokedAt IS NOT NULL AND revokedAt < ?`).all(month);
  for (const g of revoked as { id: string }[]) deleteGrant(db, g.id);
  const unused = new Date(now - DCR_UNUSED_DAYS * 86_400_000).toISOString();
  db.prepare(`DELETE FROM _oauth_clients WHERE kind = 'dcr' AND lastUsed = '' AND created < ?`).run(unused);
  const cols = db.prepare(`SELECT DISTINCT collection FROM _oauth_grants`).all() as { collection: string }[];
  for (const { collection } of cols) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(collection)) continue;
    const orphans = (tableExists(db, collection)
      ? db.prepare(
        `SELECT id FROM _oauth_grants WHERE collection = ? AND recordId NOT IN (SELECT id FROM "${collection}")`,
      ).all(collection)
      : db.prepare(`SELECT id FROM _oauth_grants WHERE collection = ?`).all(collection)) as { id: string }[];
    for (const g of orphans) deleteGrant(db, g.id);
  }
}

/** A grant and everything issued under it. */
export function deleteGrant(db: DatabaseSync, id: string): void {
  db.prepare(`DELETE FROM _oauth_refresh_tokens WHERE grantId = ?`).run(id);
  db.prepare(`DELETE FROM _oauth_codes WHERE grantId = ?`).run(id);
  db.prepare(`DELETE FROM _oauth_grants WHERE id = ?`).run(id);
}

/** Revocation keeps the row (the admin sees it) but kills the refresh tokens and, through gid, the access tokens. */
export function revokeGrant(db: DatabaseSync, id: string, now = new Date()): void {
  db.prepare(`UPDATE _oauth_grants SET revokedAt = ? WHERE id = ? AND revokedAt IS NULL`).run(now.toISOString(), id);
  db.prepare(`DELETE FROM _oauth_refresh_tokens WHERE grantId = ?`).run(id);
  db.prepare(`DELETE FROM _oauth_codes WHERE grantId = ?`).run(id);
}

/** Whether an access token's gid still names a live grant (the /api/mcp check: one primary-key SELECT). */
export function grantActive(db: DatabaseSync, id: string): boolean {
  try {
    const row = db.prepare(`SELECT revokedAt FROM _oauth_grants WHERE id = ?`).get(id) as
      | { revokedAt: string | null }
      | undefined;
    return !!row && row.revokedAt === null;
  } catch {
    // No table yet: no grant was ever issued here, so no gid can be live.
    return false;
  }
}
