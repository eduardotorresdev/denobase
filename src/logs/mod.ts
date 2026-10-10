import type { DatabaseSync } from "node:sqlite";
import type { CollectionConfig } from "../core/types.ts";
import { newId } from "../core/db.ts";
import { compilePb, parsePbSort } from "../query/pbfilter.ts";
import * as sql from "../store/sqlite.ts";
import { nowStamp, stamp } from "../core/time.ts";
import { badRequest } from "../core/errors.ts";
import { currentTrace } from "../telemetry/context.ts";
import { deleteInBatches } from "../cron/tasks/batched_delete.ts";

/** A page of PB's search provider: {page, perPage, totalItems, totalPages, items}. */
export type Page<T> = {
  page: number;
  perPage: number;
  totalItems: number;
  totalPages: number;
  items: T[];
};

/** PB slog levels as stored in _logs.level. */
export const LEVEL = { debug: -4, info: 0, warn: 4, error: 8 } as const;

/** PB core.Log as the API exports it. */
export interface Log {
  id: string;
  created: string;
  data: Record<string, unknown>;
  message: string;
  level: number;
}

/** _logs read like a collection so PB's filter/sort compile against it (id, created, level, message, data.*). */
const LOGS: CollectionConfig = {
  slug: "_logs",
  fields: [
    { name: "level", type: "number" },
    { name: "message", type: "text" },
    { name: "data", type: "json" },
  ],
};

const MAX_MESSAGE = 8000;
const DEFAULT_MAX_DATA = 16 << 10;

/** PB's auxiliary db: logs live apart from the data so heavy logging never contends with record writes. */
export class Logs {
  constructor(readonly db: DatabaseSync) {
    db.exec(`CREATE TABLE IF NOT EXISTS _logs (
      id TEXT PRIMARY KEY NOT NULL, level INTEGER DEFAULT 0 NOT NULL, message TEXT DEFAULT '' NOT NULL,
      data JSON DEFAULT '{}' NOT NULL, created TEXT DEFAULT '' NOT NULL, updated TEXT DEFAULT '' NOT NULL);
      CREATE INDEX IF NOT EXISTS idx_logs_level ON _logs (level);
      CREATE INDEX IF NOT EXISTS idx_logs_message ON _logs (message);
      CREATE INDEX IF NOT EXISTS idx_logs_created_hour ON _logs (strftime('%Y-%m-%d %H:00:00', created));`);
  }

  /** Inside a trace the entry carries data.traceId/spanId (unless given), which links logs and traces both ways. */
  add(level: number, message: string, data: Record<string, unknown>, maxDataSize = 0): void {
    const t = currentTrace();
    if (t && data.traceId === undefined) data = { ...data, traceId: t.traceId, spanId: t.spanId };
    let json = JSON.stringify(data);
    // PB drops oversized data instead of the whole entry.
    if (json.length > (maxDataSize > 0 ? maxDataSize : DEFAULT_MAX_DATA)) json = JSON.stringify({ type: data.type });
    const now = nowStamp();
    this.db.prepare(`INSERT INTO _logs (id, level, message, data, created, updated) VALUES (?, ?, ?, ?, ?, ?)`)
      .run(newId(), level, message.slice(0, MAX_MESSAGE), json, now, now);
  }

  #compile(filter?: string, sort?: string) {
    try {
      return compilePb(LOGS, { filter: filter || undefined, sort: sort ? parsePbSort(sort) : undefined }, {
        collections: [LOGS],
        request: null,
        allowHidden: true,
      });
    } catch {
      throw badRequest("Invalid filter format.");
    }
  }

  /** PB search provider shape: {page, perPage, totalItems, totalPages, items}. */
  list(q: { filter?: string; sort?: string; page?: number; perPage?: number }): Page<Log> {
    const page = q.page && q.page > 0 ? q.page : 1;
    const perPage = Math.min(q.perPage && q.perPage > 0 ? q.perPage : 30, 1000);
    const pb = this.#compile(q.filter, q.sort);
    const totalItems = sql.count(this.db, LOGS, undefined, pb);
    const items = sql.findMany(this.db, LOGS, { limit: perPage, offset: (page - 1) * perPage }, pb).map(toLog);
    return { page, perPage, totalItems, totalPages: Math.ceil(totalItems / perPage), items };
  }

  get(id: string): Log | null {
    const row = sql.findOne(this.db, LOGS, id);
    return row ? toLog(row) : null;
  }

  /** Requests per hour, PB LogsStats. */
  stats(filter?: string): { date: string; total: number }[] {
    const pb = this.#compile(filter);
    const where = pb.where ? `WHERE ${pb.where}` : "";
    const rows = this.db.prepare(
      `SELECT COUNT("_logs"."id") AS total, strftime('%Y-%m-%d %H:00:00', "_logs"."created") AS date
       FROM "_logs" ${pb.joins.join(" ")} ${where} GROUP BY date ORDER BY date`,
    ).all(...pb.joinParams, ...pb.params) as { total: number; date: string }[];
    return rows.map((r) => ({ date: `${r.date}.000Z`, total: Number(r.total) }));
  }

  truncate(): void {
    this.db.exec(`DELETE FROM _logs`);
    try {
      this.db.exec("VACUUM");
    } catch { /* PB only warns when the aux VACUUM fails */ }
  }

  /** PB DeleteOldLogs, run by the __pbLogsCleanup__ job. */
  async deleteOlderThan(date: Date): Promise<void> {
    await deleteInBatches(this.db, "_logs", "created <= ?", [stamp(date)]);
  }
}

function toLog(d: Record<string, unknown>): Log {
  return {
    id: String(d.id),
    created: String(d.created),
    data: (d.data ?? {}) as Record<string, unknown>,
    message: String(d.message ?? ""),
    level: Number(d.level ?? 0),
  };
}
