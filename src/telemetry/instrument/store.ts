import type { Span } from "../span.ts";
import { SpanKind } from "../span.ts";
import { normalizeSql } from "../sql.ts";
import { tracedSync, traceSettings } from "./child.ts";

/** System tables of the auxiliary db: their own writes must never trace themselves. */
const AUX = new Set(["_logs", "_spans"]);

/**
 * A `db.query` client span (OTel db semconv) around one SQLite statement. sql is the statement as prepared (params
 * apart), normalized before it is kept; rows, when the call returns them, set db.response.returned_rows.
 */
export function traceQuery<T>(operation: string, collection: string, sql: string, fn: () => T): T {
  if (AUX.has(collection)) return fn();
  return tracedSync("db.query", {
    kind: SpanKind.client,
    attributes: {
      "db.system.name": "sqlite",
      "db.operation.name": operation,
      "db.collection.name": collection || undefined,
    },
  }, (span?: Span) => {
    // A head-dropped trace keeps the raw text in memory and normalizes only if the tail keeps it (Tracer.finish):
    // most such traces are thrown away, and the regexes are the costly part of a db span.
    if (span && traceSettings()?.recordDbText) {
      span.setAttribute("db.query.text", span.sampled ? normalizeSql(sql) : sql);
    }
    const out = fn();
    if (span && Array.isArray(out)) span.setAttribute("db.response.returned_rows", out.length);
    return out;
  });
}
