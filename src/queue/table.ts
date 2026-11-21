import type { DatabaseSync, SQLInputValue } from "node:sqlite";
import { newId } from "../core/db.ts";
import type { JobAttempt, JobErrorCode, JobRow, JobStatus, QueueName } from "./types.ts";

/**
 * _jobs, in the data db: an enqueue inside a store transaction commits or rolls back with it. Every statement is
 * here; the callers pick the connection (the store's for an enqueue, the supervisor's own for claim/beat/ack).
 */
export function ensureJobsTable(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS _jobs (
      id TEXT PRIMARY KEY NOT NULL,
      queue TEXT NOT NULL,
      name TEXT NOT NULL,
      payload TEXT,
      result TEXT,
      status TEXT NOT NULL,
      error TEXT NOT NULL DEFAULT '',
      errorCode TEXT NOT NULL DEFAULT '',
      priority INTEGER NOT NULL DEFAULT 0,
      runAt INTEGER NOT NULL,
      expiresAt INTEGER,
      attempts INTEGER NOT NULL DEFAULT 0,
      maxAttempts INTEGER NOT NULL,
      backoffMs INTEGER NOT NULL,
      timeoutMs INTEGER NOT NULL,
      leaseMs INTEGER NOT NULL,
      leaseId TEXT,
      leaseUntil INTEGER,
      node TEXT,
      cancel INTEGER NOT NULL DEFAULT 0,
      requeues INTEGER NOT NULL DEFAULT 0,
      isolate INTEGER NOT NULL DEFAULT 0,
      history TEXT NOT NULL DEFAULT '[]',
      historyDropped INTEGER NOT NULL DEFAULT 0,
      schedule TEXT,
      dedupe TEXT,
      idem TEXT,
      sensitive INTEGER NOT NULL DEFAULT 0,
      traceparent TEXT,
      traceId TEXT,
      created INTEGER NOT NULL,
      started INTEGER,
      finished INTEGER,
      updated INTEGER NOT NULL
    );
    CREATE UNIQUE INDEX IF NOT EXISTS _jobs_dedupe ON _jobs (dedupe) WHERE dedupe IS NOT NULL AND status IN ('pending', 'running');
    CREATE UNIQUE INDEX IF NOT EXISTS _jobs_idem ON _jobs (idem) WHERE idem IS NOT NULL;
    CREATE INDEX IF NOT EXISTS _jobs_claim ON _jobs (queue, status, priority, runAt);
    CREATE INDEX IF NOT EXISTS _jobs_schedule ON _jobs (schedule, created) WHERE schedule IS NOT NULL;
    CREATE INDEX IF NOT EXISTS _jobs_finished ON _jobs (status, finished);
    CREATE TABLE IF NOT EXISTS _queue_schedules (id TEXT PRIMARY KEY NOT NULL, lastSlot INTEGER NOT NULL DEFAULT 0);
  `);
  const cols = (db.prepare(`PRAGMA table_info(_jobs)`).all() as { name: string }[]).map((c) => c.name);
  if (!cols.includes("historyDropped")) {
    db.exec(`ALTER TABLE _jobs ADD COLUMN historyDropped INTEGER NOT NULL DEFAULT 0`);
  }
  // Every append to history goes through one cap: a job given back on each deploy, or retried for days, keeps its
  // newest HISTORY_MAX attempts and counts the ones it dropped.
  db.exec(`
    CREATE TRIGGER IF NOT EXISTS _jobs_history_cap AFTER UPDATE OF history ON _jobs
    WHEN json_array_length(NEW.history) > ${HISTORY_MAX}
    BEGIN
      UPDATE _jobs SET
        history = (SELECT json_group_array(json(value)) FROM (
          SELECT value FROM json_each(NEW.history) WHERE key >= json_array_length(NEW.history) - ${HISTORY_MAX}
          ORDER BY key)),
        historyDropped = historyDropped + json_array_length(NEW.history) - ${HISTORY_MAX}
      WHERE id = NEW.id;
    END;
  `);
}

/** Attempts kept per job; older ones are dropped and counted in historyDropped. */
export const HISTORY_MAX = 50;

const BOOL = new Set(["cancel", "isolate", "sensitive"]);
const JSON_COLS = new Set(["payload", "result"]);

export function toRow(r: Record<string, unknown>): JobRow {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(r)) {
    if (BOOL.has(k)) out[k] = v === 1 || v === 1n;
    else if (JSON_COLS.has(k)) out[k] = v === null || v === undefined ? null : JSON.parse(String(v));
    else if (k === "history") out[k] = JSON.parse(String(v ?? "[]"));
    else if (typeof v === "bigint") out[k] = Number(v);
    else out[k] = v;
  }
  return out as unknown as JobRow;
}

export interface NewJob {
  queue: QueueName;
  name: string;
  payload?: unknown;
  priority?: number;
  runAt: number;
  expiresAt?: number | null;
  maxAttempts: number;
  backoffMs: number;
  timeoutMs: number;
  leaseMs: number;
  schedule?: string | null;
  dedupe?: string | null;
  idem?: string | null;
  sensitive?: boolean;
  traceparent?: string | null;
}

const json = (v: unknown) => (v === undefined ? null : JSON.stringify(v));

/**
 * Inserts a job; on a dedupe/idem conflict nothing is written and the job already there comes back (`created`
 * false), so an enqueue inside a caller's transaction never throws for it.
 */
export function insertJob(db: DatabaseSync, j: NewJob, now: number): { row: JobRow; created: boolean } {
  const id = newId();
  const r = db.prepare(
    `INSERT INTO _jobs (id, queue, name, payload, status, priority, runAt, expiresAt, maxAttempts, backoffMs,
       timeoutMs, leaseMs, schedule, dedupe, idem, sensitive, traceparent, created, updated)
     VALUES (?, ?, ?, ?, 'pending', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT DO NOTHING RETURNING *`,
  ).get(
    id,
    j.queue,
    j.name,
    json(j.payload),
    j.priority ?? 0,
    j.runAt,
    j.expiresAt ?? null,
    j.maxAttempts,
    j.backoffMs,
    j.timeoutMs,
    j.leaseMs,
    j.schedule ?? null,
    j.dedupe ?? null,
    j.idem ?? null,
    j.sensitive ? 1 : 0,
    j.traceparent ?? null,
    now,
    now,
  ) as Record<string, unknown> | undefined;
  if (r) return { row: toRow(r), created: true };
  const existing =
    (j.dedupe
      ? db.prepare(`SELECT * FROM _jobs WHERE dedupe = ? AND status IN ('pending', 'running')`).get(j.dedupe)
      : undefined) ?? (j.idem ? db.prepare(`SELECT * FROM _jobs WHERE idem = ?`).get(j.idem) : undefined);
  if (!existing) throw new Error("enqueue: conflict without a job to return");
  return { row: toRow(existing as Record<string, unknown>), created: false };
}

export function getJob(db: DatabaseSync, id: string): JobRow | null {
  const r = db.prepare(`SELECT * FROM _jobs WHERE id = ?`).get(id) as Record<string, unknown> | undefined;
  return r ? toRow(r) : null;
}

/** What a claim may take: a queue, and the names this node can run. */
export interface ClaimFilter {
  queue: QueueName;
  /** Handler names (normal/heavy) or provided services (service). */
  names: string[];
  /** normal only: quarantined jobs (true) or the others (false). */
  isolate?: boolean;
}

const attempt = (a: Omit<JobAttempt, "n"> & { n?: number }) => JSON.stringify(a);

/**
 * Makes terminal what can no longer be claimed, then takes the most urgent claimable job (or one whose lease
 * lapsed) under a fresh lease token. Runs in one BEGIN IMMEDIATE: SQLite serializes writers, so two nodes never take
 * the same job. Returns null when there is nothing to take.
 */
export function claimJob(db: DatabaseSync, f: ClaimFilter, node: string, now: number): JobRow | null {
  if (!f.names.length) return null;
  db.exec("BEGIN IMMEDIATE");
  try {
    const r = claimLocked(db, f, node, now);
    db.exec("COMMIT");
    return r;
  } catch (e) {
    db.exec("ROLLBACK");
    throw e;
  }
}

/** claimJob's body, for a caller already inside a transaction (inline runs go through tx()). */
export function claimLocked(db: DatabaseSync, f: ClaimFilter, node: string, now: number): JobRow | null {
  if (!f.names.length) return null;
  const names = JSON.stringify(f.names);
  {
    sweep(db, f.queue, now);
    const iso = f.queue === "normal" ? ` AND isolate = ${f.isolate ? 1 : 0}` : "";
    const r = db.prepare(
      `UPDATE _jobs SET status = 'running', leaseId = ?, node = ?, attempts = attempts + 1, leaseUntil = ? + leaseMs,
         started = ?, updated = ?, cancel = 0,
         -- A lapsed lease taken over: the lost try goes on the history, so the admin sees why it ran again.
         history = CASE WHEN status = 'running' THEN json_insert(history, '$[#]', json_object(
           'n', attempts, 'node', COALESCE(node, ''), 'start', COALESCE(started, 0), 'end', leaseUntil,
           'ok', json('false'), 'error', 'Its lease lapsed (the node stopped answering).', 'code', 'lease_expired'))
           ELSE history END
       WHERE id = (SELECT id FROM _jobs WHERE queue = ? AND name IN (SELECT value FROM json_each(?))${iso}
                   AND (expiresAt IS NULL OR expiresAt > ? OR status = 'running')
                   AND ((status = 'pending' AND runAt <= ?) OR (status = 'running' AND leaseUntil < ?))
                   ORDER BY priority DESC, runAt LIMIT 1)
       RETURNING *`,
    ).get(crypto.randomUUID(), node, now, now, now, f.queue, names, now, now, now) as
      | Record<string, unknown>
      | undefined;
    return r ? toRow(r) : null;
  }
}

/**
 * The terminal sweep a claim runs first: a pending job past its deadline is `expired`; a running one whose lease
 * lapsed with no try left is `lease_expired`.
 */
export function sweep(db: DatabaseSync, queue: QueueName, now: number): void {
  db.prepare(
    `UPDATE _jobs SET status = 'failed', errorCode = 'expired', error = 'Its deadline passed before it started.',
       finished = ?, updated = ?
     WHERE queue = ? AND status = 'pending' AND expiresAt IS NOT NULL AND expiresAt <= ?`,
  ).run(now, now, queue, now);
  const lapsed = " AND attempts >= maxAttempts";
  const code = "lease_expired";
  const msg = "Its lease lapsed on the last try.";
  db.prepare(
    `UPDATE _jobs SET status = 'failed', errorCode = ?, error = ?, finished = ?, updated = ?, leaseId = NULL,
       history = json_insert(history, '$[#]', json(?))
     WHERE queue = ? AND status = 'running' AND leaseUntil < ?${lapsed}`,
  ).run(code, msg, now, now, attempt({ node: "", start: 0, end: now, ok: false, error: msg, code }), queue, now);
}

export interface Owner {
  id: string;
  leaseId: string;
}

/** Renews the lease of a job this run owns; null when it lost it, else whether a cancel was asked. */
export function heartbeat(db: DatabaseSync, o: Owner, now: number): { cancel: boolean } | null {
  const r = db.prepare(
    `UPDATE _jobs SET leaseUntil = ? + leaseMs, updated = ? WHERE id = ? AND leaseId = ? AND status = 'running'
     RETURNING cancel`,
  ).get(now, now, o.id, o.leaseId) as { cancel: number } | undefined;
  return r ? { cancel: r.cancel === 1 } : null;
}

/** The fence (§16 N3): renews and checks in one step; false = this run no longer owns the job. */
export function fence(db: DatabaseSync, o: Owner, now: number): boolean {
  // A lapsed lease nobody took is still this run's: run inside its own write transaction (BEGIN IMMEDIATE), no claim
  // can take it meanwhile, so a transaction longer than the lease commits (S1). A takeover changes leaseId.
  return db.prepare(
    `UPDATE _jobs SET leaseUntil = ? + leaseMs, updated = ? WHERE id = ? AND leaseId = ? AND status = 'running'`,
  ).run(now, now, o.id, o.leaseId).changes > 0;
}

export interface Outcome {
  node: string;
  start: number;
  traceId?: string;
}

export function ack(db: DatabaseSync, o: Owner, result: unknown, out: Outcome, now: number): boolean {
  const h = attempt({ n: undefined, node: out.node, start: out.start, end: now, ok: true, traceId: out.traceId });
  return db.prepare(
    `UPDATE _jobs SET status = 'done', result = ?, error = '', errorCode = '', finished = ?, updated = ?,
       leaseUntil = NULL, isolate = 0, traceId = COALESCE(?, traceId),
       history = json_insert(history, '$[#]', json_set(json(?), '$.n', attempts))
     WHERE id = ? AND leaseId = ? AND status = 'running'`,
  ).run(json(result) ?? "null", now, now, out.traceId ?? null, h, o.id, o.leaseId).changes > 0;
}

/**
 * A failed try. With tries left (never on the service queue) the job goes back to pending after its backoff;
 * otherwise it is failed with the error. `final` fails it whatever is left (a cancel, an unknown job).
 */
export function nack(
  db: DatabaseSync,
  o: Owner,
  error: string,
  code: JobErrorCode,
  out: Outcome,
  now: number,
  opts: { final?: boolean; status?: JobStatus } = {},
): boolean {
  const row = db.prepare(`SELECT attempts, maxAttempts, backoffMs, queue FROM _jobs WHERE id = ? AND leaseId = ?`)
    .get(o.id, o.leaseId) as { attempts: number; maxAttempts: number; backoffMs: number; queue: string } | undefined;
  if (!row) return false;
  const h = attempt({ node: out.node, start: out.start, end: now, ok: false, error, code, traceId: out.traceId });
  const retry = !opts.final && row.attempts < row.maxAttempts;
  const msg = error.slice(0, 4000);
  if (retry) {
    return db.prepare(
      `UPDATE _jobs SET status = 'pending', runAt = ?, error = ?, errorCode = ?, updated = ?, leaseId = NULL,
         leaseUntil = NULL, traceId = COALESCE(?, traceId),
         history = json_insert(history, '$[#]', json_set(json(?), '$.n', attempts))
       WHERE id = ? AND leaseId = ? AND status = 'running'`,
    ).run(now + backoff(row.backoffMs, row.attempts), msg, code, now, out.traceId ?? null, h, o.id, o.leaseId)
      .changes > 0;
  }
  return db.prepare(
    `UPDATE _jobs SET status = ?, error = ?, errorCode = ?, finished = ?, updated = ?, leaseId = NULL,
       leaseUntil = NULL, traceId = COALESCE(?, traceId),
       history = json_insert(history, '$[#]', json_set(json(?), '$.n', attempts))
     WHERE id = ? AND leaseId = ? AND status = 'running'`,
  ).run(opts.status ?? "failed", msg, code, now, now, out.traceId ?? null, h, o.id, o.leaseId).changes > 0;
}

/** Exponential with ±20% jitter, at most 1 h. */
export function backoff(base: number, attempts: number): number {
  const raw = Math.min(3_600_000, base * 2 ** Math.max(0, attempts - 1));
  return Math.round(raw * (0.8 + Math.random() * 0.4));
}

/** Teto de devoluções (§16 N5): past it a give-back spends a try. */
export const MAX_REQUEUES = 3;

/**
 * Gives a job back without spending its try (its executor was killed for another job, or the node stops).
 * `isolate` quarantines it: its next try runs in a process of its own. Past MAX_REQUEUES it is a failed try.
 */
/**
 * Gives a running job back with no try spent. `clean`: its node stopped cleanly (SIGTERM, restore, shutdown): a
 * deploy is no poison, so it never counts toward MAX_REQUEUES and is recorded as `stopped`. Otherwise its executor
 * fell (killed, crashed): counted, and past the cap the try is spent (a job that keeps bringing executors down).
 */
export function requeue(
  db: DatabaseSync,
  o: Owner,
  reason: string,
  out: Outcome,
  now: number,
  isolate: boolean,
  clean = false,
) {
  const row = db.prepare(`SELECT requeues FROM _jobs WHERE id = ? AND leaseId = ? AND status = 'running'`)
    .get(o.id, o.leaseId) as { requeues: number } | undefined;
  if (!row) return false;
  if (!clean && row.requeues >= MAX_REQUEUES) {
    db.prepare(`UPDATE _jobs SET isolate = ? WHERE id = ?`).run(isolate ? 1 : 0, o.id);
    return nack(db, o, reason, "crashed", out, now);
  }
  const code = clean ? "stopped" : "crashed";
  const h = attempt({ node: out.node, start: out.start, end: now, ok: false, error: reason, code });
  return db.prepare(
    `UPDATE _jobs SET status = 'pending', attempts = attempts - 1, requeues = requeues + ?, isolate = ?, runAt = ?,
       updated = ?, leaseId = NULL, leaseUntil = NULL,
       history = json_insert(history, '$[#]', json_set(json(?), '$.n', attempts))
     WHERE id = ? AND leaseId = ? AND status = 'running'`,
  ).run(clean ? 0 : 1, isolate ? 1 : 0, now, now, h, o.id, o.leaseId).changes > 0;
}

// --- admin actions -------------------------------------------------------------------------------------------

export class Conflict extends Error {}

/** failed/canceled -> pending, from the first try again; 409 (Conflict) when its dedupe is taken by another. */
export function retryJob(db: DatabaseSync, id: string, now: number): JobRow | null {
  try {
    const r = db.prepare(
      `UPDATE _jobs SET status = 'pending', attempts = 0, requeues = 0, isolate = 0, cancel = 0, runAt = ?, error = '',
         errorCode = '', finished = NULL, leaseId = NULL, leaseUntil = NULL, updated = ?,
         expiresAt = CASE WHEN expiresAt IS NOT NULL AND expiresAt <= ? THEN NULL ELSE expiresAt END
       WHERE id = ? AND status IN ('failed', 'canceled') RETURNING *`,
    ).get(now, now, now, id) as Record<string, unknown> | undefined;
    return r ? toRow(r) : null;
  } catch (e) {
    if (/UNIQUE/i.test((e as Error).message)) {
      throw new Conflict("Another job with the same key is pending or running.");
    }
    throw e;
  }
}

/**
 * pending -> canceled (`canceled_pending`, it never started); a running job gets the cancel flag, which its
 * supervisor turns into an abort.
 */
export function cancelJob(db: DatabaseSync, id: string, now: number): JobRow | null {
  const r = db.prepare(
    `UPDATE _jobs SET status = 'canceled', errorCode = 'canceled_pending', error = 'Canceled before it started.',
       finished = ?, updated = ? WHERE id = ? AND status = 'pending' RETURNING *`,
  ).get(now, now, id) as Record<string, unknown> | undefined;
  if (r) return toRow(r);
  const run = getJob(db, id);
  if (!run || run.status !== "running") return null;
  db.prepare(`UPDATE _jobs SET cancel = 1, updated = ? WHERE id = ? AND status = 'running'`).run(now, id);
  return getJob(db, id);
}

export function removeJob(db: DatabaseSync, id: string): boolean | "running" {
  const j = getJob(db, id);
  if (!j) return false;
  if (j.status === "running") return "running";
  return db.prepare(`DELETE FROM _jobs WHERE id = ? AND status <> 'running'`).run(id).changes > 0;
}

// --- reads ---------------------------------------------------------------------------------------------------

export interface ListQuery {
  status?: JobStatus | "";
  queue?: QueueName | "";
  name?: string;
  schedule?: string;
  errorCode?: string;
  page?: number;
  perPage?: number;
}

export function listJobs(db: DatabaseSync, q: ListQuery) {
  const where: string[] = [];
  const params: SQLInputValue[] = [];
  if (q.status) (where.push("status = ?"), params.push(q.status));
  if (q.queue) (where.push("queue = ?"), params.push(q.queue));
  if (q.name) (where.push("name = ?"), params.push(q.name));
  if (q.schedule) (where.push("schedule = ?"), params.push(q.schedule));
  if (q.errorCode) (where.push("errorCode = ?"), params.push(q.errorCode));
  const w = where.length ? `WHERE ${where.join(" AND ")}` : "";
  const perPage = Math.min(200, Math.max(1, q.perPage ?? 30));
  const page = Math.max(1, q.page ?? 1);
  // Pending in claim order; the others newest first.
  const order = q.status === "pending"
    ? "priority DESC, runAt"
    : q.status === "running"
    ? "started DESC"
    : "COALESCE(finished, updated) DESC";
  const total = Number((db.prepare(`SELECT COUNT(*) AS n FROM _jobs ${w}`).get(...params) as { n: number }).n);
  const items = (db.prepare(`SELECT * FROM _jobs ${w} ORDER BY ${order} LIMIT ? OFFSET ?`)
    .all(...params, perPage, (page - 1) * perPage) as Record<string, unknown>[]).map(toRow);
  return { page, perPage, totalItems: total, totalPages: Math.ceil(total / perPage), items };
}

/** The newest jobs of a schedule, for the crons page and the home. */
export function scheduleJobs(db: DatabaseSync, schedule: string, limit: number): JobRow[] {
  return (db.prepare(`SELECT * FROM _jobs WHERE schedule = ? ORDER BY created DESC LIMIT ?`)
    .all(schedule, limit) as Record<string, unknown>[]).map(toRow);
}

/** A schedule's day: runs finished since `since` and how many of them failed. */
export function scheduleDay(db: DatabaseSync, schedule: string, since: number) {
  const r = db.prepare(
    `SELECT COUNT(*) AS n, COALESCE(SUM(status = 'failed'), 0) AS f FROM _jobs
     WHERE schedule = ? AND created >= ? AND status IN ('done', 'failed')`,
  ).get(schedule, since) as { n: number; f: number };
  return { runs: Number(r.n), failed: Number(r.f) };
}

/** The numbers of /api/queue/health, per queue. */
export function queueStats(db: DatabaseSync, now: number) {
  const out: Record<string, Record<string, number | null>> = {};
  for (const q of ["normal", "heavy"]) {
    const r = db.prepare(
      `SELECT
         COALESCE(SUM(status = 'pending'), 0) AS pending,
         COALESCE(SUM(status = 'pending' AND runAt <= ?), 0) AS due,
         COALESCE(SUM(status = 'running'), 0) AS running,
         MIN(CASE WHEN status = 'pending' AND runAt <= ? THEN runAt END) AS oldest,
         COALESCE(SUM(status = 'running' AND leaseUntil < ?), 0) AS expired,
         COALESCE(SUM(status = 'done' AND finished >= ?), 0) AS done5m,
         COALESCE(SUM(status = 'failed' AND finished >= ?), 0) AS failed5m,
         COALESCE(SUM(status = 'done' AND finished >= ?), 0) AS done1h,
         COALESCE(SUM(status = 'failed' AND finished >= ?), 0) AS failed1h
       FROM _jobs WHERE queue = ?`,
    ).get(now, now, now, now - 300_000, now - 300_000, now - 3_600_000, now - 3_600_000, q) as Record<
      string,
      unknown
    >;
    out[q] = {
      pending: Number(r.pending),
      due: Number(r.due),
      scheduled: Number(r.pending) - Number(r.due),
      running: Number(r.running),
      oldestPendingMs: r.oldest === null ? null : now - Number(r.oldest),
      expiredLeases: Number(r.expired),
      done5m: Number(r.done5m),
      failed5m: Number(r.failed5m),
      done1h: Number(r.done1h),
      failed1h: Number(r.failed1h),
    };
  }
  return out;
}

/** Jobs per status, optionally of one queue / name / schedule: the Queue page's tab counts. */
export function statusCounts(
  db: DatabaseSync,
  f: { queue?: string; name?: string; schedule?: string } = {},
): Record<string, number> {
  const rows = db.prepare(
    `SELECT status, COUNT(*) AS n FROM _jobs WHERE (? IS NULL OR queue = ?) AND (? IS NULL OR name = ?)
       AND (? IS NULL OR schedule = ?) GROUP BY status`,
  ).all(
    f.queue ?? null,
    f.queue ?? null,
    f.name ?? null,
    f.name ?? null,
    f.schedule ?? null,
    f.schedule ?? null,
  ) as { status: string; n: number }[];
  const out: Record<string, number> = { pending: 0, running: 0, done: 0, failed: 0, canceled: 0 };
  for (const r of rows) out[r.status] = Number(r.n);
  return out;
}

/** Due pending names per queue, for "no consumer" in the health. */
export function pendingNames(db: DatabaseSync): { queue: QueueName; name: string; n: number }[] {
  return (db.prepare(
    `SELECT queue, name, COUNT(*) AS n FROM _jobs WHERE status = 'pending' GROUP BY queue, name`,
  ).all() as Record<string, unknown>[]).map((r) => ({
    queue: r.queue as QueueName,
    name: String(r.name),
    n: Number(r.n),
  }));
}

export interface Retention {
  /** Done jobs of the consumer; default 7 days. */
  doneDays: number;
  /** Failed and canceled; default 30 days. */
  failedDays: number;
}

export const DEFAULT_RETENTION: Retention = { doneDays: 7, failedDays: 30 };

/**
 * Retention (§3): done system jobs (`__*`) after 24 h, done ones after doneDays, failed/canceled after failedDays.
 */
export function cleanupJobs(db: DatabaseSync, r: Retention, now: number): number {
  const day = 86_400_000;
  let n = 0;
  n += db.prepare(
    `DELETE FROM _jobs WHERE status = 'done' AND name LIKE '\\_\\_%' ESCAPE '\\' AND finished < ?`,
  ).run(now - day).changes as number;
  n += db.prepare(`DELETE FROM _jobs WHERE status = 'done' AND finished < ?`)
    .run(now - r.doneDays * day).changes as number;
  n += db.prepare(`DELETE FROM _jobs WHERE status IN ('failed', 'canceled') AND finished < ?`)
    .run(now - r.failedDays * day).changes as number;
  return n;
}

/**
 * The restore's sweep (§8), on the restored file before it is swapped in: nothing that was pending or running when the
 * zip was taken runs again (the backup itself, old sends).
 */
export function sweepRestored(db: DatabaseSync, now: number): void {
  try {
    db.prepare(
      `UPDATE _jobs SET status = 'canceled', errorCode = 'restored', error = 'Swept by a backup restore.',
         finished = ?, updated = ?, leaseId = NULL WHERE status IN ('pending', 'running')`,
    ).run(now, now);
  } catch (e) {
    // A zip from before the queue has no _jobs: nothing to sweep.
    if (!/no such table/i.test((e as Error).message)) throw e;
  }
}

/**
 * Holds a dedupe key with a row nobody claims (no node has a handler for `name`): work that runs outside the queue
 * (the restore, on the serve) excludes the jobs under the same key through the same unique index, on every path that
 * enqueues them (POST, runNow, the scheduler). Null when the key is taken. The lease lapses on its own if the holder
 * dies: the claim's sweep ends it as lease_expired.
 */
export function holdKey(db: DatabaseSync, key: string, name: string, node: string, ttlMs: number, now: number) {
  const r = db.prepare(
    `INSERT INTO _jobs (id, queue, name, payload, status, runAt, attempts, maxAttempts, backoffMs, timeoutMs, leaseMs,
       leaseId, leaseUntil, node, dedupe, started, created, updated)
     VALUES (?, 'heavy', ?, 'null', 'running', ?, 1, 1, 0, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT DO NOTHING RETURNING *`,
  ).get(newId(), name, now, ttlMs, ttlMs, crypto.randomUUID(), now + ttlMs, node, key, now, now, now) as
    | Record<string, unknown>
    | undefined;
  return r ? toRow(r) : null;
}

/** Ends a held key: done, or failed with the error. */
export function releaseKey(db: DatabaseSync, id: string, error: string | null, now: number): void {
  db.prepare(
    `UPDATE _jobs SET status = ?, error = ?, errorCode = ?, finished = ?, updated = ?, leaseId = NULL
     WHERE id = ? AND status = 'running'`,
  ).run(error ? "failed" : "done", error ?? "", error ? "handler" : "", now, now, id);
}

/**
 * Gives a job back as if it never started: its executor did not come up (a broken setup in a deploy). No try is spent
 * and no quarantine; it waits `delayMs` (the launch backoff) before it can be claimed again (R2).
 */
export function release(db: DatabaseSync, o: Owner, reason: string, out: Outcome, now: number, delayMs: number) {
  const h = attempt({ node: out.node, start: out.start, end: now, ok: false, error: reason, code: "crashed" });
  return db.prepare(
    `UPDATE _jobs SET status = 'pending', attempts = attempts - 1, runAt = ?, updated = ?, leaseId = NULL,
       leaseUntil = NULL, error = ?, history = json_insert(history, '$[#]', json_set(json(?), '$.n', attempts))
     WHERE id = ? AND leaseId = ? AND status = 'running'`,
  ).run(now + delayMs, now, reason, h, o.id, o.leaseId).changes > 0;
}

/** Claims one given pending job (a bare app's run of its own job), under a fresh lease token. */
export function claimById(db: DatabaseSync, id: string, node: string, now: number): JobRow | null {
  const r = db.prepare(
    `UPDATE _jobs SET status = 'running', leaseId = ?, node = ?, attempts = attempts + 1, leaseUntil = ? + leaseMs,
       started = ?, updated = ?, cancel = 0 WHERE id = ? AND status = 'pending' RETURNING *`,
  ).get(crypto.randomUUID(), node, now, now, now, id) as Record<string, unknown> | undefined;
  return r ? toRow(r) : null;
}
