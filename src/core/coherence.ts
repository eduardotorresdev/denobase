import type { DatabaseSync, StatementSync } from "node:sqlite";

/**
 * Several threads (HTTP isolates, the job worker) each hold a connection to the same file and write directly; SQLite
 * serializes the writes. What a thread keeps in memory from the db (a catalog, the settings) goes stale when ANOTHER
 * connection commits: `PRAGMA data_version` changes exactly then (never for this connection's own commits, which
 * the hooks already handle). Entry points (a request, a top-level transaction, a job run) call
 * syncExternalCommits; when the version moved, every registered invalidator runs, and the caches refill lazily.
 */
const invalidators = new Set<(db: DatabaseSync) => void>();
const seen = new WeakMap<DatabaseSync, { stmt: StatementSync; version: number }>();

/** Registers fn to run when another connection committed to db; returns the function that removes it. */
export function onExternalCommit(fn: (db: DatabaseSync) => void): () => void {
  invalidators.add(fn);
  return () => invalidators.delete(fn);
}

/** Whether another connection committed since the last call for db; if so, the invalidators ran. */
export function syncExternalCommits(db: DatabaseSync): boolean {
  let s = seen.get(db);
  if (!s) {
    const stmt = db.prepare("PRAGMA data_version");
    s = { stmt, version: version(stmt) };
    seen.set(db, s);
    return false;
  }
  const v = version(s.stmt);
  if (v === s.version) return false;
  s.version = v;
  for (const fn of invalidators) {
    try {
      fn(db);
    } catch (e) {
      console.error("cache invalidation failed:", e);
    }
  }
  return true;
}

function version(stmt: StatementSync): number {
  return Number((stmt.get() as { data_version: number }).data_version);
}
