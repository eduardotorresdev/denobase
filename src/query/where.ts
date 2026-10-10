import type { CollectionConfig, Field, Where, WhereOp } from "../core/types.ts";
import { badRequest } from "../core/errors.ts";
import { quoteIdent } from "../schema/mod.ts";

/** Parameterized SQL fragment; joins carry LEFT JOINs needed by dotted relation paths. */
export interface SqlFragment {
  sql: string;
  params: (string | number | null)[];
  joins: string[];
}

type Param = string | number | null;

interface Ctx {
  all: CollectionConfig[];
  params: Param[];
  joins: string[];
  /** Same relation path reuses one join so `cargo.a && cargo.b` stays one row. */
  joinAliases: Map<string, string>;
  counter: { n: number };
  /** Values become SQL literals instead of params: a CREATE VIEW cannot bind parameters. */
  inline?: boolean;
  /** Alias prefix, so a Where compiled next to another fragment (a PB rule join) cannot reuse its aliases. */
  prefix?: string;
}

/** Implicit columns every table has, plus auth columns; hidden auth columns are deliberately absent. */
const SYSTEM_FIELDS: Field[] = [
  { name: "id", type: "text" },
  { name: "created", type: "date" },
  { name: "updated", type: "date" },
];
const AUTH_FIELDS: Field[] = [
  { name: "email", type: "email" },
  { name: "emailVisibility", type: "checkbox" },
  { name: "verified", type: "checkbox" },
];

const OPS = new Set([
  "equals",
  "not_equals",
  "in",
  "not_in",
  "like",
  "not_like",
  "exists",
  "greater_than",
  "less_than",
  "greater_than_equal",
  "less_than_equal",
]);

/** Fields reachable from queries: hidden and virtual ones never are, so filters cannot probe secrets. */
export function queryableField(c: CollectionConfig, name: string): Field | undefined {
  const f = [...SYSTEM_FIELDS, ...(c.auth ? AUTH_FIELDS : []), ...c.fields].find((x) => x.name === name);
  return f && !f.hidden && !f.virtual ? f : undefined;
}

function isHasMany(f: Field): boolean {
  return ((f.type === "select" || f.type === "relationship") && !!f.hasMany) ||
    (f.type === "file" && (f.maxSelect ?? 1) > 1);
}

/** Compiles a Payload Where against a collection (resolving dotted relation paths) to SQL. */
export function whereToSql(c: CollectionConfig, w: Where, all: CollectionConfig[]): SqlFragment {
  const ctx: Ctx = { all, params: [], joins: [], joinAliases: new Map(), counter: { n: 0 } };
  const sql = compileWhere(ctx, quoteIdent(c.slug), c, w, 0);
  return { sql, params: ctx.params, joins: ctx.joins };
}

/** Like whereToSql, but rooted at a join alias (a joined collection's read rule, PB's listRuleJoins). */
export function whereToSqlAt(
  c: CollectionConfig,
  alias: string,
  w: Where,
  all: CollectionConfig[],
  prefix: string,
): SqlFragment {
  const ctx: Ctx = { all, params: [], joins: [], joinAliases: new Map(), counter: { n: 0 }, prefix };
  const sql = compileWhere(ctx, quoteIdent(alias), c, w, 0);
  return { sql, params: ctx.params, joins: ctx.joins };
}

function compileWhere(ctx: Ctx, alias: string, c: CollectionConfig, w: Where, depth: number): string {
  if (depth > 32) throw badRequest("Filter is too deeply nested.");
  if (!w || typeof w !== "object" || Array.isArray(w)) throw badRequest("Invalid where.");
  const parts: string[] = [];
  for (const [key, val] of Object.entries(w)) {
    if (val === undefined) continue;
    if (key === "and" || key === "or") {
      if (!Array.isArray(val)) throw badRequest(`Invalid "${key}" clause.`);
      const subs = val.map((s) => compileWhere(ctx, alias, c, s, depth + 1));
      if (subs.length === 0) continue;
      parts.push(`(${subs.join(key === "and" ? " AND " : " OR ")})`);
      continue;
    }
    if (typeof val !== "object" || Array.isArray(val) || val === null) {
      throw badRequest(`Invalid condition on "${key}".`);
    }
    for (const [op, v] of Object.entries(val as WhereOp)) {
      if (v === undefined) continue;
      if (!OPS.has(op)) throw badRequest(`Unknown operator "${op}".`);
      parts.push(compilePath(ctx, alias, c, key.split("."), op, v));
    }
  }
  return parts.length === 0 ? "1=1" : parts.length === 1 ? parts[0] : `(${parts.join(" AND ")})`;
}

function nextAlias(ctx: Ctx, prefix: string): string {
  return quoteIdent(`${ctx.prefix ?? ""}${prefix}${++ctx.counter.n}`);
}

function compilePath(ctx: Ctx, alias: string, c: CollectionConfig, segs: string[], op: string, v: unknown): string {
  const [name, ...rest] = segs;
  const f = queryableField(c, name);
  if (!f) throw badRequest(`Invalid filter field "${segs.join(".")}" on "${c.slug}".`);
  const col = `${alias}.${quoteIdent(f.name)}`;
  if (rest.length === 0) return isHasMany(f) ? arrayCond(ctx, col, f, op, v) : scalarCond(ctx, col, f, op, v);
  if (f.type !== "relationship") throw badRequest(`"${name}" is not a relation.`);
  const target = ctx.all.find((x) => x.slug === f.relationTo);
  if (!target) throw badRequest(`Unknown relation target "${f.relationTo}".`);
  const table = quoteIdent(target.slug);
  if (!f.hasMany) {
    const key = `${alias}.${f.name}`;
    let ja = ctx.joinAliases.get(key);
    if (!ja) {
      ja = nextAlias(ctx, "j");
      ctx.joinAliases.set(key, ja);
      ctx.joins.push(`LEFT JOIN ${table} AS ${ja} ON ${ja}."id" = ${col}`);
    }
    return compilePath(ctx, ja, target, rest, op, v);
  }
  // hasMany relation: any related row matching makes the record match, like PB's multi-match default.
  const je = nextAlias(ctx, "e");
  const t = nextAlias(ctx, "t");
  const sub: Ctx = { ...ctx, joins: [], joinAliases: new Map() };
  const cond = compilePath(sub, t, target, rest, op, v);
  return `EXISTS (SELECT 1 FROM json_each(COALESCE(${col}, '[]')) AS ${je} JOIN ${table} AS ${t} ON ${t}."id" = ${je}."value" ${
    sub.joins.join(" ")
  } WHERE ${cond})`;
}

function toParam(f: Field, v: unknown): Param {
  if (v === null || v === undefined) return null;
  if (typeof v === "boolean") return v ? 1 : 0;
  if (f.type === "checkbox" && (v === "true" || v === "false")) return v === "true" ? 1 : 0;
  // The db keeps dates as text in PB layout ("2006-01-02 15:04:05.000Z"); ISO "T" would compare wrong.
  if (v instanceof Date) return v.toISOString().replace("T", " ");
  if (typeof v === "number") {
    if (!Number.isFinite(v)) throw badRequest("Invalid number in filter.");
    return v;
  }
  if (typeof v === "string") return v;
  return JSON.stringify(v);
}

function likePattern(v: unknown): string {
  const s = String(v ?? "");
  // PB rule: a value with % is a caller-supplied pattern; otherwise match as substring with wildcards escaped.
  return s.includes("%") ? s : `%${s.replace(/[\\%_]/g, (m) => "\\" + m)}%`;
}

function push(ctx: Ctx, p: Param): string {
  if (ctx.inline) return literal(p);
  ctx.params.push(p);
  return "?";
}

/** SQL literal for an already type-checked param; strings are quoted with '' doubling, the only escape SQLite has. */
function literal(p: Param): string {
  if (p === null) return "NULL";
  if (typeof p === "number") return String(p);
  return `'${p.replaceAll("'", "''")}'`;
}

function list(ctx: Ctx, f: Field, v: unknown, op: string): string[] {
  if (!Array.isArray(v)) throw badRequest(`"${op}" expects an array.`);
  return v.map((x) => push(ctx, toParam(f, x)));
}

/** An empty single relation is stored NULL (its foreign key) but may be '' in data migrated from PB. */
const emptyRelation = (f: Field, v: unknown) => f.type === "relationship" && !f.hasMany && v === "";

function scalarCond(ctx: Ctx, e: string, f: Field, op: string, v: unknown): string {
  if (op === "equals" && emptyRelation(f, v)) return `(${e} IS NULL OR ${e} = '')`;
  if (op === "not_equals" && emptyRelation(f, v)) return `(${e} IS NOT NULL AND ${e} <> '')`;
  switch (op) {
    case "equals": {
      const p = toParam(f, v);
      return p === null ? `${e} IS NULL` : `${e} = ${push(ctx, p)}`;
    }
    case "not_equals": {
      const p = toParam(f, v);
      return p === null ? `${e} IS NOT NULL` : `(${e} IS NULL OR ${e} <> ${push(ctx, p)})`;
    }
    case "in": {
      const ph = list(ctx, f, v, op);
      return ph.length ? `${e} IN (${ph.join(", ")})` : "0=1";
    }
    case "not_in": {
      const ph = list(ctx, f, v, op);
      return ph.length ? `(${e} IS NULL OR ${e} NOT IN (${ph.join(", ")}))` : "1=1";
    }
    case "like":
      return `fold(${e}) LIKE fold(${push(ctx, likePattern(v))}) ESCAPE '\\'`;
    case "not_like":
      return `(${e} IS NULL OR fold(${e}) NOT LIKE fold(${push(ctx, likePattern(v))}) ESCAPE '\\')`;
    case "exists":
      return v ? `(${e} IS NOT NULL AND ${e} <> '')` : `(${e} IS NULL OR ${e} = '')`;
    default:
      return `${e} ${cmp(op)} ${push(ctx, toParam(f, v))}`;
  }
}

function cmp(op: string): string {
  return { greater_than: ">", less_than: "<", greater_than_equal: ">=", less_than_equal: "<=" }[op]!;
}

/** hasMany columns hold JSON arrays; operators apply to elements, mirroring PB's any-of match. */
function arrayCond(ctx: Ctx, e: string, f: Field, op: string, v: unknown): string {
  const each = (cond: (x: string) => string) => {
    const je = nextAlias(ctx, "e");
    return `EXISTS (SELECT 1 FROM json_each(COALESCE(${e}, '[]')) AS ${je} WHERE ${cond(`${je}."value"`)})`;
  };
  switch (op) {
    case "exists":
      return v ? `json_array_length(COALESCE(${e}, '[]')) > 0` : `json_array_length(COALESCE(${e}, '[]')) = 0`;
    case "not_equals":
      return `NOT ${each((x) => scalarCond(ctx, x, f, "equals", v))}`;
    case "not_in":
      return `NOT ${each((x) => scalarCond(ctx, x, f, "in", v))}`;
    case "not_like":
      return `NOT ${each((x) => scalarCond(ctx, x, f, "like", v))}`;
    default:
      return each((x) => scalarCond(ctx, x, f, op, v));
  }
}

/** Joins and column expressions shared by a whole view query, so equal relation paths reuse one join. */
export interface PathScope {
  ctx: Ctx;
  alias: string;
  c: CollectionConfig;
}

export function pathScope(c: CollectionConfig, all: CollectionConfig[]): PathScope {
  return {
    ctx: { all, params: [], joins: [], joinAliases: new Map(), counter: { n: 0 }, inline: true },
    alias: quoteIdent(c.slug),
    c,
  };
}

/** Column expression and field of a dotted path through single relations; views select and group by these. */
export function resolvePath(scope: PathScope, path: string): { sql: string; field: Field } {
  let alias = scope.alias;
  let c = scope.c;
  const segs = path.split(".");
  for (let i = 0; i < segs.length; i++) {
    const f = queryableField(c, segs[i]);
    if (!f) throw badRequest(`Invalid field "${path}" on "${scope.c.slug}".`);
    const col = `${alias}.${quoteIdent(f.name)}`;
    if (i === segs.length - 1) return { sql: col, field: f };
    if (f.type !== "relationship" || f.hasMany) throw badRequest(`"${segs[i]}" in "${path}" is not a single relation.`);
    const target = scope.ctx.all.find((x) => x.slug === f.relationTo);
    if (!target) throw badRequest(`Unknown relation target "${f.relationTo}".`);
    const key = `${alias}.${f.name}`;
    let ja = scope.ctx.joinAliases.get(key);
    if (!ja) {
      ja = nextAlias(scope.ctx, "j");
      scope.ctx.joinAliases.set(key, ja);
      scope.ctx.joins.push(`LEFT JOIN ${quoteIdent(target.slug)} AS ${ja} ON ${ja}."id" = ${col}`);
    }
    alias = ja;
    c = target;
  }
  throw badRequest(`Invalid field "${path}".`);
}

/** WHERE body compiled into the scope (literals inlined, joins shared). */
export function scopedWhere(scope: PathScope, w: Where): string {
  return compileWhere(scope.ctx, scope.alias, scope.c, w, 0);
}
