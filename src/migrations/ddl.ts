import type { DatabaseSync } from "node:sqlite";
import type { CollectionConfig } from "../core/types.ts";
import {
  authColumns,
  collectionToTable,
  columnSql,
  createIndexSql,
  createTableSql,
  fieldToColumn,
  indexName,
  quoteIdent,
  tableName,
} from "../schema/mod.ts";
import type { MigrationOp, Snapshot } from "./types.ts";
import { createViewSql } from "../view/mod.ts";
import { applyOps, need } from "./ops.ts";

/** Ops as SQLite DDL: table rebuilds, implicit auth columns and the views recreated around every batch. */

/** Rebuilds a table to the `after` shape, copying shared columns; SQLite cannot drop/alter columns in place. */
function rebuild(slug: string, after: Snapshot, before: Snapshot): string[] {
  const t = collectionToTable(need(after, slug));
  const old = new Set(collectionToTable(need(before, slug)).columns.map((c) => c.name));
  const tmp = `_new_${t.name}`;
  const cols = t.columns.filter((c) => old.has(c.name)).map((c) => quoteIdent(c.name)).join(", ");
  // Needs foreign_keys OFF (see up): with FKs on, DROP of a referenced table fails or rewrites child REFERENCES.
  return [
    createTableSql(t, tmp),
    `INSERT INTO ${quoteIdent(tmp)} (${cols}) SELECT ${cols} FROM ${quoteIdent(t.name)}`,
    `DROP TABLE ${quoteIdent(t.name)}`,
    `ALTER TABLE ${quoteIdent(tmp)} RENAME TO ${quoteIdent(t.name)}`,
    ...t.indexes.map((i) => createIndexSql(t.name, i)),
  ];
}

/** Translates one op to DDL statements (SQLite table rebuild for alter/remove). */
export function opToSql(op: MigrationOp, before: Snapshot): string[] {
  // Views are dropped before and recreated after every batch (see apply), so their ops only move the snapshot.
  if (op.op === "alterView") return [];
  if (op.op === "createCollection" && op.collection.view) return [];
  if (op.op === "dropCollection" && before[op.slug]?.view) return [];
  switch (op.op) {
    case "createCollection": {
      const t = collectionToTable(op.collection);
      return [createTableSql(t), ...t.indexes.map((i) => createIndexSql(t.name, i))];
    }
    case "dropCollection":
      return [`DROP TABLE ${quoteIdent(tableName(op.slug))}`];
    case "addField": {
      const col = fieldToColumn(op.field);
      if (!col) return [];
      const t = tableName(op.slug);
      const out = [`ALTER TABLE ${quoteIdent(t)} ADD COLUMN ${columnSql(col)}`];
      if (col.unique) {
        out.push(createIndexSql(t, { name: indexName(op.slug, [col.name]), columns: [col.name], unique: true }));
      }
      return out;
    }
    case "removeField": {
      const f = need(before, op.slug).fields.find((x) => x.name === op.name);
      if (f?.virtual) return [];
      return rebuild(op.slug, applyOps(before, [op]), before);
    }
    case "alterField": {
      const old = need(before, op.slug).fields.find((x) => x.name === op.field.name);
      if (old?.virtual && op.field.virtual) return [];
      return rebuild(op.slug, applyOps(before, [op]), before);
    }
    case "addIndex": {
      const name = indexName(op.slug, op.index.fields, op.index.name);
      const { fields: columns, unique, desc, where } = op.index;
      return [
        createIndexSql(tableName(op.slug), {
          name,
          columns,
          unique: !!unique,
          ...(desc?.length ? { desc } : {}),
          ...(where ? { where } : {}),
        }),
      ];
    }
    case "dropIndex":
      return [`DROP INDEX IF EXISTS ${quoteIdent(op.name)}`];
  }
}

/**
 * Implicit auth columns live in code, not in snapshots, so a new one (emailVisibility) never shows up in a diff:
 * add whatever an older auth table lacks, with the column's default, on every up.
 */
export function ensureAuthColumns(db: DatabaseSync, s: Snapshot): void {
  for (const c of Object.values(s)) {
    if (!c.auth || c.view) continue;
    const t = tableName(c.slug);
    const have = new Set(
      (db.prepare(`PRAGMA table_info(${quoteIdent(t)})`).all() as { name: string }[]).map((r) => r.name),
    );
    for (const col of authColumns()) {
      if (!have.has(col.name)) db.exec(`ALTER TABLE ${quoteIdent(t)} ADD COLUMN ${columnSql(col)}`);
    }
  }
}

/** Views as the snapshot's collections compile them (view sources resolved against the same snapshot). */
export function viewStatements(s: Snapshot): { slug: string; sql: string }[] {
  const all = Object.values(s) as unknown as CollectionConfig[];
  return Object.values(s).filter((c) => c.view).map((c) => ({
    slug: c.slug,
    sql: createViewSql(c.slug, c.view!, all),
  }));
}

/** Creates views in dependency order: a view over another view waits for it, so retry until a pass adds none. */
export function createViews(db: DatabaseSync, s: Snapshot): void {
  let left = viewStatements(s);
  while (left.length) {
    const failed: typeof left = [];
    let lastError: unknown;
    for (const v of left) {
      try {
        db.exec(v.sql);
      } catch (e) {
        failed.push(v);
        lastError = e;
      }
    }
    if (failed.length === left.length) {
      throw new Error(`cannot create views ${failed.map((v) => v.slug).join(", ")}: ${lastError}`);
    }
    left = failed;
  }
}
