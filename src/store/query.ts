import type { CollectionConfig, Where, WhereOp } from "../core/types.ts";
import { badRequest } from "../core/errors.ts";
import { andWhere, queryableField } from "../query/mod.ts";
import { quoteIdent } from "../schema/mod.ts";

export type SortDirection = "asc" | "desc";

/** One sort key; "@random" and "@rowid" are PB's special keys; dotted paths join relations like PB sort. */
export interface OrderBy {
  field: string;
  direction?: SortDirection;
}

/**
 * Engine-agnostic query: the store's adapter translates it to its own language (SQLite today). Where is the
 * Payload-style tree access rules already answer with, so a rule and a caller's filter merge without either winning.
 */
export interface Query {
  where?: Where;
  orderBy?: OrderBy[];
  limit?: number;
  offset?: number;
}

/** PB sort ("-created,+titulo,@random") to OrderBy[]. */
export function parseSort(sort: string): OrderBy[] {
  return sort.split(",").map((s) => s.trim()).filter(Boolean).map((s) =>
    s === "@random" ? { field: s } : { field: s.replace(/^[-+]/, ""), direction: s.startsWith("-") ? "desc" : "asc" }
  );
}

/**
 * OrderBy[] of plain fields to "ORDER BY ..." ("" when empty); unknown or hidden fields -> ApiError 400, like PB.
 * The engine compiles relation paths through the PB compiler; this is the join-free fallback.
 */
export function orderByToSql(c: CollectionConfig, orderBy: OrderBy[] = []): string {
  const parts = orderBy.map((o) => {
    if (o.field === "@random") return "RANDOM()";
    if (o.field === "@rowid") return `${quoteIdent(c.slug)}."_rowid_" ${o.direction === "desc" ? "DESC" : "ASC"}`;
    const f = queryableField(c, o.field);
    if (!f) throw badRequest(`Invalid sort field "${o.field}".`);
    return `${quoteIdent(c.slug)}.${quoteIdent(f.name)} ${o.direction === "desc" ? "DESC" : "ASC"}`;
  });
  return parts.length ? `ORDER BY ${parts.join(", ")}` : "";
}

/** A record key, or a dotted path through relations ("cargo.titulo"). */
export type Path<R> = (keyof R & string) | `${string}.${string}`;

/** What a builder runs against: a collection store, bound to its db and principal. */
export interface QueryRunner<R> {
  find(q: Query): Promise<R[]>;
  count(q: Query): Promise<number>;
}

/** Immutable, typed builder over Query; nothing reaches SQL until all/first/count. */
export class QueryBuilder<R> {
  constructor(private readonly runner: QueryRunner<R>, private readonly q: Query = {}) {}

  private with(patch: Partial<Query>): QueryBuilder<R> {
    return new QueryBuilder(this.runner, { ...this.q, ...patch });
  }

  /** ANDs a condition: where("cargo", "equals", id) or a Where tree for or/nesting. */
  where(w: Where): QueryBuilder<R>;
  where<K extends Path<R>>(field: K, op: keyof WhereOp, value: unknown): QueryBuilder<R>;
  where(a: Where | string, op?: keyof WhereOp, value?: unknown): QueryBuilder<R> {
    const w = typeof a === "string" ? { [a]: { [op!]: value } } as Where : a;
    return this.with({ where: this.q.where ? andWhere(this.q.where, w) : w });
  }

  orderBy(field: Path<R> | "@random" | "@rowid", direction: SortDirection = "asc"): QueryBuilder<R> {
    return this.with({ orderBy: [...(this.q.orderBy ?? []), { field, direction }] });
  }

  limit(n: number): QueryBuilder<R> {
    return this.with({ limit: n });
  }

  offset(n: number): QueryBuilder<R> {
    return this.with({ offset: n });
  }

  toQuery(): Query {
    return structuredClone(this.q);
  }

  all(): Promise<R[]> {
    return this.runner.find(this.q);
  }

  async first(): Promise<R | undefined> {
    return (await this.runner.find({ ...this.q, limit: 1 }))[0];
  }

  count(): Promise<number> {
    return this.runner.count(this.q);
  }

  async exists(): Promise<boolean> {
    return (await this.first()) !== undefined;
  }
}
