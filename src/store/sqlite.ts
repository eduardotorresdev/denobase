import type { DatabaseSync, SQLInputValue, StatementSync } from "node:sqlite";
import type { CollectionConfig, Doc, Field, Where } from "../core/types.ts";
import { andWhere, type CompiledQuery, type SqlFragment } from "../query/mod.ts";
import { decoderFor, fromDb, quoteIdent } from "../schema/mod.ts";
import { deps } from "../engine/deps.ts";
import { storedFields } from "../engine/fields.ts";
import { nowStamp } from "../core/time.ts";
import type { Query } from "./query.ts";
import { traceQuery } from "../telemetry/instrument/store.ts";

/**
 * The SQLite side of the store: Query AST in, decoded rows out. No hooks, access or validation here; the engine
 * wraps these in its pipelines. Everything SQL the record layer runs lives in this file.
 */

/** andWhere() of nothing yields {and: []}; treat it as no filter so the compiler never sees an empty group. */
function isEmpty(w?: Where): boolean {
  if (!w) return true;
  const keys = Object.keys(w);
  return keys.length === 0 || (keys.length === 1 && Array.isArray(w.and) && w.and.length === 0);
}

function fragment(c: CollectionConfig, where?: Where): SqlFragment {
  return isEmpty(where) ? { sql: "", params: [], joins: [] } : deps.whereToSql(c, where!, deps.collections());
}

/** Prepared statements per connection, by SQL. A cap keeps the IN lists of every size from growing it forever. */
const statements = new WeakMap<DatabaseSync, Map<string, StatementSync>>();
const STATEMENTS_PER_DB = 1000;

/**
 * db.prepare compiles the SQL again on every call, a good share of a write that runs the same few statements per
 * row. The record layer only runs get/all/run, never a live iterator, so one statement per SQL can be reused; SQLite
 * re-prepares it by itself after a schema change.
 */
function prepare(db: DatabaseSync, sql: string): StatementSync {
  let byDb = statements.get(db);
  if (!byDb) statements.set(db, byDb = new Map());
  let stmt = byDb.get(sql);
  if (!stmt) {
    if (byDb.size >= STATEMENTS_PER_DB) byDb.clear();
    byDb.set(sql, stmt = db.prepare(sql));
  }
  return stmt;
}

function table(c: CollectionConfig): string {
  return quoteIdent(deps.tableName(c.slug));
}

type RowDecoder = (row: Record<string, unknown>) => Doc;

/**
 * One decoder per collection, rebuilt when what it was compiled from changes: the fields array (views and migrations
 * swap it), auth (adds implicit fields) or the deps.fromDb seam (engine tests swap it).
 */
const decoders = new WeakMap<
  CollectionConfig,
  { fields: Field[]; length: number; auth: unknown; fromDb: unknown; decode: RowDecoder }
>();

function rowDecoder(c: CollectionConfig): RowDecoder {
  const hit = decoders.get(c);
  if (
    hit && hit.fields === c.fields && hit.length === c.fields.length && hit.auth === c.auth &&
    hit.fromDb === deps.fromDb
  ) return hit.decode;
  const stored = storedFields(c);
  const names = stored.map((f) => f.name);
  const seam = deps.fromDb;
  const fns = stored.map((f) => seam === fromDb ? decoderFor(f) : (v: unknown) => seam(f, v));
  // A generated object literal gives every record of the collection one shape, built in a single allocation (V8
  // builds keyed stores in a loop through shape transitions, ~10x slower). Names enter the source as JSON strings.
  const k = (name: string) => JSON.stringify(name);
  const props = ["id", "created", "updated"].map((x) => `${k(x)}: row[${k(x)}]`)
    .concat(names.map((x, i) => `${k(x)}: fns[${i}](row[${k(x)}])`));
  const decode = new Function("fns", `return (row) => ({ ${props.join(", ")} });`)(fns) as RowDecoder;
  decoders.set(c, { fields: c.fields, length: c.fields.length, auth: c.auth, fromDb: seam, decode });
  return decode;
}

/** A stored row as a record: id, created, updated, then every stored field in config order, PB zero values. */
export function decode(c: CollectionConfig, row: Record<string, unknown>): Doc {
  return rowDecoder(c)(row);
}

/**
 * FROM/WHERE shared by find and count: the Where (access, caller) ANDed with a compiled PB filter. The filter's
 * joins go first because their ON clauses may bind params; the Where's joins never do.
 */
function body(
  c: CollectionConfig,
  where?: Where,
  pb?: CompiledQuery,
): { sql: string; params: SQLInputValue[]; joined: boolean } {
  const f = fragment(c, where);
  const joins = [...(pb?.joins ?? []), ...f.joins].join(" ");
  const conds = [f.sql, pb?.where].filter(Boolean);
  const cond = conds.length === 0 ? "" : conds.length === 1 ? conds[0]! : conds.map((x) => `(${x})`).join(" AND ");
  return {
    sql: `FROM ${table(c)} ${joins}${cond ? ` WHERE ${cond}` : ""}`,
    joined: joins.length > 0,
    params: [...(pb?.joinParams ?? []), ...f.params, ...(pb?.params ?? [])],
  };
}

/**
 * Only joins (relation paths fanning out on hasMany) can repeat a row: DISTINCT is paid only then, as PB does. That
 * holds for views too: PB requires a view's id to be unique, and a DISTINCT over a view makes SQLite materialize and
 * compare every row of it before LIMIT, however few the page shows.
 */
function distinct(joined: boolean): boolean {
  return joined;
}

/** Rows matching the query. pb carries a compiled PB filter and/or sort (its ORDER BY replaces q.orderBy). */
export function findMany(db: DatabaseSync, c: CollectionConfig, q: Query = {}, pb?: CompiledQuery): Doc[] {
  const t = table(c);
  const b = body(c, q.where, pb);
  const order = pb?.orderBy || deps.orderByToSql(c, q.orderBy);
  // A whole-number LIMIT goes in the SQL text: bound as a parameter it costs SQLite ~25 us more per statement (a
  // findOne by id went from 10 to 37 us), and the distinct limits a program uses are few (1, the page sizes), so the
  // statement cache stays small. OFFSET varies with the page and stays bound.
  const literal = q.limit !== undefined && Number.isSafeInteger(q.limit);
  const page = q.limit !== undefined
    ? (literal ? ` LIMIT ${q.limit} OFFSET ?` : " LIMIT ? OFFSET ?")
    : q.offset
    ? " LIMIT -1 OFFSET ?"
    : "";
  const pageParams = q.limit !== undefined
    ? (literal ? [q.offset ?? 0] : [q.limit, q.offset ?? 0])
    : q.offset
    ? [q.offset]
    : [];
  const sql = `SELECT ${distinct(b.joined) ? "DISTINCT " : ""}${t}.* ${b.sql} ${order}${page}`;
  const rows = traceQuery("SELECT", c.slug, sql, () => prepare(db, sql).all(...b.params, ...pageParams)) as Record<
    string,
    unknown
  >[];
  const dec = rowDecoder(c);
  const out = new Array<Doc>(rows.length);
  for (let i = 0; i < rows.length; i++) out[i] = dec(rows[i]);
  return out;
}

export function count(db: DatabaseSync, c: CollectionConfig, where?: Where, pb?: CompiledQuery): number {
  const b = body(c, where, pb);
  // A view may repeat an id (a SELECT the database cannot hold to a key): the total counts ids, as PB's
  // COUNT(DISTINCT id), while the page lists every row it selects.
  const n = distinct(b.joined) || c.view ? `COUNT(DISTINCT ${table(c)}."id")` : "COUNT(*)";
  const sql = `SELECT ${n} AS n ${b.sql}`;
  return Number(traceQuery("SELECT", c.slug, sql, () => prepare(db, sql).get(...b.params) as { n: number }).n);
}

/** One row by id, optionally constrained by an access Where (null when filtered out or missing). */
export function findOne(db: DatabaseSync, c: CollectionConfig, id: string, where?: Where): Doc | null {
  return findMany(db, c, { where: andWhere({ id: { equals: id } }, where), limit: 1 })[0] ?? null;
}

function columns(c: CollectionConfig, data: Record<string, unknown>): [Field, SQLInputValue][] {
  return storedFields(c).filter((f) => f.name in data).map((f) => [f, deps.toDb(f, data[f.name]) as SQLInputValue]);
}

export function insert(db: DatabaseSync, c: CollectionConfig, id: string, data: Record<string, unknown>): void {
  const now = nowStamp();
  const cols = columns(c, data);
  const names = ['"id"', '"created"', '"updated"', ...cols.map(([f]) => quoteIdent(f.name))];
  const sql = `INSERT INTO ${table(c)} (${names.join(", ")}) VALUES (${names.map(() => "?").join(", ")})`;
  traceQuery("INSERT", c.slug, sql, () => prepare(db, sql).run(id, now, now, ...cols.map(([, v]) => v)));
}

export function update(db: DatabaseSync, c: CollectionConfig, id: string, data: Record<string, unknown>): void {
  const cols = columns(c, data);
  const sets = ['"updated" = ?', ...cols.map(([f]) => `${quoteIdent(f.name)} = ?`)];
  const sql = `UPDATE ${table(c)} SET ${sets.join(", ")} WHERE "id" = ?`;
  traceQuery("UPDATE", c.slug, sql, () => prepare(db, sql).run(nowStamp(), ...cols.map(([, v]) => v), id));
}

/** Bound values per statement, under SQLite's default cap of 32766. */
const VARS_PER_STATEMENT = 30000;

/**
 * Updates many rows with one statement per set of written columns (one, when every row writes the same fields),
 * the values bound as a VALUES table, and returns the written records by id. Every row gets the same `updated`.
 */
export function updateMany(
  db: DatabaseSync,
  c: CollectionConfig,
  rows: readonly { id: string; data: Record<string, unknown> }[],
): Map<string, Doc> {
  const out = new Map<string, Doc>();
  const now = nowStamp();
  const grupos = new Map<string, { names: string[]; values: SQLInputValue[][] }>();
  for (const r of rows) {
    const cols = columns(c, r.data);
    const key = cols.map(([f]) => f.name).join("\u0000");
    let g = grupos.get(key);
    if (!g) grupos.set(key, g = { names: cols.map(([f]) => f.name), values: [] });
    g.values.push([r.id, ...cols.map(([, v]) => v)]);
  }
  for (const { names, values } of grupos.values()) {
    const porLinha = names.length + 1;
    const linhas = Math.max(1, Math.floor((VARS_PER_STATEMENT - 1) / porLinha));
    const cte = ['"id"', ...names.map(quoteIdent)].join(", ");
    const sets = ['"updated" = ?', ...names.map((n) => `${quoteIdent(n)} = v.${quoteIdent(n)}`)].join(", ");
    const tupla = `(${Array(porLinha).fill("?").join(", ")})`;
    for (let i = 0; i < values.length; i += linhas) {
      const fatia = values.slice(i, i + linhas);
      const sql = `WITH v(${cte}) AS (VALUES ${Array(fatia.length).fill(tupla).join(", ")}) ` +
        `UPDATE ${table(c)} SET ${sets} FROM v WHERE ${table(c)}."id" = v."id" RETURNING *`;
      // Not the statement cache: the row count makes each text different. The VALUES come first in the text, so
      // their parameters too.
      const lidas = traceQuery("UPDATE", c.slug, sql, () => db.prepare(sql).all(...fatia.flat(), now));
      for (const row of lidas) out.set(String(row.id), decode(c, row as Record<string, unknown>));
    }
  }
  return out;
}

export function remove(db: DatabaseSync, c: CollectionConfig, id: string): void {
  const sql = `DELETE FROM ${table(c)} WHERE "id" = ?`;
  traceQuery("DELETE", c.slug, sql, () => prepare(db, sql).run(id));
}

/** Whether another row already holds value in field (the unique check validate() cannot see). */
export function taken(db: DatabaseSync, c: CollectionConfig, f: Field, value: unknown, exceptId: string): boolean {
  const sql = `SELECT 1 FROM ${table(c)} WHERE ${quoteIdent(f.name)} = ? AND "id" != ? LIMIT 1`;
  return !!traceQuery(
    "SELECT",
    c.slug,
    sql,
    () => prepare(db, sql).get(deps.toDb(f, value) as SQLInputValue, exceptId),
  );
}

/**
 * Whether every id exists in the target collection's table: one statement for the whole list, so a multi relation
 * of fifty ids (a volume's Pecas) costs one read, not fifty.
 */
export function allExist(db: DatabaseSync, targetSlug: string, ids: string[]): boolean {
  const unicos = [...new Set(ids)];
  if (!unicos.length) return true;
  const t = quoteIdent(deps.tableName(targetSlug));
  const sql = `SELECT count(*) AS n FROM ${t} WHERE "id" IN (SELECT value FROM json_each(?))`;
  return traceQuery("SELECT", targetSlug, sql, () => {
    const row = prepare(db, sql).get(JSON.stringify(unicos)) as { n: number } | undefined;
    return Number(row?.n ?? 0) === unicos.length;
  });
}

/** The raw row (stored columns as SQLite has them), for relaying a delete to another thread. */
export function selectRow(db: DatabaseSync, slug: string, id: string): Record<string, unknown> | undefined {
  const sql = `SELECT * FROM ${quoteIdent(deps.tableName(slug))} WHERE "id" = ?`;
  return db.prepare(sql).get(id) as Record<string, unknown> | undefined;
}

/** Puts a raw row back as it was (selectRow's output); only inside a transaction that will roll it back. */
export function reinsertRow(db: DatabaseSync, slug: string, row: Record<string, unknown>): void {
  const names = Object.keys(row);
  const sql = `INSERT INTO ${quoteIdent(deps.tableName(slug))} (${names.map(quoteIdent).join(", ")}) VALUES (${
    names.map(() => "?").join(", ")
  })`;
  db.prepare(sql).run(...names.map((n) => row[n] as SQLInputValue));
}
