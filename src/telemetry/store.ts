import type { DatabaseSync, SQLInputValue } from "node:sqlite";
import type { CollectionConfig } from "../core/types.ts";
import { type CompiledQuery, compilePb, parsePbSort } from "../query/pbfilter.ts";
import { stamp } from "../core/time.ts";
import { badRequest } from "../core/errors.ts";
import type { AttrValue, SpanEvent, SpanRecord } from "./span.ts";
import { deleteInBatches, deleteOldestInBatches } from "../cron/tasks/batched_delete.ts";
import type { Page } from "../logs/mod.ts";

/** _spans read like a collection, as _logs is, so PB filter/sort compile against it (attributes.* included). */
const SPANS: CollectionConfig = {
  slug: "_spans",
  fields: [
    { name: "traceId", type: "text" },
    { name: "parentId", type: "text" },
    { name: "name", type: "text" },
    { name: "kind", type: "number" },
    { name: "status", type: "number" },
    { name: "start", type: "number" },
    { name: "duration", type: "number" },
    { name: "root", type: "number" },
    { name: "rootName", type: "text" },
    { name: "attributes", type: "json" },
    { name: "events", type: "json" },
  ],
};

/** A flat OTel-style attribute name, the only shape stats?groupBy=attribute takes. */
const ATTR_KEY = /^[a-z0-9_]+(\.[a-z0-9_]+)*$/i;

/** Row ceiling of _spans whatever maxDays says: the cleanup job trims the oldest beyond it. */
export const MAX_SPAN_ROWS = 1_000_000;

/** attributes and events each keep at most this much JSON; past it only the marker stays. */
export const MAX_JSON = 8 << 10;

/** A stored span as the API answers it. */
export interface StoredSpan extends Omit<SpanRecord, "root"> {
  root: boolean;
  rootName: string;
  created: string;
}

/** One trace as the list shows it: its root, plus how many spans and errors it holds. */
export interface TraceSummary {
  traceId: string;
  id: string;
  name: string;
  kind: number;
  status: number;
  start: number;
  duration: number;
  created: string;
  attributes: Record<string, unknown>;
  spanCount: number;
  errorCount: number;
}

export interface SpanNode extends StoredSpan {
  children: SpanNode[];
}

export interface TraceStats {
  date: string;
  total: number;
  errors: number;
  p50: number;
  p95: number;
  p99: number;
}

const json = (v: unknown): string => {
  const s = JSON.stringify(v ?? {});
  return s.length > MAX_JSON ? JSON.stringify(Array.isArray(v) ? [{ name: "truncated" }] : { truncated: true }) : s;
};

const parse = (v: unknown, fallback: unknown) => {
  try {
    return typeof v === "string" ? JSON.parse(v) : v ?? fallback;
  } catch {
    return fallback;
  }
};

function toSpan(r: Record<string, unknown>): StoredSpan {
  return {
    id: String(r.id),
    traceId: String(r.traceId),
    parentId: String(r.parentId ?? ""),
    name: String(r.name ?? ""),
    kind: Number(r.kind ?? 0) as SpanRecord["kind"],
    status: Number(r.status ?? 0) as SpanRecord["status"],
    start: Number(r.start ?? 0),
    duration: Number(r.duration ?? 0),
    root: Number(r.root) === 1,
    rootName: String(r.rootName ?? ""),
    attributes: parse(r.attributes, {}) as SpanRecord["attributes"],
    events: parse(r.events, []) as SpanEvent[],
    created: String(r.created ?? ""),
  };
}

/** Root rows carry the trace's figures; count and errors come from its spans by the traceId index. */
const SUMMARY_SELECT = `SELECT "_spans".*,
  (SELECT COUNT(*) FROM "_spans" s WHERE s."traceId" = "_spans"."traceId") AS "spanCount",
  (SELECT COUNT(*) FROM "_spans" s WHERE s."traceId" = "_spans"."traceId" AND s."status" = 2) AS "errorCount"`;

/**
 * Spans in the auxiliary db, next to _logs (PB keeps observability apart from the data so it never contends with
 * record writes). One row per span; a trace is its rows by traceId and the list reads only roots.
 */
export class Spans {
  constructor(readonly db: DatabaseSync) {
    db.exec(`CREATE TABLE IF NOT EXISTS _spans (
      id TEXT PRIMARY KEY NOT NULL, "traceId" TEXT NOT NULL, "parentId" TEXT DEFAULT '' NOT NULL,
      name TEXT DEFAULT '' NOT NULL, kind INTEGER DEFAULT 0 NOT NULL, status INTEGER DEFAULT 0 NOT NULL,
      start INTEGER DEFAULT 0 NOT NULL, duration REAL DEFAULT 0 NOT NULL, root INTEGER DEFAULT 0 NOT NULL,
      "rootName" TEXT DEFAULT '' NOT NULL, attributes JSON DEFAULT '{}' NOT NULL, events JSON DEFAULT '[]' NOT NULL,
      created TEXT DEFAULT '' NOT NULL, updated TEXT DEFAULT '' NOT NULL);
      CREATE INDEX IF NOT EXISTS idx_spans_trace ON _spans ("traceId");
      DROP INDEX IF EXISTS idx_spans_root_created;
      CREATE INDEX IF NOT EXISTS idx_spans_root_created_duration ON _spans (root, created, duration);
      CREATE INDEX IF NOT EXISTS idx_spans_name ON _spans (name);
      CREATE INDEX IF NOT EXISTS idx_spans_created ON _spans (created);
      CREATE INDEX IF NOT EXISTS idx_spans_status_created ON _spans (status, created);`);
  }

  /** Whole traces in one transaction: rootName is copied onto every span so a filter on it finds the children. */
  insertMany(spans: SpanRecord[]): void {
    if (!spans.length) return;
    const rootName = new Map<string, string>();
    for (const s of spans) if (s.root) rootName.set(s.traceId, s.name);
    const stmt = this.db.prepare(
      `INSERT OR REPLACE INTO _spans (id, "traceId", "parentId", name, kind, status, start, duration, root,
       "rootName", attributes, events, created, updated) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    const own = !this.db.isTransaction;
    if (own) this.db.exec("BEGIN");
    try {
      for (const s of spans) {
        const created = stamp(new Date(Math.floor(s.start / 1000)));
        stmt.run(
          s.id,
          s.traceId,
          s.parentId,
          s.name.slice(0, 500),
          s.kind,
          s.status,
          s.start,
          s.duration,
          s.root ? 1 : 0,
          (rootName.get(s.traceId) ?? "").slice(0, 500),
          json(s.attributes),
          json(s.events),
          created,
          created,
        );
      }
      if (own) this.db.exec("COMMIT");
    } catch (e) {
      if (own) this.db.exec("ROLLBACK");
      throw e;
    }
  }

  #compile(filter?: string, sort?: string): CompiledQuery {
    try {
      return compilePb(SPANS, { filter: filter || undefined, sort: sort ? parsePbSort(sort) : undefined }, {
        collections: [SPANS],
        request: null,
        allowHidden: true,
        flatJsonKeys: true,
      });
    } catch {
      throw badRequest("Invalid filter format.");
    }
  }

  /** Roots of the traces that hold at least one span matching filter (a filter on children finds their trace). */
  #roots(filter?: string): { sql: string; params: SQLInputValue[] } {
    const pb = this.#compile(filter);
    if (!pb.where) return { sql: `"_spans"."root" = 1`, params: [] };
    return {
      sql: `"_spans"."root" = 1 AND "_spans"."traceId" IN (SELECT "_spans"."traceId" FROM "_spans" ${
        pb.joins.join(" ")
      } WHERE ${pb.where})`,
      params: [...pb.joinParams, ...pb.params] as SQLInputValue[],
    };
  }

  /** PB search shape over traces: {page, perPage, totalItems, totalPages, items}; newest first by default. */
  listTraces(q: { filter?: string; sort?: string; page?: number; perPage?: number } = {}): Page<TraceSummary> {
    const page = q.page && q.page > 0 ? q.page : 1;
    const perPage = Math.min(q.perPage && q.perPage > 0 ? q.perPage : 30, 500);
    const where = this.#roots(q.filter);
    const order = this.#compile(undefined, q.sort || "-start").orderBy;
    const totalItems = Number(
      (this.db.prepare(`SELECT COUNT(*) AS n FROM "_spans" WHERE ${where.sql}`).get(...where.params) as { n: number })
        .n,
    );
    const rows = this.db.prepare(`${SUMMARY_SELECT} FROM "_spans" WHERE ${where.sql} ${order} LIMIT ? OFFSET ?`)
      .all(...where.params, perPage, (page - 1) * perPage) as Record<string, unknown>[];
    const items: TraceSummary[] = rows.map((r) => {
      const s = toSpan(r);
      return {
        traceId: s.traceId,
        id: s.id,
        name: s.name,
        kind: s.kind,
        status: s.status,
        start: s.start,
        duration: s.duration,
        created: s.created,
        attributes: s.attributes,
        spanCount: Number(r.spanCount),
        errorCount: Number(r.errorCount),
      };
    });
    return { page, perPage, totalItems, totalPages: Math.ceil(totalItems / perPage), items };
  }

  spans(traceId: string): StoredSpan[] {
    return (this.db.prepare(`SELECT * FROM "_spans" WHERE "traceId" = ? ORDER BY start, id`).all(traceId) as Record<
      string,
      unknown
    >[]).map(toSpan);
  }

  /**
   * The trace as a tree under its local root, children by start. Spans whose parent is not stored (dropped by
   * minDurationMs, or the remote caller) hang from the root so nothing recorded goes missing.
   */
  getTrace(traceId: string): { traceId: string; root: SpanNode; spans: number } | null {
    const all = this.spans(traceId);
    const rootSpan = all.find((s) => s.root);
    if (!rootSpan) return null;
    const nodes = new Map(all.map((s) => [s.id, { ...s, children: [] as SpanNode[] }]));
    const root = nodes.get(rootSpan.id)!;
    for (const n of nodes.values()) {
      if (n === root) continue;
      (nodes.get(n.parentId) ?? root).children.push(n);
    }
    return { traceId, root, spans: all.length };
  }

  /**
   * Traces per hour with errors and nearest-rank duration percentiles of their roots, computed in SQL by a window
   * ordered by duration inside each hour.
   */
  stats(filter?: string): TraceStats[] {
    const where = this.#roots(filter);
    const hour = `strftime('%Y-%m-%d %H:00:00', "_spans"."created")`;
    const rows = this.db.prepare(
      `WITH r AS (SELECT ${hour} AS date, "_spans".duration AS d, "_spans".status AS st,
         ROW_NUMBER() OVER (PARTITION BY ${hour} ORDER BY "_spans".duration) AS rn,
         COUNT(*) OVER (PARTITION BY ${hour}) AS n
       FROM "_spans" WHERE ${where.sql})
       SELECT date, MAX(n) AS total, SUM(st = 2) AS errors,
         MIN(CASE WHEN rn >= 0.50 * n THEN d END) AS p50,
         MIN(CASE WHEN rn >= 0.95 * n THEN d END) AS p95,
         MIN(CASE WHEN rn >= 0.99 * n THEN d END) AS p99
       FROM r GROUP BY date ORDER BY date`,
    ).all(...where.params) as Record<string, unknown>[];
    return rows.map((r) => ({
      date: `${r.date}.000Z`,
      total: Number(r.total),
      errors: Number(r.errors ?? 0),
      p50: Number(r.p50 ?? 0),
      p95: Number(r.p95 ?? 0),
      p99: Number(r.p99 ?? 0),
    }));
  }

  /** Whole-period figures of the roots (stats?groupBy=total): real percentiles, not the worst hourly ones. */
  overall(filter?: string): { total: number; errors: number; p50: number; p95: number; p99: number } {
    const where = this.#roots(filter);
    const r = this.db.prepare(
      `WITH r AS (SELECT "_spans".duration AS d, "_spans".status AS st,
         ROW_NUMBER() OVER (ORDER BY "_spans".duration) AS rn, COUNT(*) OVER () AS n
       FROM "_spans" WHERE ${where.sql})
       SELECT MAX(n) AS total, SUM(st = 2) AS errors,
         MIN(CASE WHEN rn >= 0.50 * n THEN d END) AS p50,
         MIN(CASE WHEN rn >= 0.95 * n THEN d END) AS p95,
         MIN(CASE WHEN rn >= 0.99 * n THEN d END) AS p99
       FROM r`,
    ).get(...where.params) as Record<string, unknown>;
    return {
      total: Number(r.total ?? 0),
      errors: Number(r.errors ?? 0),
      p50: Number(r.p50 ?? 0),
      p95: Number(r.p95 ?? 0),
      p99: Number(r.p99 ?? 0),
    };
  }

  /** The slowest root names by p95 (stats?groupBy=name). */
  slowest(filter?: string, limit = 10): { name: string; total: number; errors: number; p50: number; p95: number }[] {
    const where = this.#roots(filter);
    const rows = this.db.prepare(
      `WITH r AS (SELECT "_spans".name AS name, "_spans".duration AS d, "_spans".status AS st,
         ROW_NUMBER() OVER (PARTITION BY "_spans".name ORDER BY "_spans".duration) AS rn,
         COUNT(*) OVER (PARTITION BY "_spans".name) AS n
       FROM "_spans" WHERE ${where.sql})
       SELECT name, MAX(n) AS total, SUM(st = 2) AS errors,
         MIN(CASE WHEN rn >= 0.50 * n THEN d END) AS p50,
         MIN(CASE WHEN rn >= 0.95 * n THEN d END) AS p95
       FROM r GROUP BY name ORDER BY p95 DESC LIMIT ?`,
    ).all(...where.params, limit) as Record<string, unknown>[];
    return rows.map((r) => ({
      name: String(r.name),
      total: Number(r.total),
      errors: Number(r.errors ?? 0),
      p50: Number(r.p50 ?? 0),
      p95: Number(r.p95 ?? 0),
    }));
  }

  /**
   * Roots grouped by the value of one of their attributes (stats?groupBy=attribute&key=assistente.origem), slowest
   * p95 first; roots without it group under null. key is a flat attribute name, checked before it reaches the SQL.
   */
  byAttribute(
    key: string,
    filter?: string,
    limit = 50,
  ): { value: AttrValue; total: number; errors: number; p50: number; p95: number }[] {
    if (!ATTR_KEY.test(key)) throw badRequest("Invalid attribute key.");
    const where = this.#roots(filter);
    const v = `json_extract("_spans".attributes, '$."${key}"')`;
    const rows = this.db.prepare(
      `WITH r AS (SELECT ${v} AS value, "_spans".duration AS d, "_spans".status AS st,
         ROW_NUMBER() OVER (PARTITION BY ${v} ORDER BY "_spans".duration) AS rn,
         COUNT(*) OVER (PARTITION BY ${v}) AS n
       FROM "_spans" WHERE ${where.sql})
       SELECT value, MAX(n) AS total, SUM(st = 2) AS errors,
         MIN(CASE WHEN rn >= 0.50 * n THEN d END) AS p50,
         MIN(CASE WHEN rn >= 0.95 * n THEN d END) AS p95
       FROM r GROUP BY value ORDER BY p95 DESC LIMIT ?`,
    ).all(...where.params, limit) as Record<string, unknown>[];
    return rows.map((r) => ({
      value: (r.value ?? null) as AttrValue,
      total: Number(r.total),
      errors: Number(r.errors ?? 0),
      p50: Number(r.p50 ?? 0),
      p95: Number(r.p95 ?? 0),
    }));
  }

  /** Dashboard figures: traces, failed traces and root p95 since `since`. */
  summary(since: Date): { count: number; errors: number; p95: number } {
    const from = stamp(since);
    const agg = this.db.prepare(
      `SELECT COUNT(*) AS n, COALESCE(SUM(status = 2), 0) AS e FROM "_spans" WHERE root = 1 AND created >= ?`,
    ).get(from) as { n: number; e: number };
    const n = Number(agg.n);
    // Nearest rank by index: one row read, not the day's durations.
    const p95 = n
      ? (this.db.prepare(
        `SELECT duration FROM "_spans" WHERE root = 1 AND created >= ? ORDER BY duration LIMIT 1 OFFSET ?`,
      ).get(from, Math.max(0, Math.ceil(0.95 * n) - 1)) as { duration: number }).duration
      : 0;
    return { count: n, errors: Number(agg.e), p95: Number(p95) };
  }

  truncate(): void {
    this.db.exec(`DELETE FROM _spans`);
  }

  /** Run by the __denobaseTracesCleanup__ job, in batches that release the write lock between them. */
  async deleteOlderThan(date: Date): Promise<void> {
    await deleteInBatches(this.db, "_spans", "created <= ?", [stamp(date)]);
  }

  /** Keeps at most maxRows spans, deleting the oldest in batches (the cleanup job's size cap). */
  async trimTo(maxRows: number): Promise<void> {
    const n = Number((this.db.prepare(`SELECT COUNT(*) AS n FROM _spans`).get() as { n: number }).n);
    if (n > maxRows) await deleteOldestInBatches(this.db, "_spans", "created, rowid", n - maxRows);
  }
}
