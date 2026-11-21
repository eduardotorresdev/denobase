import type { DatabaseSync } from "node:sqlite";
import type { ServiceState, ServiceStatus } from "./types.ts";

/** How often a node writes its services' rows and renews its singleton leases. */
export const BEAT_MS = 5_000;
/** A node silent this long is dead: its rows are shown as dead and its leases can be taken. */
export const DEAD_MS = 15_000;
/** A call goes only to a node that beat this recently (two beats and a margin), not to one that may be dead. */
const ROUTE_MS = 2 * BEAT_MS + 1_000;

/**
 * In the aux db: frequent writes that need no atomicity with the data and must not bump its data_version.
 * `_services` is one row per service per node; `_service_leases` the singleton's holder.
 */
export function ensureServiceTables(aux: DatabaseSync): void {
  aux.exec(`
    CREATE TABLE IF NOT EXISTS _services (
      node TEXT NOT NULL, name TEXT NOT NULL, state TEXT NOT NULL, since INTEGER NOT NULL, startedAt INTEGER,
      retries INTEGER NOT NULL DEFAULT 0, lastExitAt INTEGER, lastExitReason TEXT, singleton INTEGER NOT NULL DEFAULT 1,
      detail TEXT, addr TEXT, stats TEXT, beat INTEGER NOT NULL, PRIMARY KEY (node, name));
    CREATE TABLE IF NOT EXISTS _service_leases (name TEXT PRIMARY KEY, node TEXT NOT NULL, until INTEGER NOT NULL,
      want TEXT NOT NULL DEFAULT '');
  `);
  // A table made before the stop intention: the column comes with it.
  const cols = aux.prepare(`PRAGMA table_info(_service_leases)`).all() as { name: string }[];
  if (!cols.some((c) => c.name === "want")) {
    aux.exec(`ALTER TABLE _service_leases ADD COLUMN want TEXT NOT NULL DEFAULT ''`);
  }
}

function json(v: unknown): string | null {
  if (v === undefined) return null;
  try {
    return JSON.stringify(v);
  } catch {
    return null;
  }
}

/** Writes this node's rows (all of them, one transaction) and drops the ones it no longer has. */
export function writeStates(aux: DatabaseSync, node: string, states: ServiceState[], now: number): void {
  aux.exec("BEGIN IMMEDIATE");
  try {
    const up = aux.prepare(
      `INSERT INTO _services (node, name, state, since, startedAt, retries, lastExitAt, lastExitReason, singleton,
         detail, addr, stats, beat) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (node, name) DO UPDATE SET state = excluded.state, since = excluded.since,
         startedAt = excluded.startedAt, retries = excluded.retries, lastExitAt = excluded.lastExitAt,
         lastExitReason = excluded.lastExitReason, singleton = excluded.singleton, detail = excluded.detail,
         addr = excluded.addr, stats = excluded.stats, beat = excluded.beat`,
    );
    for (const s of states) {
      up.run(
        node,
        s.name,
        s.state,
        s.since,
        s.startedAt,
        s.retries,
        s.lastExitAt,
        s.lastExitReason,
        s.singleton ? 1 : 0,
        json(s.detail),
        s.addr ?? null,
        JSON.stringify({ calls: s.calls ?? 0, errors: s.errors ?? 0, avgMs: s.avgMs ?? 0 }),
        now,
      );
    }
    aux.prepare(`DELETE FROM _services WHERE node = ? AND name NOT IN (SELECT value FROM json_each(?))`)
      .run(node, JSON.stringify(states.map((s) => s.name)));
    aux.exec("COMMIT");
  } catch (e) {
    aux.exec("ROLLBACK");
    throw e;
  }
}

export function removeStates(aux: DatabaseSync, node: string): void {
  aux.prepare(`DELETE FROM _services WHERE node = ?`).run(node);
  aux.prepare(`DELETE FROM _service_leases WHERE node = ?`).run(node);
}

/** Every node's services; dead nodes' rows are kept a day for the admin (the last crash of a node that went away). */
export function listStates(aux: DatabaseSync, now: number): ServiceState[] {
  aux.prepare(`DELETE FROM _services WHERE beat < ?`).run(now - 86_400_000);
  return (aux.prepare(`SELECT * FROM _services ORDER BY name, node`).all() as Record<string, unknown>[]).map((r) => ({
    name: String(r.name),
    node: String(r.node),
    state: r.state as ServiceStatus,
    since: Number(r.since),
    startedAt: r.startedAt === null ? null : Number(r.startedAt),
    retries: Number(r.retries),
    lastExitAt: r.lastExitAt === null ? null : Number(r.lastExitAt),
    lastExitReason: r.lastExitReason === null ? null : String(r.lastExitReason),
    singleton: r.singleton === 1,
    detail: r.detail === null ? undefined : JSON.parse(String(r.detail)),
    addr: r.addr === null ? null : String(r.addr),
    ...(r.stats ? JSON.parse(String(r.stats)) : {}),
    beat: Number(r.beat),
    alive: now - Number(r.beat) < DEAD_MS,
  }));
}

/** The socket of a live node other than `self` that runs `name` now (the freshest beat), or null. */
export function addrOf(aux: DatabaseSync, name: string, self: string | undefined, now: number): string | null {
  const r = aux.prepare(
    `SELECT addr FROM _services WHERE name = ? AND state = 'running' AND addr IS NOT NULL AND beat >= ? AND node != ?
     ORDER BY beat DESC LIMIT 1`,
  ).get(name, now - ROUTE_MS, self ?? "") as { addr: string } | undefined;
  return r?.addr ?? null;
}

/** Takes or renews the singleton lease of `name`; false while another live node holds it. */
export function acquireLease(aux: DatabaseSync, name: string, node: string, now: number): boolean {
  const r = aux.prepare(
    `INSERT INTO _service_leases (name, node, until) VALUES (?, ?, ?)
     ON CONFLICT (name) DO UPDATE SET node = excluded.node, until = excluded.until,
       want = CASE WHEN _service_leases.node = excluded.node THEN _service_leases.want ELSE '' END
       WHERE _service_leases.node = excluded.node OR _service_leases.until < ?
     RETURNING node`,
  ).get(name, node, now + DEAD_MS, now) as { node: string } | undefined;
  return r?.node === node;
}

/**
 * The cluster's intention for a singleton (§18): "stopped" while the node that stopped it holds the lease and beats it.
 * It dies with that node (the lease lapses): a manual stop does not outlive the node that made it.
 */
export function leaseOf(
  aux: DatabaseSync,
  name: string,
  now: number,
): { node: string; want: string } | null {
  const r = aux.prepare(`SELECT node, want FROM _service_leases WHERE name = ? AND until >= ?`).get(name, now) as
    | { node: string; want: string }
    | undefined;
  return r ?? null;
}

/** Whether `node` holds the lease of `name` right now (checked before every call it serves). */
export function holdsLease(aux: DatabaseSync, name: string, node: string, now: number): boolean {
  return leaseOf(aux, name, now)?.node === node;
}

export function setWant(aux: DatabaseSync, name: string, want: string): void {
  aux.prepare(`UPDATE _service_leases SET want = ? WHERE name = ?`).run(want, name);
}

export function releaseLease(aux: DatabaseSync, name: string, node: string): void {
  aux.prepare(`DELETE FROM _service_leases WHERE name = ? AND node = ?`).run(name, node);
}
