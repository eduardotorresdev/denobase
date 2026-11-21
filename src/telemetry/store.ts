import type { DatabaseSync, SQLInputValue } from "node:sqlite";
import type { CollectionConfig } from "../core/types.ts";
import { type CompiledQuery, compilePb, parsePbSort } from "../query/pbfilter.ts";
import { stamp } from "../core/time.ts";
import { badRequest } from "../core/errors.ts";
import type { AttrValue, SpanEvent, SpanRecord } from "./span.ts";
import { deleteInBatches, deleteOldestInBatches } from "../cron/tasks/batched_delete.ts";
import type { Page } from "../logs/mod.ts";
import { histIndex, histQuantile } from "./histogram.ts";
import { ADMIN_UI_ATTR } from "./instrument/http.ts";

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

/** A request's root ("GET /api/..."): the slowest routes leave out cron runs, workers and other roots. */
const HTTP_ROOT = /^[A-Z]+ \//;

/** A PB filter over any span of the trace, alone or with the period its root must start in (a PB date). */
export type TraceQuery = string | { filter?: string; since?: string };

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

function toSummary(r: Record<string, unknown>): TraceSummary {
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
}

/** Count, failures and nearest-rank p50/p95 of a set of root durations. */
export interface TraceFigures {
  total: number;
  errors: number;
  p50: number;
  p95: number;
}

export interface TraceOverview {
  current: TraceFigures;
  previous: TraceFigures;
  hours: (TraceFigures & { date: string })[];
  routes: (TraceFigures & { name: string })[];
  /** Failed cron runs (roots named `cron <id>`) of each half, and per hour of the current one. */
  cronFailed: { current: number; previous: number; hours: { date: string; failed: number }[] };
}

type Rollup = { hour: string; name: string; total: number; errors: number; hist: Record<number, number> };
function roll(acc: Map<string, Rollup>, hour: string, name: string, status: number, ms: number) {
  const key = `${hour}\u0000${name}`;
  let r = acc.get(key);
  if (!r) acc.set(key, r = { hour, name, total: 0, errors: 0, hist: {} });
  r.total++;
  if (Number(status) === 2) r.errors++;
  const k = histIndex(Number(ms));
  r.hist[k] = (r.hist[k] ?? 0) + 1;
}

type HBucket = { total: number; errors: number; hist: Map<number, number> };
const hbucket = (): HBucket => ({ total: 0, errors: 0, hist: new Map() });
function hmerge(b: HBucket, r: { total: number; errors: number }, hist: Record<string, number>) {
  b.total += Number(r.total);
  b.errors += Number(r.errors);
  for (const [k, n] of Object.entries(hist)) b.hist.set(Number(k), (b.hist.get(Number(k)) ?? 0) + n);
}
function hfigures(b: HBucket): TraceFigures {
  return {
    total: b.total,
    errors: b.errors,
    p50: histQuantile(b.hist, b.total, 0.5) ?? 0,
    p95: histQuantile(b.hist, b.total, 0.95) ?? 0,
  };
}

/**
 * The page's roots first, then each one's count and errors from its own spans: the counts run only for the rows
 * returned, never for every matching root before ORDER BY/LIMIT. Both read the traceId index (`+status` keeps the
 * planner off idx_spans_status_created, which made one subquery scan every failed span per root).
 */
const summarySql = (where: string, order: string) =>
  `SELECT p.*,
    (SELECT COUNT(*) FROM "_spans" s WHERE s."traceId" = p."traceId") AS "spanCount",
    (SELECT COUNT(*) FROM "_spans" s WHERE s."traceId" = p."traceId" AND +s."status" = 2) AS "errorCount"
  FROM (SELECT "_spans".* FROM "_spans" WHERE ${where} ${order} LIMIT ? OFFSET ?) p`;

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
      DROP INDEX IF EXISTS idx_spans_name;
      CREATE INDEX IF NOT EXISTS idx_spans_name_created ON _spans (name, created);
      CREATE INDEX IF NOT EXISTS idx_spans_created ON _spans (created);
      CREATE INDEX IF NOT EXISTS idx_spans_status_created ON _spans (status, created);`);
    this.#ensureRollup();
  }

  /**
   * _spans_hourly holds, per hour and root name, the count, the failures and a log-scale histogram of the durations:
   * what the admin home reads, so its figures cost a few hundred small rows instead of a pass over a day of roots
   * (seconds at a million spans, with the event loop blocked). Built once from the stored roots when it is new.
   */
  #ensureRollup(): void {
    if (this.db.prepare(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = '_spans_hourly'`).get()) return;
    const own = !this.db.isTransaction;
    if (own) this.db.exec("BEGIN IMMEDIATE");
    try {
      // Another connection (the job worker) may have built it while this one waited for the lock.
      if (!this.db.prepare(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = '_spans_hourly'`).get()) {
        this.db.exec(`CREATE TABLE _spans_hourly (hour TEXT NOT NULL, name TEXT NOT NULL, total INTEGER NOT NULL,
          errors INTEGER NOT NULL, hist TEXT NOT NULL, PRIMARY KEY (hour, name)) WITHOUT ROWID`);
        const roots = this.db.prepare(
          `SELECT created, name, status, duration FROM "_spans"
           WHERE root = 1 AND json_extract(attributes, '$."${ADMIN_UI_ATTR}"') IS NULL`,
        );
        const acc = new Map<string, Rollup>();
        for (const r of roots.iterate() as Iterable<Record<string, unknown>>) {
          roll(acc, String(r.created).slice(0, 13), String(r.name), Number(r.status), Number(r.duration));
        }
        this.#mergeRollup(acc);
      }
      if (own) this.db.exec("COMMIT");
    } catch (e) {
      if (own) this.db.exec("ROLLBACK");
      throw e;
    }
  }

  /** Adds hour/name partials onto the stored rows (inside the caller's transaction). */
  #mergeRollup(acc: Map<string, Rollup>): void {
    if (!acc.size) return;
    const get = this.db.prepare(`SELECT total, errors, hist FROM _spans_hourly WHERE hour = ? AND name = ?`);
    const put = this.db.prepare(
      `INSERT OR REPLACE INTO _spans_hourly (hour, name, total, errors, hist) VALUES (?, ?, ?, ?, ?)`,
    );
    for (const r of acc.values()) {
      const old = get.get(r.hour, r.name) as { total: number; errors: number; hist: string } | undefined;
      if (old) {
        r.total += Number(old.total);
        r.errors += Number(old.errors);
        for (const [k, n] of Object.entries(parse(old.hist, {}) as Record<string, number>)) {
          r.hist[Number(k)] = (r.hist[Number(k)] ?? 0) + n;
        }
      }
      put.run(r.hour, r.name, r.total, r.errors, JSON.stringify(r.hist));
    }
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
    const acc = new Map<string, Rollup>();
    if (own) this.db.exec("BEGIN");
    try {
      for (const s of spans) {
        const created = stamp(new Date(Math.floor(s.start / 1000)));
        // The admin UI's own requests stay out of the home's figures (ADMIN_UI_ATTR, set by the HTTP middleware).
        if (s.root && !s.attributes?.[ADMIN_UI_ATTR]) {
          roll(acc, created.slice(0, 13), s.name.slice(0, 500), s.status, s.duration);
        }
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
      this.#mergeRollup(acc);
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

  /**
   * Roots of the traces that hold at least one span matching filter (a filter on children finds their trace), and
   * that started at or after `since`. The period goes on the roots themselves, by the (root, created) index: sent as
   * a created filter it took the any-span subquery over every span of the period (a second for a busy day).
   */
  #roots(q: TraceQuery = {}): { sql: string; params: SQLInputValue[] } {
    const { filter, since } = typeof q === "string" ? { filter: q, since: undefined } : q;
    const pb = this.#compile(filter);
    const params: SQLInputValue[] = [];
    let sql = `"_spans"."root" = 1`;
    if (since) {
      sql += ` AND "_spans"."created" >= ?`;
      params.push(since);
    }
    if (!pb.where) return { sql, params };
    // Children start after their root, so the subquery can skip what came before the period too.
    const period = since ? ` AND "_spans"."created" >= ?` : "";
    return {
      sql: `${sql} AND "_spans"."traceId" IN (SELECT "_spans"."traceId" FROM "_spans" ${
        pb.joins.join(" ")
      } WHERE (${pb.where})${period})`,
      params: [...params, ...pb.joinParams, ...pb.params, ...(since ? [since] : [])] as SQLInputValue[],
    };
  }

  /** PB search shape over traces: {page, perPage, totalItems, totalPages, items}; newest first by default. */
  listTraces(
    q: { filter?: string; since?: string; sort?: string; page?: number; perPage?: number } = {},
  ): Page<TraceSummary> {
    const page = q.page && q.page > 0 ? q.page : 1;
    const perPage = Math.min(q.perPage && q.perPage > 0 ? q.perPage : 30, 500);
    const where = this.#roots({ filter: q.filter, since: q.since });
    const order = this.#compile(undefined, q.sort || "-start").orderBy;
    const totalItems = Number(
      (this.db.prepare(`SELECT COUNT(*) AS n FROM "_spans" WHERE ${where.sql}`).get(...where.params) as { n: number })
        .n,
    );
    const rows = this.db.prepare(summarySql(where.sql, order))
      .all(...where.params, perPage, (page - 1) * perPage) as Record<string, unknown>[];
    const items = rows.map(toSummary);
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
  stats(filter?: TraceQuery): TraceStats[] {
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
  overall(filter?: TraceQuery): { total: number; errors: number; p50: number; p95: number; p99: number } {
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
  slowest(
    filter?: TraceQuery,
    limit = 10,
  ): { name: string; total: number; errors: number; p50: number; p95: number }[] {
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
    filter?: TraceQuery,
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

  /**
   * The admin home's trace figures from _spans_hourly: per hour, per half (the last `hours` against the ones before,
   * for the deltas) and the slowest request routes of the current half. Percentiles come from the histogram buckets
   * (each about 10% wide), which is precision enough for a dashboard and keeps this a read of a few hundred rows.
   * Routes rank only with at least `minRoute` traces: a route seen 4 times has no p95 worth ranking.
   */
  overview(now: Date, hours = 24, minRoute = 20): TraceOverview {
    const hourOf = (d: Date) => stamp(d).slice(0, 13);
    const mid = hourOf(new Date(now.getTime() - (hours - 1) * 36e5));
    const from = hourOf(new Date(now.getTime() - (2 * hours - 1) * 36e5));
    const rows = this.db.prepare(`SELECT hour, name, total, errors, hist FROM _spans_hourly WHERE hour >= ?`)
      .all(from) as { hour: string; name: string; total: number; errors: number; hist: string }[];
    const cur = hbucket(), prev = hbucket(), byHour = new Map<string, HBucket>(), byName = new Map<string, HBucket>();
    const cronFailed = { current: 0, previous: 0, hours: new Map<string, number>() };
    for (const r of rows) {
      const hist = parse(r.hist, {}) as Record<string, number>;
      const cronErrors = r.name.startsWith("cron ") ? Number(r.errors) : 0;
      if (r.hour < mid) {
        hmerge(prev, r, hist);
        cronFailed.previous += cronErrors;
        continue;
      }
      if (cronErrors) {
        cronFailed.current += cronErrors;
        cronFailed.hours.set(r.hour, (cronFailed.hours.get(r.hour) ?? 0) + cronErrors);
      }
      hmerge(cur, r, hist);
      hmerge(byHour.get(r.hour) ?? byHour.set(r.hour, hbucket()).get(r.hour)!, r, hist);
      hmerge(byName.get(r.name) ?? byName.set(r.name, hbucket()).get(r.name)!, r, hist);
    }
    return {
      current: hfigures(cur),
      previous: hfigures(prev),
      hours: [...byHour.entries()].sort(([a], [b]) => (a < b ? -1 : 1))
        .map(([h, b]) => ({ date: `${h}:00:00.000Z`, ...hfigures(b) })),
      routes: [...byName.entries()].filter(([name, b]) => HTTP_ROOT.test(name) && b.total >= minRoute)
        .map(([name, b]) => ({ name, ...hfigures(b) }))
        .sort((a, b) => b.p95 - a.p95).slice(0, 5),
      cronFailed: {
        current: cronFailed.current,
        previous: cronFailed.previous,
        hours: [...cronFailed.hours.entries()].map(([h, n]) => ({ date: `${h}:00:00.000Z`, failed: n })),
      },
    };
  }

  /**
   * The newest failed or slow roots since `since`, newest first, read backwards along the (root, created) index.
   * denobase's own maintenance crons (`cron __x__`) count only when they failed: their slowness is the job worker
   * waiting on a WAL checkpoint, and every tick of it would push the app's real problems off the list.
   */
  problems(since: Date, slowMs: number, limit = 6): TraceSummary[] {
    // Slow alone is not an issue for denobase's own maintenance crons nor for the admin UI's calls (a busy disk makes
    // them slow and the panel would list itself); their failures still are.
    const where = `"_spans".root = 1 AND "_spans".created >= ? AND ("_spans".status = 2 OR ("_spans".duration >= ?
      AND "_spans".name NOT LIKE 'cron \\_\\_%' ESCAPE '\\'
      AND json_extract("_spans".attributes, '$."${ADMIN_UI_ATTR}"') IS NULL))`;
    const rows = this.db.prepare(summarySql(where, `ORDER BY "_spans".created DESC`))
      .all(stamp(since), slowMs > 0 ? slowMs : 1e15, limit, 0) as Record<string, unknown>[];
    return rows.map(toSummary);
  }

  truncate(): void {
    this.db.exec(`DELETE FROM _spans; DELETE FROM _spans_hourly`);
  }

  /** Run by the __denobaseTracesCleanup__ job, in batches that release the write lock between them. */
  async deleteOlderThan(date: Date): Promise<void> {
    await deleteInBatches(this.db, "_spans", "created <= ?", [stamp(date)]);
    this.#dropHoursBefore(stamp(date).slice(0, 13));
  }

  /** Hours wholly before the oldest kept span leave the rollup with it (the partial hour stays until it goes). */
  #dropHoursBefore(hour: string): void {
    this.db.prepare(`DELETE FROM _spans_hourly WHERE hour < ?`).run(hour);
  }

  /** Keeps at most maxRows spans, deleting the oldest in batches (the cleanup job's size cap). */
  async trimTo(maxRows: number): Promise<void> {
    const n = Number((this.db.prepare(`SELECT COUNT(*) AS n FROM _spans`).get() as { n: number }).n);
    if (n > maxRows) {
      await deleteOldestInBatches(this.db, "_spans", "created, rowid", n - maxRows);
      const oldest = this.db.prepare(`SELECT MIN(created) AS c FROM _spans`).get() as { c: string | null };
      if (oldest.c) this.#dropHoursBefore(oldest.c.slice(0, 13));
    }
  }
}
