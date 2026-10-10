/**
 * Schema migrations: collections in code are snapshotted, diffed into ops, stored as a DAG of JSON files and
 * applied as SQLite DDL. Each concern has its file; this is the public face (consumers use `migrations.*`).
 */
export type { CollectionSnapshot, Migration, MigrationOp, MigrationStatus, Snapshot } from "./types.ts";
export { configToSnapshot } from "./snapshot.ts";
export { applyOps, applyOpsLenient, diff, normalizeOp } from "./ops.ts";
export { heads, replay, topoSort } from "./graph.ts";
export { ensureAuthColumns, opToSql } from "./ddl.ts";
export { ensureMigrationsTable, status, up } from "./runner.ts";
export { create, loadMigrations, MIGRATIONS_DIR, reconcile, setMigrationsDir, writeSnapshot } from "./files.ts";
