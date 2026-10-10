import type { CollectionAccess, CollectionConfig, Field, Hooks, Where, WhereOp } from "../core/types.ts";
import { andWhere } from "../query/mod.ts";
import { pathScope, resolvePath, scopedWhere } from "../query/where.ts";
import { quoteIdent } from "../schema/mod.ts";
import type { Aggregate, ViewColumn, ViewQuery } from "./types.ts";

export type { Aggregate, AggregateFn, ViewColumn, ViewQuery } from "./types.ts";

export const count = (path?: string): Aggregate => (path ? { fn: "count", path } : { fn: "count" });
export const sum = (path: string): Aggregate => ({ fn: "sum", path });
export const avg = (path: string): Aggregate => ({ fn: "avg", path });
export const min = (path: string): Aggregate => ({ fn: "min", path });
export const max = (path: string): Aggregate => ({ fn: "max", path });

const IMPLICIT = new Set(["id", "created", "updated"]);

/** Immutable builder of a ViewQuery; every call returns a new builder. */
export class ViewBuilder<S extends Record<string, ViewColumn> = Record<string, ViewColumn>> {
  constructor(readonly query: ViewQuery) {}

  select<T extends Record<string, ViewColumn>>(cols: T): ViewBuilder<T> {
    return new ViewBuilder<T>({ ...this.query, select: { ...cols } });
  }

  where(w: Where): ViewBuilder<S>;
  where(path: string, op: keyof WhereOp, value: unknown): ViewBuilder<S>;
  where(a: Where | string, op?: keyof WhereOp, value?: unknown): ViewBuilder<S> {
    const w = typeof a === "string" ? { [a]: { [op!]: value } } as Where : a;
    return new ViewBuilder<S>({ ...this.query, where: this.query.where ? andWhere(this.query.where, w) : w });
  }

  groupBy(...paths: string[]): ViewBuilder<S> {
    return new ViewBuilder<S>({ ...this.query, groupBy: [...(this.query.groupBy ?? []), ...paths] });
  }
}

/** Starts a view query over a collection (or its slug). */
export function from(c: CollectionConfig | string): ViewBuilder<Record<never, ViewColumn>> {
  return new ViewBuilder({ from: typeof c === "string" ? c : c.slug, select: {} });
}

/** Ungrouped views default id to the source id; a grouped one must say which column identifies a row. */
export function normalizeView(slug: string, q: ViewQuery): ViewQuery {
  if (q.sql !== undefined) {
    if (!q.fields?.length) throw new Error(`view ${slug}: a SQL view must declare its fields`);
    return q;
  }
  if ("id" in q.select) return q;
  if (q.groupBy?.length) throw new Error(`view ${slug}: a grouped view must select an id column`);
  return { ...q, select: { id: "id", ...q.select } };
}

/**
 * A view over raw SQL, for what the builder cannot express (UNION, COALESCE, `||`). The SELECT
 * must project `id` and every declared field; `from` names the main source for documentation and ordering.
 */
export function sqlView(from: CollectionConfig | string, sql: string, fields: Field[]): ViewQuery {
  return { from: typeof from === "string" ? from : from.slug, select: {}, sql: sql.trim(), fields };
}

export interface ViewConfig<S extends Record<string, ViewColumn>> {
  slug: string;
  query: ViewBuilder<S> | ViewQuery;
  /** Views are read-only: only read access, like PB's list/view rules on a view collection. */
  access?: { read?: CollectionAccess };
  hooks?: Pick<Hooks, "beforeRead" | "afterRead">;
}

/** A read-only collection backed by a SQL VIEW; its fields are derived from the query on registration. */
export function defineView<const S extends Record<string, ViewColumn>>(cfg: ViewConfig<S>): CollectionConfig & {
  view: ViewQuery;
} {
  const q = cfg.query instanceof ViewBuilder ? cfg.query.query : cfg.query;
  return {
    slug: cfg.slug,
    fields: [],
    view: normalizeView(cfg.slug, q),
    access: cfg.access ? { read: cfg.access.read } : undefined,
    hooks: cfg.hooks,
  };
}

function sourceOf(q: ViewQuery, all: CollectionConfig[]): CollectionConfig {
  const c = all.find((x) => x.slug === q.from);
  if (!c) throw new Error(`view source "${q.from}" is not a registered collection`);
  return c;
}

/** Output fields of a view: a path keeps its source field's type (relations stay expandable), aggregates are numbers. */
export function deriveViewFields(q: ViewQuery, all: CollectionConfig[]): Field[] {
  if (q.sql !== undefined) return (q.fields ?? []).filter((f) => !IMPLICIT.has(f.name)).map((f) => ({ ...f }));
  const scope = pathScope(sourceOf(q, all), all);
  const out: Field[] = [];
  for (const [name, col] of Object.entries(q.select)) {
    if (IMPLICIT.has(name)) continue;
    if (typeof col === "object" && (col.fn === "count" || col.fn === "sum" || col.fn === "avg")) {
      out.push({ name, type: "number", ...(col.fn === "count" ? { integer: true } : {}) });
      continue;
    }
    const src = resolvePath(scope, typeof col === "string" ? col : col.path!).field;
    out.push(viewField(name, src));
  }
  return out;
}

/** Copies only what decodes and filters the value; source constraints (required, unique, hooks) are not the view's. */
function viewField(name: string, f: Field): Field {
  switch (f.type) {
    case "number":
      return { name, type: "number", ...(f.integer ? { integer: true } : {}) };
    case "select":
      return { name, type: "select", options: [...f.options], ...(f.hasMany ? { hasMany: true } : {}) };
    case "relationship":
      return { name, type: "relationship", relationTo: f.relationTo, ...(f.hasMany ? { hasMany: true } : {}) };
    case "file":
      return { name, type: "file", ...(f.maxSelect ? { maxSelect: f.maxSelect } : {}) };
    default:
      return { name, type: f.type } as Field;
  }
}

function aggregateSql(scope: ReturnType<typeof pathScope>, a: Aggregate): string {
  if (a.fn === "count" && !a.path) return "COUNT(*)";
  const e = resolvePath(scope, a.path!).sql;
  return `${a.fn.toUpperCase()}(${e})`;
}

/** SELECT a view is made of; values are inlined (CREATE VIEW binds nothing) through the same where compiler. */
export function viewSelectSql(q: ViewQuery, all: CollectionConfig[]): string {
  if (q.sql !== undefined) return q.sql;
  const src = sourceOf(q, all);
  const scope = pathScope(src, all);
  const cols = Object.entries(q.select).map(([name, col]) => {
    const e = typeof col === "string" ? resolvePath(scope, col).sql : aggregateSql(scope, col);
    return `${e} AS ${quoteIdent(name)}`;
  });
  const where = q.where && Object.keys(q.where).length ? scopedWhere(scope, q.where) : "";
  const group = q.groupBy?.length ? ` GROUP BY ${q.groupBy.map((p) => resolvePath(scope, p).sql).join(", ")}` : "";
  return `SELECT ${cols.join(", ")} FROM ${quoteIdent(src.slug)}${
    scope.ctx.joins.length ? " " + scope.ctx.joins.join(" ") : ""
  }${where ? ` WHERE ${where}` : ""}${group}`;
}

export function createViewSql(slug: string, q: ViewQuery, all: CollectionConfig[]): string {
  return `CREATE VIEW ${quoteIdent(slug)} AS ${viewSelectSql(q, all)}`;
}
