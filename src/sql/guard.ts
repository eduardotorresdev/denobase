import type { SQLInputValue } from "node:sqlite";
import { traced, traceSettings } from "../telemetry/instrument/child.ts";
import { SpanKind } from "../telemetry/span.ts";
import { normalizeSql } from "../telemetry/sql.ts";

/** Layers that may refuse a query, in order (the value is what telemetry records). */
export type GuardLayer = "forma" | "tabelas" | "limites" | "conexao";

export interface GuardLimits {
  /** Wall time; past it the worker running the query is terminated. Default 15 s. */
  timeoutMs?: number;
  /** Rows returned; one more marks the result truncated. Default 1000. */
  maxRows?: number;
  /** JSON size of the returned rows. Default 256 KiB; past it the result is truncated. */
  maxBytes?: number;
}

export interface GuardOptions extends GuardLimits {
  /**
   * Default-deny allowlist by storage name: a table (or view) outside it refuses the query in "tabelas". Unset,
   * every table but system ones (`_*`, `sqlite_*`, `pragma_*`) is readable.
   */
  tables?: readonly string[];
  /** Columns never readable even in an allowed table ("table.column"), e.g. financial ones without the scope. */
  deniedColumns?: readonly string[];
}

export interface GuardResult {
  columns: string[];
  rows: unknown[][];
  truncated: boolean;
  /** Tables the authorizer saw read, sorted. */
  tables: string[];
  latencyMs: number;
}

/** A refused query, with the layer and a reason for whoever wrote the SQL. */
export class SqlRejected extends Error {
  constructor(readonly layer: GuardLayer, readonly reason: string) {
    super(`sql rejected in ${layer}: ${reason}`);
  }
}

export interface GuardRequest {
  path: string;
  sql: string;
  params: SQLInputValue[];
  maxRows: number;
  maxBytes: number;
  tables: string[] | null;
  deniedColumns: string[];
}
export type GuardResponse =
  | { ok: true; result: Omit<GuardResult, "latencyMs"> }
  | { ok: false; layer: GuardLayer | null; message: string };

const WORKER = new URL("./guard_worker.ts", import.meta.url);

/**
 * Runs read SQL written by someone untrusted (the assistant's model) against the db file at path, in its own
 * worker and connection: open read-only (`readOnly` + `query_only`), SQLite length/depth limits, a default-deny
 * authorizer and the row/byte caps. node:sqlite has no progress handler, so the wall timeout terminates the worker,
 * which is the only way to stop a statement mid-step. The db must be a file (a worker cannot see an in-memory one).
 */
export function guardedQuery(
  path: string,
  sql: string,
  params: SQLInputValue[] = [],
  opts: GuardOptions = {},
): Promise<GuardResult> {
  return traced("db.query", {
    kind: SpanKind.client,
    attributes: { "db.system.name": "sqlite", "db.operation.name": "SELECT", "db.query.guarded": true },
  }, async (span) => {
    if (span && traceSettings()?.recordDbText) span.setAttribute("db.query.text", normalizeSql(sql, { userSql: true }));
    const r = await runGuarded(path, sql, params, opts);
    span?.setAttribute("db.response.returned_rows", r.rows.length);
    return r;
  });
}

/** How long a guard worker may take to start before the query. */
const BOOT_MS = 60_000;

function runGuarded(path: string, sql: string, params: SQLInputValue[], opts: GuardOptions): Promise<GuardResult> {
  const req: GuardRequest = {
    path,
    sql,
    params,
    maxRows: opts.maxRows ?? 1000,
    maxBytes: opts.maxBytes ?? 256 << 10,
    tables: opts.tables ? [...opts.tables] : null,
    deniedColumns: [...(opts.deniedColumns ?? [])],
  };
  const started = performance.now();
  const worker = new Worker(WORKER, { type: "module" });
  return new Promise<GuardResult>((resolve, reject) => {
    const limit = opts.timeoutMs ?? 15_000;
    const expire = (why: string) => () => {
      worker.terminate();
      reject(new SqlRejected("limites", why));
    };
    // The worker's start-up (a cold module graph on a loaded host) is not the query's time: it has its own, wider
    // bound; the query's timeout starts once the worker says it began.
    let timer = setTimeout(expire(`o executor não subiu (${BOOT_MS} ms)`), BOOT_MS);
    const done = () => {
      clearTimeout(timer);
      worker.terminate();
    };
    worker.onmessage = (e: MessageEvent<GuardResponse | { started: true }>) => {
      if ("started" in e.data) {
        clearTimeout(timer);
        timer = setTimeout(expire(`tempo esgotado (${limit} ms)`), limit);
        return;
      }
      done();
      const r = e.data;
      if (r.ok) resolve({ ...r.result, latencyMs: Math.round(performance.now() - started) });
      else reject(r.layer ? new SqlRejected(r.layer, r.message) : new Error(r.message));
    };
    worker.onerror = (e) => {
      e.preventDefault();
      done();
      reject(new Error(e.message));
    };
    worker.postMessage(req);
  });
}
