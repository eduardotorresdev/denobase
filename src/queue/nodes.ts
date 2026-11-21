import type { DatabaseSync } from "node:sqlite";
import type { NodeInfo, QueueName } from "./types.ts";

/**
 * _queue_nodes and _events live in the auxiliary db: frequent best-effort writes that need no atomicity with the
 * data, and that would otherwise bump the data db's data_version (the caches' invalidation signal) every few seconds.
 */
export function ensureNodeTables(aux: DatabaseSync): void {
  aux.exec(`
    CREATE TABLE IF NOT EXISTS _queue_nodes (
      id TEXT PRIMARY KEY NOT NULL,
      kind TEXT NOT NULL,
      pid INTEGER NOT NULL,
      host TEXT NOT NULL,
      queues TEXT NOT NULL DEFAULT '[]',
      handlers TEXT NOT NULL DEFAULT '[]',
      services TEXT NOT NULL DEFAULT '[]',
      info TEXT NOT NULL DEFAULT '{}',
      started INTEGER NOT NULL,
      beat INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS _events (
      seq INTEGER PRIMARY KEY AUTOINCREMENT,
      kind TEXT NOT NULL,
      payload TEXT NOT NULL,
      created INTEGER NOT NULL
    );
  `);
}

/** A node beats every BEAT_MS; one silent for DEAD_MS is dead. */
export const BEAT_MS = 5_000;
export const DEAD_MS = 30_000;

export function beatNode(aux: DatabaseSync, n: NodeInfo): void {
  aux.prepare(
    `INSERT INTO _queue_nodes (id, kind, pid, host, queues, handlers, info, started, beat)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (id) DO UPDATE SET queues = excluded.queues, handlers = excluded.handlers,
       info = excluded.info, beat = excluded.beat`,
  ).run(
    n.id,
    n.kind,
    n.pid,
    n.host,
    JSON.stringify(n.queues),
    JSON.stringify(n.handlers),
    JSON.stringify(n.info),
    n.started,
    n.beat,
  );
}

export function removeNode(aux: DatabaseSync, id: string): void {
  aux.prepare(`DELETE FROM _queue_nodes WHERE id = ?`).run(id);
}

export function listNodes(aux: DatabaseSync, now: number): (NodeInfo & { alive: boolean })[] {
  try {
    return (aux.prepare(`SELECT * FROM _queue_nodes ORDER BY kind, started`).all() as Record<string, unknown>[]).map(
      (r) => ({
        id: String(r.id),
        kind: r.kind as NodeInfo["kind"],
        pid: Number(r.pid),
        host: String(r.host),
        queues: JSON.parse(String(r.queues)) as QueueName[],
        handlers: JSON.parse(String(r.handlers)) as string[],
        info: JSON.parse(String(r.info)) as Record<string, unknown>,
        started: Number(r.started),
        beat: Number(r.beat),
        alive: now - Number(r.beat) < DEAD_MS,
      }),
    );
  } catch (e) {
    if (/no such table/i.test((e as Error).message)) return [];
    throw e;
  }
}

/** Whether a live node other than `self` runs `service` (the singleton check, and service_unavailable). */

/** Whether a live node consumes `queue` and knows `name` (for `run` failing fast with queue_unavailable). */
export function liveConsumer(aux: DatabaseSync, queue: QueueName, name: string, now: number): boolean {
  return listNodes(aux, now).some((n) => n.alive && n.queues.includes(queue) && n.handlers.includes(name));
}

export function cleanupNodes(aux: DatabaseSync, now: number): void {
  aux.prepare(`DELETE FROM _queue_nodes WHERE beat < ?`).run(now - 86_400_000);
  aux.prepare(`DELETE FROM _events WHERE created < ?`).run(now - 3_600_000);
}

// --- the outbox (§7): best effort, record events and topics of processes that are not a serve -----------------

export type OutboxEvent =
  | { kind: "record"; slug: string; id: string; action: "create" | "update" | "delete"; row?: Record<string, unknown> }
  | { kind: "topic"; topic: string; data: unknown; access: string };

export function appendEvent(aux: DatabaseSync, e: OutboxEvent, now: number): void {
  const { kind, ...rest } = e;
  aux.prepare(`INSERT INTO _events (kind, payload, created) VALUES (?, ?, ?)`).run(kind, JSON.stringify(rest), now);
}

export function lastEventSeq(aux: DatabaseSync): number {
  const r = aux.prepare(`SELECT MAX(seq) AS s FROM _events`).get() as { s: number | null };
  return Number(r.s ?? 0);
}

export function eventsAfter(aux: DatabaseSync, seq: number, limit = 500): { seq: number; event: OutboxEvent }[] {
  return (aux.prepare(`SELECT seq, kind, payload FROM _events WHERE seq > ? ORDER BY seq LIMIT ?`).all(seq, limit) as {
    seq: number;
    kind: string;
    payload: string;
  }[]).map((r) => ({ seq: Number(r.seq), event: { kind: r.kind, ...JSON.parse(r.payload) } as OutboxEvent }));
}
