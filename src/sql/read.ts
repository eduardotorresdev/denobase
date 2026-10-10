import type { DatabaseSync, SQLInputValue, StatementSync } from "node:sqlite";
import {
  setAuthorizer,
  SQLITE_DENY,
  SQLITE_FUNCTION,
  SQLITE_OK,
  SQLITE_READ,
  SQLITE_RECURSIVE,
  SQLITE_SELECT,
} from "./sqlite_ext.ts";
import { traceQuery } from "../telemetry/instrument/store.ts";

/** What a read may compile to: reading columns, selecting, calling functions (json_each, sum...), recursive CTEs. */
const READ_OPS = new Set([
  SQLITE_SELECT,
  SQLITE_READ,
  SQLITE_FUNCTION,
  SQLITE_RECURSIVE,
]);

/** Thrown when sql is anything but a single read; it never ran. */
export class ReadOnlySqlError extends Error {}

/** Prepared reads kept per connection, so a hot statement pays its compile (and the authorizer pass) once. */
const cache = new WeakMap<DatabaseSync, Map<string, StatementSync>>();
/** Distinct SQL texts kept per connection: callers that inline a variable IN list would otherwise grow it forever. */
const CACHE_LIMIT = 256;

function prepareRead(db: DatabaseSync, sql: string): StatementSync {
  let porSql = cache.get(db);
  if (!porSql) cache.set(db, porSql = new Map());
  const hit = porSql.get(sql);
  if (hit) {
    // Least recently used goes first: re-insert on a hit.
    porSql.delete(sql);
    porSql.set(sql, hit);
    return hit;
  }
  let refused = "";
  // prepare is synchronous, so the authorizer cannot leak into another caller's statement.
  setAuthorizer(db, (op) => {
    if (READ_OPS.has(op)) return SQLITE_OK;
    refused ||= `operation ${op}`;
    return SQLITE_DENY;
  });
  let stmt: StatementSync;
  try {
    stmt = db.prepare(sql);
  } catch (e) {
    if (refused) throw new ReadOnlySqlError(`selectRows: only reads are allowed (${refused})`);
    throw e;
  } finally {
    setAuthorizer(db, null);
  }
  if (porSql.size >= CACHE_LIMIT) porSql.delete(porSql.keys().next().value!);
  porSql.set(sql, stmt);
  return stmt;
}

/**
 * The documented path for read and aggregation SQL the query builder cannot express (JOIN across collections,
 * json_each over a hasMany/json column, GROUP BY): runs one SELECT/WITH on the app's db, synchronously, with an
 * authorizer that refuses at compile time any write, PRAGMA, ATTACH or DDL. Values go only as params; identifiers
 * through quoteIdent/tableName. It skips access rules and hooks, so only server code that already checked access
 * calls it, and it returns raw columns (json/hasMany as JSON text). Each call is one `db.query` span, and the
 * statement is prepared once per connection and SQL text.
 */
export function selectRows<T = Record<string, unknown>>(
  db: DatabaseSync,
  sql: string,
  params: SQLInputValue[] | Record<string, SQLInputValue> = [],
): T[] {
  const s = prepareRead(db, sql);
  const rows = traceQuery("SELECT", "", sql, () => Array.isArray(params) ? s.all(...params) : s.all(params));
  return rows as T[];
}
