import type { DatabaseSync, StatementSync } from "node:sqlite";

// Deno 2.9 ships node:sqlite's setAuthorizer and limits at runtime, but its @types/node lags behind; this file is the
// one place that bridges the gap. The codes are SQLite's own (sqlite3.h), stable across versions.

export const SQLITE_OK = 0;
export const SQLITE_DENY = 1;
export const SQLITE_READ = 20;
export const SQLITE_SELECT = 21;
export const SQLITE_FUNCTION = 31;
export const SQLITE_RECURSIVE = 33;

export type Authorizer = (
  action: number,
  arg1: string | null,
  arg2: string | null,
  dbName: string | null,
  trigger: string | null,
) => number;

export interface SqliteLimits {
  length: number;
  sqlLength: number;
  exprDepth: number;
  compoundSelect: number;
  column: number;
}

type Ext = DatabaseSync & { setAuthorizer(fn: Authorizer | null): void; limits: SqliteLimits };

export function setAuthorizer(db: DatabaseSync, fn: Authorizer | null): void {
  (db as Ext).setAuthorizer(fn);
}

export function setLimits(db: DatabaseSync, limits: Partial<SqliteLimits>): void {
  Object.assign((db as Ext).limits, limits);
}

/** Rows as arrays: a JOIN's duplicate column names would collapse in objects. */
export function returnArrays(stmt: StatementSync): void {
  (stmt as StatementSync & { setReturnArrays(on: boolean): void }).setReturnArrays(true);
}
