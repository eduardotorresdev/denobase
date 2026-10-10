import { type CollectionConfig, type Field, LOCKED } from "../core/types.ts";
import { ApiError, badRequest } from "../core/errors.ts";
import { quoteIdent } from "../schema/mod.ts";
import { type Expr, type ExprGroup, FexprError, parse, type SignOp, type Token } from "./fexpr.ts";

/**
 * PocketBase filter/sort compiler: modelled on PB v0.40's filter, sort, identifier macros, token functions, multi-match subqueries
 * and record field resolver. It compiles straight to a
 * parameterized SQLite fragment so the generated semantics (multi-match subqueries, null/"" fallbacks, joins)
 * match PB's. Names and branches follow PB's compiler so the two can be compared when PB changes.
 */

export type Param = string | number | null;

/** PB core.RequestInfo, the source of every `@request.*` identifier. */
export interface RequestInfo {
  /** "default", "realtime", ... (PB RequestInfoContext*). */
  context: string;
  method: string;
  query: Record<string, unknown>;
  headers: Record<string, unknown>;
  body: Record<string, unknown>;
  /** Auth record as PB exports it to rules (hidden fields unhidden, secrets dropped), or null for guests. */
  auth: { collection: string; record: Record<string, unknown> } | null;
}

export interface FilterContext {
  /** Every collection: relations, back-relations and `@collection.*` resolve against it. */
  collections: CollectionConfig[];
  /** Name-or-id lookup (PB FindCachedCollectionByNameOrId); defaults to a slug match in collections. */
  findCollection?: (nameOrId: string) => CollectionConfig | undefined;
  /** null resolves every `@request.*` to NULL, like a PB resolver built without request info. */
  request?: RequestInfo | null;
  /** PB allowHiddenFields: hidden fields filterable, joined collections' read rules not enforced. */
  allowHidden?: boolean;
  /** Clock for the datetime macros; tests pin it. */
  now?: () => Date;
  /**
   * The path after a json field is one flat key (`attributes.http.route` reads `$."http.route"`), for json that keeps
   * OTel-style dotted names at the top level (_spans). Off, each dot steps into a nested object, as in PB.
   */
  flatJsonKeys?: boolean;
}

/** A joined collection whose read rule the caller must AND in (PB listRuleJoins), keyed by its join alias. */
export interface RuleJoin {
  collection: CollectionConfig;
  alias: string;
}

/** Compiled filter+sort: joins go before WHERE (their params first), where is ANDed with the caller's. */
export interface CompiledQuery {
  where: string;
  params: Param[];
  joins: string[];
  joinParams: Param[];
  orderBy: string;
  ruleJoins: RuleJoin[];
}

export interface SortField {
  name: string;
  direction: "ASC" | "DESC";
}

/** PB search limits. */
export const MAX_FILTER_LENGTH = 3500;
export const FILTER_EXPR_LIMIT = 200;
export const SORT_EXPR_LIMIT = 8;
export const MAX_SORT_FIELD_LENGTH = 255;
const MAX_NESTED_RELS = 6;

const enum NullFallback {
  Auto = 0,
  Disabled = 1,
  Enforced = 2,
}

interface Join {
  /** SQL table expression (quoted name or json_each(...)). */
  table: string;
  alias: string;
  on?: string;
}

interface MultiMatch {
  targetAlias: string;
  fromTable: string;
  fromAlias: string;
  value: string;
  joins: Join[];
}

/** PB search.ResolverResult; params are names of values held by the compiler. */
interface Resolved {
  id: string;
  params: string[];
  /**
   * The bare stored column behind a COALESCEd base column of TEXT affinity, for the comparisons where the COALESCE
   * cannot change the answer: they then reach the column's index, which COALESCE(col, '') hides from SQLite.
   */
  bare?: { column: string; sortable: boolean };
  nullFallback?: NullFallback;
  multiMatch?: MultiMatch;
  afterBuild?: (sql: string) => string;
}

interface RunState {
  props: string[];
  collection: CollectionConfig;
  alias: string;
  nullifyMissing: boolean;
  withMultiMatch: boolean;
  mmAlias: string;
  mm: MultiMatch;
}

/** PB answers every filter/sort failure with this generic 400; the reason rides along as the error cause. */
function fail(reason: string): ApiError {
  return Object.assign(badRequest(), { cause: reason });
}

const q = quoteIdent;
const col = (alias: string, name: string) => `${q(alias)}.${q(name)}`;
const NOT = (sql: string) => `NOT (${sql})`;

const ALLOWED_FIELDS = [
  /^\w+[\w.:]*$/,
  /^@request\.context$/,
  /^@request\.method$/,
  /^@request\.auth\.[\w.:]*\w+$/,
  /^@request\.body\.[\w.:]*\w+$/,
  /^@request\.query\.[\w.:]*\w+$/,
  /^@request\.headers\.[\w.:]*\w+$/,
  /^@collection\.\w+(:\w+)?\.[\w.:]*\w+$/,
];

/** Auth fields rules may read without joining the auth collection (PB plainRequestAuthFields). */
const PLAIN_AUTH_FIELDS = new Set(["id", "collectionId", "collectionName", "email", "emailVisibility", "verified"]);

const MODIFIERS = new Set(["isset", "each", "length", "lower", "changed"]);

const NORMALIZED: Record<string, string> = { null: "NULL", true: "1", false: "0" };

const AUTH_FIELDS: Field[] = [
  { name: "email", type: "email" },
  { name: "emailVisibility", type: "checkbox" },
  { name: "verified", type: "checkbox" },
  { name: "passwordHash", type: "text", hidden: true },
  { name: "tokenKey", type: "text", hidden: true },
];

/** PB collection.Fields: implicit id/created/updated (a view only has what it selects) and auth fields. */
function fieldsOf(c: CollectionConfig): Field[] {
  const own = new Set(c.fields.map((f) => f.name));
  const out: Field[] = [{ name: "id", type: "text" }];
  for (const name of ["created", "updated"]) {
    if (!own.has(name) && (!c.view || name in c.view.select || !!c.view.fields?.some((f) => f.name === name))) {
      out.push({ name, type: "date" });
    }
  }
  if (c.auth) out.push(...AUTH_FIELDS.filter((f) => !own.has(f.name)));
  return [...out, ...c.fields.filter((f) => !f.virtual)];
}

function getField(c: CollectionConfig, name: string): Field | undefined {
  return fieldsOf(c).find((f) => f.name === name);
}

/** Stored as TEXT and compared as text: every single-valued field but numbers, checkboxes and json. */
const textAffinity = (f: Field) => f.type !== "number" && f.type !== "checkbox" && f.type !== "json" && !isMultiple(f);

/**
 * A column that holds no NULL nor zero value, so COALESCE(col, '') orders as col does: the NOT NULL system columns of
 * a table, and required fields (the engine refuses an empty one; PB data came NOT NULL, never NULL beside '').
 */
const neverEmpty = (c: CollectionConfig, f: Field) =>
  (!c.view && (f.name === "id" || f.name === "created" || f.name === "updated")) || !!f.required;

/** PB MultiValuer: select, relation (file has no counterpart here). */
// PB MultiValuer: select, relation and file.
const isMultiValuer = (f: Field) => f.type === "select" || f.type === "relationship" || f.type === "file";
const isMultiple = (f: Field) =>
  f.type === "file" ? (f.maxSelect ?? 1) > 1 : isMultiValuer(f) && !!(f as { hasMany?: boolean }).hasMany;

function splitModifier(combined: string): [string, string] {
  const parts = combined.split(":");
  if (parts.length !== 2) return [combined, ""];
  if (MODIFIERS.has(parts[1])) return [parts[0], parts[1]];
  throw fail(`unknown modifier in "${combined}"`);
}

/** dbutils.JSONEach: non-array values are iterated as a one-item array. */
function jsonEach(column: string): string {
  return `json_each(CASE WHEN iif(json_valid(${column}), json_type(${column})='array', FALSE) THEN ${column} ELSE json_array(${column}) END)`;
}

/** dbutils.JSONArrayLength: 0 for '' or NULL, 1 for a non-array scalar. */
function jsonArrayLength(column: string): string {
  return `json_array_length(CASE WHEN iif(json_valid(${column}), json_type(${column})='array', FALSE) THEN ${column} ELSE (CASE WHEN ${column} = '' OR ${column} IS NULL THEN json_array() ELSE json_array(${column}) END) END)`;
}

/** dbutils.JSONExtract; the path only holds [\w.[\]] (props passed the allowed-fields regex), so inlining is safe. */
function jsonExtract(column: string, path: string): string {
  const p = path !== "" && !path.startsWith("[") ? "." + path : path;
  return `(CASE WHEN json_valid(${column}) THEN JSON_EXTRACT(${column}, '$${p}') ELSE JSON_EXTRACT(json_object('pb', ${column}), '$.pb${p}') END)`;
}

/**
 * Column as PB would read it. PB columns are NOT NULL with zero defaults, ours are nullable, so stored NULLs read
 * as the zero value; a LEFT JOIN that found no row still yields NULL, as in PB.
 */
function fieldColumn(alias: string, f: Field, isBase: boolean): string {
  const ref = col(alias, f.name);
  if (f.name === "id" || f.type === "json") return ref;
  const zero = isMultiple(f) ? "'[]'" : f.type === "number" || f.type === "checkbox" ? "0" : "''";
  const value = `COALESCE(${ref}, ${zero})`;
  return isBase ? value : `(CASE WHEN ${col(alias, "id")} IS NULL THEN NULL ELSE ${value} END)`;
}

function bindable(v: unknown): Param {
  if (v === null || v === undefined) return null;
  if (typeof v === "boolean") return v ? 1 : 0;
  if (typeof v === "number") return Number.isFinite(v) ? v : 0;
  if (typeof v === "string") return v;
  return JSON.stringify(v);
}

/** cast.ToString for the scalar cases PB feeds it; non-scalars become "" like cast's failed conversion. */
function castString(v: unknown): string {
  if (v === null || v === undefined) return "";
  if (typeof v === "string") return v;
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  return "";
}

function toSlice(v: unknown): unknown[] {
  if (v === null || v === undefined) return [];
  return Array.isArray(v) ? v : [v];
}

/** PB extractNestedVal: missing keys and bad indexes are errors (callers fall back to NULL). */
function extractNested(data: unknown, keys: string[]): unknown {
  let cur = data;
  for (const k of keys) {
    if (Array.isArray(cur)) {
      const i = /^[+-]?\d+$/.test(k) ? Number(k) : -1;
      if (i < 0 || i >= cur.length) throw new Error(`invalid array index ${k}`);
      cur = cur[i];
    } else if (cur !== null && typeof cur === "object") {
      if (!Object.hasOwn(cur, k)) throw new Error(`missing key ${k}`);
      cur = (cur as Record<string, unknown>)[k];
    } else throw new Error("expected map or array");
  }
  return cur;
}

/** Escapes \, % and _ unless already escaped (PB escapeUnescapedChars). */
function escapeUnescaped(s: string): string {
  const rs = [...s];
  const out: string[] = [];
  let match = false;
  for (let i = rs.length - 1; i >= 0; i--) {
    if (match) {
      if (rs[i] !== "\\") out.push("\\");
      match = false;
    } else match = rs[i] === "\\" || rs[i] === "%" || rs[i] === "_";
    out.push(rs[i]);
    if (i === 0 && match) out.push("\\");
  }
  return out.reverse().join("");
}

function containsUnescaped(s: string, ch: string): boolean {
  let prev = "";
  for (const c of s) {
    if (c === ch && prev !== "\\") return true;
    prev = c === "\\" && prev === "\\" ? "" : c;
  }
  return false;
}

/** PB wrapLikeParams: a value without an unescaped % becomes a contains pattern with wildcards escaped. */
export function likePattern(v: unknown): string {
  const s = v === null || v === undefined ? "" : typeof v === "string" ? v : String(v);
  return containsUnescaped(s, "%") ? s : `%${escapeUnescaped(s)}%`;
}

const pbDate = (d: Date) => d.toISOString().replace("T", " ");

/** PB identifierMacros; datetimes in PB's "2006-01-02 15:04:05.000Z" layout, UTC. */
const MACROS: Record<string, (now: Date) => string | number> = {
  "@now": (n) => pbDate(n),
  "@yesterday": (n) => pbDate(new Date(n.getTime() - 86_400_000)),
  "@tomorrow": (n) => pbDate(new Date(n.getTime() + 86_400_000)),
  "@second": (n) => n.getUTCSeconds(),
  "@minute": (n) => n.getUTCMinutes(),
  "@hour": (n) => n.getUTCHours(),
  "@day": (n) => n.getUTCDate(),
  "@month": (n) => n.getUTCMonth() + 1,
  "@weekday": (n) => n.getUTCDay(),
  "@year": (n) => n.getUTCFullYear(),
  "@todayStart": (n) => pbDate(new Date(Date.UTC(n.getUTCFullYear(), n.getUTCMonth(), n.getUTCDate()))),
  "@todayEnd": (n) => pbDate(new Date(Date.UTC(n.getUTCFullYear(), n.getUTCMonth(), n.getUTCDate(), 23, 59, 59, 999))),
  "@monthStart": (n) => pbDate(new Date(Date.UTC(n.getUTCFullYear(), n.getUTCMonth(), 1))),
  "@monthEnd": (n) => pbDate(new Date(Date.UTC(n.getUTCFullYear(), n.getUTCMonth() + 1, 0, 23, 59, 59, 999))),
  "@yearStart": (n) => pbDate(new Date(Date.UTC(n.getUTCFullYear(), 0, 1))),
  "@yearEnd": (n) => pbDate(new Date(Date.UTC(n.getUTCFullYear(), 11, 31, 23, 59, 59, 999))),
};

/** PB ParseSortFromString: "-a,+b"; empty items are kept so they fail like in PB. */
export function parsePbSort(sort: string): SortField[] {
  return sort.split(",").map((s) => s.trim()).map((s) =>
    s.startsWith("-") ? { name: s.slice(1), direction: "DESC" } : { name: s.replace(/^\+/, ""), direction: "ASC" }
  );
}

/**
 * One compilation over a base collection (PB RecordFieldResolver + FilterData). Filter and sort share it, so a
 * relation they both use is joined once, as in PB.
 */
export class PbCompiler {
  private readonly values = new Map<string, unknown>();
  private readonly joins: Join[] = [];
  private readonly ruleJoins: RuleJoin[] = [];
  private readonly baseAlias: string;
  private readonly staticInfo: Record<string, unknown>;
  private n = 0;
  private where = "";
  private orderBy = "";

  constructor(private readonly base: CollectionConfig, private readonly ctx: FilterContext) {
    this.baseAlias = base.slug;
    const r = ctx.request;
    this.staticInfo = r
      ? { context: r.context, method: r.method, query: r.query, headers: r.headers, body: r.body, auth: r.auth?.record }
      : {};
  }

  /** ANDs a PB filter string into the compilation; throws ApiError 400 like PB on any parse/resolve error. */
  filter(raw: string): this {
    if (raw.length > MAX_FILTER_LENGTH) throw fail("max filter length limit reached");
    let groups: ExprGroup[];
    try {
      groups = parse(raw);
    } catch (e) {
      throw e instanceof FexprError ? fail(e.message) : e;
    }
    const sql = this.groups(groups, { n: FILTER_EXPR_LIMIT });
    this.where = this.where ? `${this.where} AND ${sql}` : sql;
    return this;
  }

  /** PB SortField.BuildExpr per field; @random and @rowid are special keys. */
  sort(fields: SortField[]): this {
    if (fields.length > SORT_EXPR_LIMIT) throw fail("max sort expressions limit reached");
    const parts: string[] = [];
    for (const s of fields) {
      if (s.name.length > MAX_SORT_FIELD_LENGTH) throw fail("max sort field length limit reached");
      if (s.name === "@random") {
        parts.push("RANDOM()");
        continue;
      }
      if (s.name === "@rowid") {
        parts.push(`${col(this.baseAlias, "_rowid_")} ${s.direction}`);
        continue;
      }
      let r: Resolved;
      try {
        r = this.resolve(s.name);
      } catch {
        throw fail(`invalid sort field "${s.name}"`);
      }
      if (r.params.length > 0 || r.id === "" || r.id.toLowerCase() === "null") {
        throw fail(`invalid sort field "${s.name}"`);
      }
      // A column that is never empty orders the same without the COALESCE, which would hide its index.
      parts.push(`${r.bare?.sortable ? r.bare.column : r.id} ${s.direction}`);
    }
    if (parts.length) this.orderBy = `ORDER BY ${parts.join(", ")}`;
    return this;
  }

  /** Placeholders become positional "?" in textual order, so a value used twice is bound twice. */
  build(): CompiledQuery {
    const joins = this.joins.map((j) => `LEFT JOIN ${j.table} ${q(j.alias)}${j.on ? ` ON ${j.on}` : ""}`);
    const jp = this.positional(joins.join("\n"));
    const w = this.positional(this.where);
    const o = this.positional(this.orderBy);
    if (o.params.length) throw fail("invalid sort expression");
    return {
      where: w.sql,
      params: w.params,
      joins: jp.sql ? jp.sql.split("\n") : [],
      joinParams: jp.params,
      orderBy: o.sql,
      ruleJoins: [...this.ruleJoins],
    };
  }

  private positional(sql: string): { sql: string; params: Param[] } {
    const params: Param[] = [];
    const out = sql.replace(/\{:(p\d+)\}/g, (_, name: string) => {
      params.push(bindable(this.values.get(name)));
      return "?";
    });
    return { sql: out, params };
  }

  private param(v: unknown): { id: string; name: string } {
    const name = `p${++this.n}`;
    this.values.set(name, v);
    return { id: `{:${name}}`, name };
  }

  private unique(prefix: string): string {
    return `${prefix}${++this.n}`;
  }

  private collection(nameOrId: string): CollectionConfig | undefined {
    if (nameOrId === this.base.slug) return this.base;
    return this.ctx.findCollection?.(nameOrId) ?? this.ctx.collections.find((c) => c.slug === nameOrId);
  }

  // ---------------------------------------------------------------- filter

  private groups(groups: ExprGroup[], limit: { n: number }): string {
    const parts: string[] = [];
    for (const g of groups) {
      let sql: string;
      if (Array.isArray(g.item)) sql = this.groups(g.item, limit);
      else {
        if (limit.n <= 0) throw fail("max filter expressions limit reached");
        limit.n--;
        sql = this.expr(g.item);
      }
      if (parts.length) parts.push(g.join === "||" ? "OR" : "AND");
      parts.push(sql);
    }
    const upper = parts.length === 1 ? parts[0].toUpperCase() : "";
    if (parts.length === 1 && !upper.includes(" AND ") && !upper.includes(" OR ")) return parts[0];
    return `(${parts.join(" ")})`;
  }

  private expr(e: Expr): string {
    const operand = (t: Token, side: string) => {
      let r: Resolved | undefined;
      try {
        r = this.token(t);
      } catch (err) {
        throw err instanceof ApiError ? err : fail(`invalid ${side} operand "${t.literal}"`);
      }
      if (!r.id) throw fail(`invalid ${side} operand "${t.literal}"`);
      return r;
    };
    return this.resolvers(operand(e.left, "left"), e.op, operand(e.right, "right"));
  }

  private resolvers(left: Resolved, op: SignOp, right: Resolved): string {
    const any = op.startsWith("?");
    const base = any ? op.slice(1) : op;
    let sql: string;
    switch (base) {
      case "=":
      case "!=":
        sql = this.equal(base === "=", left, right);
        break;
      case "~":
      case "!~": {
        const not = base === "!~" ? "NOT " : "";
        if (right.params.length === 0) {
          sql = `fold(${left.id}) ${not}LIKE ('%' || fold(${right.id}) || '%') ESCAPE '\\'`;
        } else {
          for (const p of right.params) this.values.set(p, likePattern(this.values.get(p)));
          sql = `fold(${left.id}) ${not}LIKE fold(${right.id}) ESCAPE '\\'`;
        }
        break;
      }
      case "<":
      case "<=":
      case ">":
      case ">=":
        sql = `${left.id} ${base} ${right.id}`;
        break;
      default:
        throw fail(`unknown expression operator "${op}"`);
    }
    if (!any) {
      if (left.multiMatch && right.multiMatch) sql = `((${sql}) AND (${this.manyVsMany(left, right, op)}))`;
      else if (left.multiMatch) sql = `((${sql}) AND (${this.manyVsOne(left, right, op, false)}))`;
      else if (right.multiMatch) sql = `((${sql}) AND (${this.manyVsOne(right, left, op, true)}))`;
    }
    if (left.afterBuild) sql = left.afterBuild(sql);
    if (right.afterBuild) sql = right.afterBuild(sql);
    return sql;
  }

  private hasEmptyParam(r: Resolved): boolean {
    return r.params.some((p) => {
      const v = this.values.get(p);
      return v === null || v === undefined || v === "";
    });
  }

  private isEmptyIdentifier(r: Resolved): boolean {
    return ["", "null", "''", '""', "``"].includes(r.id.toLowerCase());
  }

  private isKnownNonEmpty(r: Resolved): boolean {
    if (r.nullFallback === NullFallback.Enforced) return false;
    if (["1", "0", "false", "true"].includes(r.id.toLowerCase())) return true;
    return r.params.length > 0 && !this.hasEmptyParam(r) && !this.isEmptyIdentifier(r);
  }

  private bareAgainstText(column: Resolved, value: Resolved): string | undefined {
    if (!column.bare || column.afterBuild || value.params.length !== 1 || value.id !== `{:${value.params[0]}}`) {
      return undefined;
    }
    const v = this.values.get(value.params[0]);
    return typeof v === "string" && v !== "" ? `${column.bare.column} = ${value.id}` : undefined;
  }

  /** PB resolveEqualExpr: "" and NULL compare equal unless a side disables the fallback (json, functions). */
  private equal(eq: boolean, l: Resolved, r: Resolved): string {
    const op = eq ? "=" : "IS NOT";
    const nullOp = eq ? "IS" : "IS NOT";
    const concat = eq ? "OR" : "AND";
    const nullExpr = eq ? "IS NULL" : "IS NOT NULL";
    if (l.nullFallback === NullFallback.Disabled || r.nullFallback === NullFallback.Disabled) {
      return `${l.id} ${nullOp} ${r.id}`;
    }
    const auto = (x: Resolved) => (x.nullFallback ?? NullFallback.Auto) === NullFallback.Auto;
    const le = this.isEmptyIdentifier(l) || (auto(l) && l.params.length === 1 && this.hasEmptyParam(l));
    const re = this.isEmptyIdentifier(r) || (auto(r) && r.params.length === 1 && this.hasEmptyParam(r));
    if (le && re) return `'' ${op} ''`;
    // col = 'x' (x a non-empty string) is false wherever COALESCE(col, '') = 'x' is: NULL only where the COALESCE
    // gives '' != 'x'. The bare column lets SQLite use its index; TEXT affinity leaves a string param as is.
    if (eq) {
      const bare = this.bareAgainstText(l, r) ?? this.bareAgainstText(r, l);
      if (bare) return bare;
    }
    if (this.isKnownNonEmpty(l) || this.isKnownNonEmpty(r)) {
      return `${le ? "''" : l.id} ${op} ${re ? "''" : r.id}`;
    }
    if (le) return `('' ${op} ${r.id} ${concat} ${r.id} ${nullExpr})`;
    if (re) return `(${l.id} ${op} '' ${concat} ${l.id} ${nullExpr})`;
    return `COALESCE(${l.id}, '') ${op} COALESCE(${r.id}, '')`;
  }

  private multiMatchSql(m: MultiMatch): string {
    const joins = m.joins.map((j) => ` LEFT JOIN ${j.table} ${q(j.alias)}${j.on ? ` ON ${j.on}` : ""}`).join("");
    return `SELECT ${m.value} as "multiMatchValue" FROM ${m.fromTable} ${q(m.fromAlias)}${joins} WHERE ${
      col(m.fromAlias, "id")
    } = ${col(m.targetAlias, "id")}`;
  }

  /** Every left value must satisfy op against every right one: no pair may fail. */
  private manyVsMany(l: Resolved, r: Resolved, op: SignOp): string {
    const la = this.unique("__ml");
    const ra = this.unique("__mr");
    const where = this.resolvers(
      { id: col(la, "multiMatchValue"), params: [], nullFallback: l.nullFallback },
      op,
      { id: col(ra, "multiMatchValue"), params: [], nullFallback: r.nullFallback, afterBuild: NOT },
    );
    return `NOT EXISTS (SELECT 1 FROM (${this.multiMatchSql(l.multiMatch!)}) ${q(la)} LEFT JOIN (${
      this.multiMatchSql(r.multiMatch!)
    }) ${q(ra)} WHERE ${where})`;
  }

  /** Every value of the many side must satisfy op against the other operand. */
  private manyVsOne(many: Resolved, other: Resolved, op: SignOp, inverse: boolean): string {
    const a = this.unique("__sm");
    const r1: Resolved = {
      id: col(a, "multiMatchValue"),
      params: [],
      nullFallback: many.nullFallback,
      afterBuild: NOT,
    };
    const r2: Resolved = { id: other.id, params: other.params };
    const where = inverse ? this.resolvers(r2, op, r1) : this.resolvers(r1, op, r2);
    return `NOT EXISTS (SELECT 1 FROM (${this.multiMatchSql(many.multiMatch!)}) ${q(a)} WHERE ${where})`;
  }

  private token(t: Token): Resolved {
    switch (t.type) {
      case "identifier": {
        const macro = MACROS[t.literal];
        if (macro) {
          const p = this.param(macro(this.ctx.now?.() ?? new Date()));
          return { id: p.id, params: [p.name] };
        }
        try {
          const r = this.resolve(t.literal);
          if (r.id) return r;
        } catch (e) {
          const norm = NORMALIZED[t.literal.toLowerCase()];
          if (norm) return { id: norm, params: [] };
          throw e;
        }
        const norm = NORMALIZED[t.literal.toLowerCase()];
        if (norm) return { id: norm, params: [] };
        throw fail(`invalid identifier "${t.literal}"`);
      }
      case "text": {
        const p = this.param(t.literal);
        return { id: p.id, params: [p.name] };
      }
      case "number": {
        const n = Number(t.literal);
        const p = this.param(Number.isFinite(n) ? n : 0);
        return { id: p.id, params: [p.name] };
      }
      case "function":
        return this.fn(t);
    }
    throw fail(`unsupported token type "${t.type}"`);
  }

  // ---------------------------------------------------------------- token functions

  private fn(t: Token): Resolved {
    const args = t.args ?? [];
    if (t.literal === "geoDistance") {
      if (args.length !== 4) throw fail(`[geoDistance] expected 4 arguments, got ${args.length}`);
      const r = args.map((a, i) => {
        if (a.type !== "identifier" && a.type !== "number") {
          throw fail(`[geoDistance] argument ${i} must be an identifier or number`);
        }
        return this.token(a);
      });
      const [lonA, latA, lonB, latB] = r.map((x) => x.id);
      return {
        nullFallback: NullFallback.Disabled,
        // Clamped against rounding past 1 for identical points (acos would be NULL).
        id: `(6371 * acos(min(1, max(-1, cos(radians(${latA})) * cos(radians(${latB})) * cos(radians(${lonB}) - ` +
          `radians(${lonA})) + sin(radians(${latA})) * sin(radians(${latB}))))))`,
        params: r.flatMap((x) => x.params),
      };
    }
    if (t.literal === "strftime") {
      if (args.length < 1) throw fail("[strftime] expected at least 1 arguments");
      if (args.length > 10) throw fail("[strftime] too many arguments");
      if (args[0].type !== "text") throw fail("[strftime] expects the first argument to be a format string");
      const format = this.token(args[0]);
      if (args.length === 1) {
        return { ...format, nullFallback: NullFallback.Enforced, id: `strftime(${format.id})` };
      }
      if (!["text", "identifier", "number"].includes(args[1].type)) {
        throw fail("[strftime] expects the second argument to be of a valid time-value type");
      }
      const timeValue = this.token(args[1]);
      const mods = args.slice(2).map((a, i) => {
        if (a.type !== "text") throw fail(`[strftime] invalid modifier argument ${i} - can be only string`);
        return this.token(a);
      });
      const ids = [format.id, timeValue.id, ...mods.map((m) => m.id)];
      const out: Resolved = {
        nullFallback: NullFallback.Enforced,
        params: [...format.params, ...timeValue.params, ...mods.flatMap((m) => m.params)],
        id: `strftime(${ids.join(",")})`,
      };
      if (timeValue.multiMatch) {
        ids[1] = timeValue.multiMatch.value;
        out.multiMatch = timeValue.multiMatch;
        out.multiMatch.value = `strftime(${ids.join(",")})`;
      }
      return out;
    }
    throw fail(`unknown function "${t.literal}"`);
  }

  // ---------------------------------------------------------------- record field resolver

  private registerJoin(table: string, alias: string, on: string | undefined, c?: CollectionConfig): void {
    if (!this.ctx.allowHidden && c) {
      // A collection without read access is superuser-only: PB treats all its fields as hidden.
      if (!c.access?.read || c.access.read === LOCKED) {
        throw fail(`"${c.slug}" fields can be accessed only by superusers`);
      }
      const rj = this.ruleJoins.find((j) => j.alias === alias);
      if (rj) rj.collection = c;
      else this.ruleJoins.push({ collection: c, alias });
    }
    const join: Join = { table, alias, on };
    const i = this.joins.findIndex((j) => j.alias === alias);
    if (i >= 0) this.joins[i] = join;
    else this.joins.push(join);
  }

  /** PB RecordFieldResolver.Resolve for one identifier. */
  private resolve(fieldName: string): Resolved {
    if (!ALLOWED_FIELDS.some((re) => re.test(fieldName))) throw fail(`failed to resolve field "${fieldName}"`);
    const props = fieldName.split(".");
    const alias = this.baseAlias;
    const s: RunState = {
      props,
      collection: this.base,
      alias,
      nullifyMissing: props[0] === "@request",
      withMultiMatch: false,
      mmAlias: "__mm_" + alias,
      mm: { targetAlias: alias, fromTable: q(this.base.slug), fromAlias: "__mm_" + alias, value: "", joins: [] },
    };
    if (props[0] === "@collection") return this.collectionField(s, fieldName);
    if (props[0] === "@request") {
      if (!this.ctx.request) return { id: "NULL", params: [] };
      if (fieldName.startsWith("@request.auth.")) return this.authField(s, fieldName);
      if (fieldName.startsWith("@request.body.") && props.length > 2) {
        const [name, modifier] = splitModifier(props[2]);
        const bodyField = getField(this.base, name);
        if (!bodyField) return this.staticField(props.slice(1));
        if (bodyField.type === "relationship" && props.length > 3) return this.bodyRelationField(s, bodyField);
        if (props.length === 3) {
          if (modifier === "each") return this.bodyEach(s, bodyField);
          if (modifier === "length") return this.bodyLength(bodyField);
          if (modifier === "lower") return this.bodyLower(bodyField);
          if (modifier === "changed") return this.bodyChanged(bodyField);
        }
      }
      return this.staticField(props.slice(1));
    }
    return this.activeProps(s, fieldName);
  }

  private staticField(path: string[]): Resolved {
    const [last, modifier] = splitModifier(path[path.length - 1]);
    path = [...path.slice(0, -1), last];
    let value: unknown;
    let missing = false;
    try {
      value = extractNested(this.staticInfo, path);
    } catch {
      missing = true;
    }
    if (modifier === "isset") return { id: missing ? "FALSE" : "TRUE", params: [] };
    if (typeof value === "string") {
      // Form data sends numbers as strings; a same-named number field casts them like PB.
      const f = getField(this.base, last);
      if (f?.type === "number" && /^\s*[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?\s*$/.test(value)) value = Number(value);
    } else if (value !== null && value !== undefined && typeof value === "object") value = JSON.stringify(value);
    if (modifier !== "" && modifier !== "lower") throw fail(`invalid modifier sequence ${last}:${modifier}`);
    if (value === null || value === undefined) return { id: "NULL", params: [] };
    const p = this.param(value);
    return { id: modifier === "lower" ? `LOWER(${p.id})` : p.id, params: [p.name] };
  }

  private collectionField(s: RunState, fieldName: string): Resolved {
    if (s.props.length < 3) throw fail(`invalid @collection field path in "${fieldName}"`);
    const [nameOrId, alias] = s.props[1].split(":");
    const c = this.collection(nameOrId);
    if (!c) throw fail(`failed to load collection "${s.props[1]}" from field path "${fieldName}"`);
    s.collection = c;
    s.alias = alias ? `__collection_alias_${alias}` : `__collection_${c.slug}`;
    s.withMultiMatch = true;
    this.registerJoin(q(c.slug), s.alias, undefined, c);
    s.mmAlias = "__mm_" + s.alias;
    s.mm.joins.push({ table: q(c.slug), alias: s.mmAlias });
    s.props = s.props.slice(2);
    return this.activeProps(s, fieldName);
  }

  private authField(s: RunState, fieldName: string): Resolved {
    const auth = this.ctx.request?.auth;
    const c = auth ? this.collection(auth.collection) : undefined;
    if (!auth || !c) return { id: "NULL", params: [] };
    if (PLAIN_AUTH_FIELDS.has(fieldName.slice("@request.auth.".length))) return this.staticField(s.props.slice(1));
    const authId = auth.record.id;
    s.collection = c;
    s.alias = `__auth_${c.slug}`;
    const p1 = this.param(authId);
    this.registerJoin(q(c.slug), s.alias, `${col(s.alias, "id")} = ${p1.id}`, c);
    s.mmAlias = "__mm_" + s.alias;
    const p2 = this.param(authId);
    s.mm.joins.push({ table: q(c.slug), alias: s.mmAlias, on: `${col(s.mmAlias, "id")} = ${p2.id}` });
    s.props = s.props.slice(2);
    return this.activeProps(s, fieldName);
  }

  private body(): Record<string, unknown> {
    return this.ctx.request?.body ?? {};
  }

  private bodyChanged(f: Field): Resolved {
    const name = f.name;
    const sql = this.compileNested(`@request.body.${name}:isset = true && @request.body.${name} != ${name}`);
    const placeholder = `@changed@${name}${this.unique("_")}`;
    return {
      id: placeholder,
      params: [],
      nullFallback: NullFallback.Disabled,
      afterBuild: (expr) => expr.replaceAll(placeholder, sql),
    };
  }

  /** A nested filter compiled into this compilation's joins and values (PB reuses the resolver the same way). */
  private compileNested(raw: string): string {
    let groups: ExprGroup[];
    try {
      groups = parse(raw);
    } catch (e) {
      throw e instanceof FexprError ? fail(e.message) : e;
    }
    return this.groups(groups, { n: FILTER_EXPR_LIMIT });
  }

  private bodyLower(f: Field): Resolved {
    const p = this.param(castString(this.body()[f.name]));
    return { id: `LOWER(${p.id})`, params: [p.name] };
  }

  private bodyLength(f: Field): Resolved {
    if (!isMultiValuer(f)) throw fail(`field "${f.name}" doesn't support multivalue operations`);
    return { id: String(toSlice(this.body()[f.name]).length), params: [] };
  }

  private bodyEach(s: RunState, f: Field): Resolved {
    if (!isMultiValuer(f)) throw fail(`field "${f.name}" doesn't support multivalue operations`);
    const raw = JSON.stringify(toSlice(this.body()[f.name]));
    const p = this.param(raw);
    const jeAlias = `__dataEach_je_${f.name}`;
    this.registerJoin(`json_each(${p.id})`, jeAlias, undefined);
    const out: Resolved = { id: col(jeAlias, "value"), params: [] };
    if (isMultiple(f)) s.withMultiMatch = true;
    if (s.withMultiMatch) {
      const p2 = this.param(raw);
      const jeAlias2 = "__mm_" + jeAlias;
      s.mm.joins.push({ table: `json_each(${p2.id})`, alias: jeAlias2 });
      s.mm.value = col(jeAlias2, "value");
      out.multiMatch = s.mm;
    }
    return out;
  }

  private bodyRelationField(s: RunState, f: Field): Resolved {
    if (f.type !== "relationship") throw fail(`failed to initialize data relation field "${f.name}"`);
    const target = this.collection(f.relationTo);
    if (!target) throw fail(`failed to load collection "${f.relationTo}" from data field "${f.name}"`);
    const ids = [...new Set(toSlice(this.body()[f.name]).map(castString).filter((x) => x !== ""))];
    if (ids.length === 0) return { id: "NULL", params: [] };
    s.collection = target;
    s.alias = `__data_${target.slug}_${f.name}`;
    const inList = () => ids.map((id) => this.param(id).id).join(", ");
    this.registerJoin(q(target.slug), s.alias, `${col(s.alias, "id")} IN (${inList()})`, target);
    if (isMultiple(f)) s.withMultiMatch = true;
    s.mmAlias = "__mm_" + s.alias;
    s.mm.joins.push({ table: q(target.slug), alias: s.mmAlias, on: `${col(s.mmAlias, "id")} IN (${inList()})` });
    s.props = s.props.slice(3);
    return this.activeProps(s, f.name);
  }

  private activeProps(s: RunState, fieldName: string): Resolved {
    const total = s.props.length;
    for (let i = 0; i < total; i++) {
      const prop = s.props[i];
      const c = s.collection;
      if (i === total - 1) return this.finalize(s, c, prop);

      const field = getField(c, prop);
      if (field?.hidden && !this.ctx.allowHidden) throw fail(`non-filterable field "${prop}"`);

      // json field: the remaining props are a JSON path
      if (field?.type === "json") {
        let path = "";
        const rest = s.props.slice(i + 1);
        // Each prop passed the allowed-fields regex and is cut to \w here, so the quoted key is safe to inline.
        if (this.ctx.flatJsonKeys && rest.length) path = `"${rest.map((p) => p.replace(/\W/g, "")).join(".")}"`;
        else {rest.forEach((p, j) => {
            const clean = p.replace(/\W/g, "");
            if (/^-?\d+$/.test(p)) path += `[${clean}]`;
            else path += (j > 0 ? "." : "") + clean;
          });}
        const out: Resolved = {
          id: jsonExtract(col(s.alias, prop), path),
          params: [],
          nullFallback: NullFallback.Disabled,
        };
        if (s.withMultiMatch) {
          s.mm.value = jsonExtract(col(s.mmAlias, prop), path);
          out.multiMatch = s.mm;
        }
        return out;
      }

      if (i >= MAX_NESTED_RELS) throw fail(`max nested relations reached for field "${prop}"`);

      if (!field) {
        if (!this.backRelation(s, c, prop)) return { id: "NULL", params: [] };
        continue;
      }

      if (field.type !== "relationship") throw fail(`field "${prop}" is not a valid relation`);
      const target = this.collection(field.relationTo);
      if (!target) throw fail(`failed to load field "${prop}" collection`);

      // "rel.id" on a single relation is the rel column itself: no join, like PB.
      if (!field.hasMany && i === total - 2 && s.props[i + 1] === "id") return this.finalize(s, c, field.name);

      const prefixed = col(s.alias, field.name);
      const newAlias = `${s.alias}_${field.name}`;
      if (!field.hasMany) {
        this.registerJoin(q(target.slug), newAlias, `${col(newAlias, "id")} = ${prefixed}`, target);
      } else {
        const jeAlias = `__je_${newAlias}`;
        this.registerJoin(jsonEach(prefixed), jeAlias, undefined);
        this.registerJoin(q(target.slug), newAlias, `${col(newAlias, "id")} = ${col(jeAlias, "value")}`, target);
      }
      s.collection = target;
      s.alias = newAlias;

      if (field.hasMany) s.withMultiMatch = true;
      const newAlias2 = `${s.mmAlias}_${field.name}`;
      const prefixed2 = col(s.mmAlias, field.name);
      if (!field.hasMany) {
        s.mm.joins.push({ table: q(target.slug), alias: newAlias2, on: `${col(newAlias2, "id")} = ${prefixed2}` });
      } else {
        const jeAlias2 = `${s.mmAlias}_${field.name}_je`;
        s.mm.joins.push(
          { table: jsonEach(prefixed2), alias: jeAlias2 },
          { table: q(target.slug), alias: newAlias2, on: `${col(newAlias2, "id")} = ${col(jeAlias2, "value")}` },
        );
      }
      s.mmAlias = newAlias2;
    }
    throw fail(`failed to resolve field "${fieldName}"`);
  }

  /**
   * `<collection>_via_<relField>`: rows of another collection pointing at the current one. False when the path
   * does not resolve under `@request.*`, which PB answers with NULL instead of an error.
   */
  private backRelation(s: RunState, c: CollectionConfig, prop: string): boolean {
    const m = /^(\w+)_via_(\w+)$/.exec(prop);
    const missing = (reason: string): false => {
      if (s.nullifyMissing) return false;
      throw fail(reason);
    };
    if (!m) return missing(`failed to resolve field "${prop}"`);
    const back = this.collection(m[1]);
    if (!back) return missing(`failed to load back relation field "${prop}" collection`);
    const backField = getField(back, m[2]);
    if (!backField) return missing(`missing back relation field "${m[2]}"`);
    if (backField.type !== "relationship") return missing(`invalid back relation field "${m[2]}"`);
    if (backField.hidden && !this.ctx.allowHidden) throw fail(`non-filterable back relation field "${m[2]}"`);
    if (backField.relationTo !== c.slug) {
      return missing(`invalid collection reference of a back relation field "${m[2]}"`);
    }
    const newAlias = `${s.alias}_${prop}`;
    const multiple = !!backField.hasMany;
    const backCol = (alias: string) => col(alias, backField.name);
    if (!multiple) {
      this.registerJoin(q(back.slug), newAlias, `${backCol(newAlias)} = ${col(s.alias, "id")}`, back);
    } else {
      const je = `__je_${newAlias}`;
      this.registerJoin(
        q(back.slug),
        newAlias,
        `${col(s.alias, "id")} IN (SELECT ${col(je, "value")} FROM ${jsonEach(backCol(newAlias))} ${q(je)})`,
        back,
      );
    }
    s.collection = back;
    s.alias = newAlias;

    if (multiple) s.withMultiMatch = true;
    else if (!s.withMultiMatch) {
      // A unique single relation can point back at most once, so no multi-match is needed.
      const unique = !!backField.unique ||
        (back.indexes ?? []).some((ix) => ix.unique && ix.fields.length === 1 && ix.fields[0] === backField.name);
      s.withMultiMatch = !unique;
    }
    const newAlias2 = `${s.mmAlias}_${prop}`;
    if (!multiple) {
      s.mm.joins.push({ table: q(back.slug), alias: newAlias2, on: `${backCol(newAlias2)} = ${col(s.mmAlias, "id")}` });
    } else {
      const je2 = `__je_${newAlias2}`;
      s.mm.joins.push({
        table: q(back.slug),
        alias: newAlias2,
        on: `${col(s.mmAlias, "id")} IN (SELECT ${col(je2, "value")} FROM ${jsonEach(backCol(newAlias2))} ${q(je2)})`,
      });
    }
    s.mmAlias = newAlias2;
    return true;
  }

  private finalize(s: RunState, c: CollectionConfig, prop: string): Resolved {
    const [name, modifier] = splitModifier(prop);
    const field = getField(c, name);
    if (!field) {
      if (s.nullifyMissing) return { id: "NULL", params: [] };
      throw fail(`unknown field "${name}"`);
    }
    if (field.hidden && !this.ctx.allowHidden) throw fail(`non-filterable field "${name}"`);
    const isBase = s.alias === this.baseAlias;
    const column = (alias: string) => col(alias, field.name);

    if (modifier === "length" && isMultiValuer(field)) {
      const out: Resolved = { id: jsonArrayLength(column(s.alias)), params: [] };
      if (s.withMultiMatch) {
        s.mm.value = jsonArrayLength(column(s.mmAlias));
        out.multiMatch = s.mm;
      }
      return out;
    }

    if (modifier === "each" && isMultiValuer(field)) {
      const jeAlias = `__je_${s.alias}_${field.name}`;
      this.registerJoin(jsonEach(fieldColumn(s.alias, field, isBase)), jeAlias, undefined);
      const out: Resolved = { id: col(jeAlias, "value"), params: [] };
      if (isMultiple(field)) s.withMultiMatch = true;
      if (s.withMultiMatch) {
        const jeAlias2 = `__je_${s.mmAlias}_${field.name}`;
        s.mm.joins.push({ table: jsonEach(fieldColumn(s.mmAlias, field, false)), alias: jeAlias2 });
        s.mm.value = col(jeAlias2, "value");
        out.multiMatch = s.mm;
      }
      return out;
    }

    const out: Resolved = { id: fieldColumn(s.alias, field, isBase), params: [] };
    if (s.withMultiMatch) {
      s.mm.value = fieldColumn(s.mmAlias, field, false);
      out.multiMatch = s.mm;
    } else if (isBase && !modifier && textAffinity(field)) {
      out.bare = { column: column(s.alias), sortable: neverEmpty(c, field) };
    }

    // Only auth records with a public email may be matched on it.
    if (field.name === "email" && !this.ctx.allowHidden && c.auth) {
      const alias = s.alias;
      out.afterBuild = (expr) => `((${expr}) AND (${col(alias, "emailVisibility")} = TRUE))`;
    }

    // json_extract so top-level primitives stored as json compare like their SQL equivalent (PB #4068).
    if (field.type === "json") {
      out.nullFallback = NullFallback.Disabled;
      out.id = jsonExtract(column(s.alias), "");
      if (s.withMultiMatch) s.mm.value = jsonExtract(column(s.mmAlias), "");
    }

    if (modifier === "lower") {
      out.id = `LOWER(${out.id})`;
      if (s.withMultiMatch) s.mm.value = `LOWER(${s.mm.value})`;
    }
    return out;
  }
}

/** Compiles a PB filter and/or sort for collection c in one pass. */
export function compilePb(
  c: CollectionConfig,
  input: { filter?: string; sort?: SortField[] },
  ctx: FilterContext,
): CompiledQuery {
  const compiler = new PbCompiler(c, ctx);
  if (input.filter !== undefined) compiler.filter(input.filter);
  if (input.sort?.length) compiler.sort(input.sort);
  return compiler.build();
}
