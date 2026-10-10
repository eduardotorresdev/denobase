import type { DatabaseSync } from "node:sqlite";
import { tx } from "../core/db.ts";
import type { Migration, MigrationStatus, Snapshot } from "./types.ts";
import { applyOps, normalizeOp } from "./ops.ts";
import { heads, replay, topoSort } from "./graph.ts";
import { createViews, ensureAuthColumns, opToSql, viewStatements } from "./ddl.ts";
import { quoteIdent } from "../schema/mod.ts";

/** Applying migrations to a db: what is applied, what is pending, and up in one transaction. */

export function ensureMigrationsTable(db: DatabaseSync): void {
  db.exec(`CREATE TABLE IF NOT EXISTS "_migrations" (id TEXT PRIMARY KEY NOT NULL, applied TEXT NOT NULL)`);
}

function appliedIds(db: DatabaseSync): Set<string> {
  ensureMigrationsTable(db);
  const rows = db.prepare(`SELECT id FROM "_migrations"`).all() as { id: string }[];
  return new Set(rows.map((r) => r.id));
}

export function status(db: DatabaseSync, ms: Migration[]): MigrationStatus {
  const done = appliedIds(db);
  const sorted = topoSort(ms);
  return {
    applied: sorted.filter((m) => done.has(m.id)).map((m) => m.id),
    pending: sorted.filter((m) => !done.has(m.id)).map((m) => m.id),
    heads: heads(ms),
  };
}

export function refuseMultipleHeads(ms: Migration[]): void {
  const hs = heads(ms);
  if (hs.length > 1) throw new Error(`multiple heads: ${hs.join(", ")}; run reconcile`);
}

/** Applies pending in a tx; throws "multiple heads" when heads(ms).length > 1. Returns applied ids. */
export async function up(db: DatabaseSync, ms: Migration[]): Promise<string[]> {
  refuseMultipleHeads(ms);
  const done = appliedIds(db);
  const sorted = topoSort(ms);
  const snap = replay(sorted.filter((m) => done.has(m.id)));
  const pending = sorted.filter((m) => !done.has(m.id));
  // SQLite's documented rebuild recipe: FKs off outside the tx (the pragma is a no-op inside one), check before commit.
  const fkOn = (db.prepare("PRAGMA foreign_keys").get() as { foreign_keys: number }).foreign_keys === 1;
  const toggle = fkOn && !db.isTransaction;
  if (toggle) db.exec("PRAGMA foreign_keys = OFF");
  try {
    const applied = await apply(db, pending, snap);
    ensureAuthColumns(db, replay(sorted));
    return applied;
  } finally {
    if (toggle) db.exec("PRAGMA foreign_keys = ON");
  }
}

function apply(db: DatabaseSync, pending: Migration[], start: Snapshot): Promise<string[]> {
  let snap = start;
  return tx(db, (d) => {
    const ins = d.prepare(`INSERT INTO "_migrations" (id, applied) VALUES (?, ?)`);
    // A table rebuild fails while a view references it, so views come down first and go back up from the end state.
    if (pending.length) { for (const v of viewStatements(snap)) d.exec(`DROP VIEW IF EXISTS ${quoteIdent(v.slug)}`); }
    for (const m of pending) {
      // Normalized against the live shape: a branch may repeat what an already-applied sibling did.
      for (const op of m.ops.flatMap((o) => normalizeOp(snap, o))) {
        for (const sql of opToSql(op, snap)) d.exec(sql);
        snap = applyOps(snap, [op]);
      }
      ins.run(m.id, new Date().toISOString());
    }
    if (pending.length) createViews(d, snap);
    if (d.prepare("PRAGMA foreign_key_check").all().length) throw new Error("migration left foreign key violations");
    return pending.map((m) => m.id);
  });
}
