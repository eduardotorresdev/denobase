import type { Field, Where } from "../core/types.ts";

export type AggregateFn = "count" | "sum" | "avg" | "min" | "max";

/** An aggregate column; count without a path is COUNT(*). */
export interface Aggregate {
  fn: AggregateFn;
  path?: string;
}

/** A view column: a source path ("cargo.titulo") or an aggregate. */
export type ViewColumn = string | Aggregate;

/**
 * The query a view collection is made of, as plain JSON so migrations can store and diff it. Paths go through
 * single relations; the output must have an id column (PB requires one), defaulted to the source id when ungrouped.
 */
export interface ViewQuery {
  from: string;
  select: Record<string, ViewColumn>;
  where?: Where;
  groupBy?: string[];
  /**
   * A view the builder cannot express (UNION, COALESCE, string concatenation): the SELECT as written, with its
   * output fields declared since none can be derived. `from` still names the main source; `select` stays empty.
   */
  sql?: string;
  fields?: Field[];
}
