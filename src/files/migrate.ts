/**
 * Moving record files from the storage the app used before (local or an older S3) to the one settings.s3 names now.
 * There is no read fallback between storages, so until a file is copied it answers 404: the job exists to close that
 * gap. It runs off the request path (the job worker, or the CLI's own process), keeps its state in the auxiliary db so
 * any thread or a restarted process can follow and resume it, and is idempotent: a key already at the destination
 * with the same size is skipped, anything else is overwritten.
 */
import type { DatabaseSync } from "node:sqlite";
import { stableError } from "../core/errors.ts";
import { nowStamp } from "../core/time.ts";
import type { S3Config } from "../settings/model.ts";
import { S3Storage } from "./s3/storage.ts";
import type { BlobStore } from "./storage.ts";
import { CurrentStorage } from "./current.ts";

/** Where files come from: the app's local storage, or an S3 bucket with its credentials. */
export type MigrationSource = { kind: "local" } | { kind: "s3"; s3: S3Config };

export type MigrationStatus = "proposed" | "running" | "done" | "failed" | "canceled";

export interface MigrationFailure {
  key: string;
  error: string;
}

/** What the API, the UI and the realtime topic see: never the source credentials. */
export interface MigrationState {
  id: string;
  status: MigrationStatus;
  /** "local", or "s3:<bucket>@<endpoint or region>". */
  from: string;
  to: string;
  deleteSource: boolean;
  total: number;
  processed: number;
  copied: number;
  skipped: number;
  failed: number;
  bytes: number;
  /** The last key handled; a resume continues after it. */
  cursor: string;
  failures: MigrationFailure[];
  error: string;
  /** Running, but no process has renewed the lease in time (it died): resume picks it up. */
  stalled: boolean;
  created: string;
  updated: string;
  finished: string;
}

/** Realtime topic with every progress update, superusers only. */
export const FILES_MIGRATION_TOPIC = "_denobase/files-migration";

/** How long a run owns a job without renewing; a crashed process frees it after this. */
const LEASE_MS = 30_000;
/** Kept in the row; the counter still says how many failed. */
const MAX_FAILURES = 200;
/** Progress is persisted after every key but published at most this often. */
const PUBLISH_MS = 500;

/** Record files only ("<collectionId>/<recordId>/..."), not a settings probe or anything else sharing the bucket. */
export function isRecordFileKey(key: string): boolean {
  return /^[^/]+\/[^/]+\/./.test(key) && !key.startsWith("pb_settings_test/") && !key.endsWith(".attrs");
}

export function sourceLabel(src: MigrationSource): string {
  return src.kind === "local" ? "local" : s3Label(src.s3);
}

/** The storage label settings.s3 names: what a migration's destination must still be when it runs. */
export function storageLabel(s3: S3Config): string {
  return s3.enabled ? s3Label(s3) : "local";
}

/**
 * The endpoint resolved as the S3 client resolves it (empty -> AWS's regional one, no scheme -> https), so one bucket
 * spelled two ways is one label. Not the whole guard: run() also probes for the same storage before deleting.
 */
function s3Label(c: S3Config): string {
  const raw = c.endpoint.trim() || `https://s3.${c.region || "us-east-1"}.amazonaws.com`;
  let ep = raw;
  try {
    const u = new URL(/^https?:\/\//i.test(raw) ? raw : `https://${raw}`);
    ep = `${u.protocol}//${u.host}${u.pathname.replace(/\/+$/, "")}`;
  } catch { /* an unparsable endpoint keeps its spelling */ }
  return `s3:${c.bucket}@${ep}`;
}

/** Outside the record-file key shape ("<col>/<id>/<file>"), so listings and migrations never pick it up. */
const PROBE_PREFIX = "_denobase_migration_probe/";

/**
 * True when src and dst are one storage under two configs (labels can still differ: a CNAME, path vs virtual host).
 * A marker written to dst and seen at src proves it; deleting the source then would delete the destination's files.
 */
async function sameStorage(src: BlobStore, dst: BlobStore): Promise<boolean> {
  const key = PROBE_PREFIX + crypto.randomUUID();
  await dst.put(key, new Uint8Array([1]), { type: "application/octet-stream" });
  try {
    return (await src.stat(key)) !== null;
  } finally {
    await dst.delete(key).catch(() => {});
  }
}

// --- secrets ---------------------------------------------------------------------------------------------------

const KEY_PARAM = "files_migration_key";

/**
 * The AES key the "from" credentials are sealed with. DENOBASE_ENCRYPTION_KEY wins (like PB_ENCRYPTION); else a random
 * key kept in the data db, so a leaked auxiliary db alone does not reveal the old bucket's secret.
 */
async function sealKey(data: DatabaseSync): Promise<CryptoKey> {
  const env = Deno.env.get("DENOBASE_ENCRYPTION_KEY");
  let raw: Uint8Array<ArrayBuffer>;
  if (env) raw = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(env)));
  else {
    data.exec(`CREATE TABLE IF NOT EXISTS _params (id TEXT PRIMARY KEY NOT NULL, value JSON DEFAULT NULL,
      created TEXT DEFAULT '' NOT NULL, updated TEXT DEFAULT '' NOT NULL)`);
    const now = nowStamp();
    const fresh = btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32))));
    // INSERT OR IGNORE: two threads racing on the first seal agree on whichever key landed.
    data.prepare(`INSERT OR IGNORE INTO _params (id, value, created, updated) VALUES (?, ?, ?, ?)`)
      .run(KEY_PARAM, JSON.stringify(fresh), now, now);
    const row = data.prepare(`SELECT value FROM _params WHERE id = ?`).get(KEY_PARAM) as { value: string };
    raw = Uint8Array.from(atob(JSON.parse(row.value)), (c) => c.charCodeAt(0));
  }
  return await crypto.subtle.importKey("raw", raw, "AES-GCM", false, ["encrypt", "decrypt"]);
}

export async function sealSource(data: DatabaseSync, src: MigrationSource): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(
    await crypto.subtle.encrypt(
      { name: "AES-GCM", iv },
      await sealKey(data),
      new TextEncoder().encode(JSON.stringify(src)),
    ),
  );
  const all = new Uint8Array(iv.length + ct.length);
  all.set(iv);
  all.set(ct, iv.length);
  return `v1:${btoa(String.fromCharCode(...all))}`;
}

export async function openSource(data: DatabaseSync, sealed: string): Promise<MigrationSource> {
  if (!sealed.startsWith("v1:")) throw new Error("unknown sealed source format");
  const all = Uint8Array.from(atob(sealed.slice(3)), (c) => c.charCodeAt(0));
  const plain = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: all.slice(0, 12) },
    await sealKey(data),
    all.slice(12),
  );
  return JSON.parse(new TextDecoder().decode(plain));
}

// --- state -----------------------------------------------------------------------------------------------------

export function ensureMigrationTable(aux: DatabaseSync): void {
  aux.exec(`CREATE TABLE IF NOT EXISTS _files_migrations (
    id TEXT PRIMARY KEY NOT NULL,
    status TEXT NOT NULL,
    source TEXT NOT NULL,
    sourceLabel TEXT NOT NULL,
    target TEXT NOT NULL,
    deleteSource INTEGER NOT NULL DEFAULT 0,
    cursor TEXT NOT NULL DEFAULT '',
    total INTEGER NOT NULL DEFAULT 0,
    processed INTEGER NOT NULL DEFAULT 0,
    copied INTEGER NOT NULL DEFAULT 0,
    skipped INTEGER NOT NULL DEFAULT 0,
    failed INTEGER NOT NULL DEFAULT 0,
    bytes INTEGER NOT NULL DEFAULT 0,
    failures TEXT NOT NULL DEFAULT '[]',
    error TEXT NOT NULL DEFAULT '',
    owner TEXT NOT NULL DEFAULT '',
    leaseUntil INTEGER NOT NULL DEFAULT 0,
    created TEXT NOT NULL,
    updated TEXT NOT NULL,
    finished TEXT NOT NULL DEFAULT ''
  )`);
  // The lock: SQLite itself refuses a second running job, whichever thread or process tries.
  aux.exec(
    `CREATE UNIQUE INDEX IF NOT EXISTS _files_migrations_one_running ON _files_migrations (status)
     WHERE status = 'running'`,
  );
}

interface Row {
  id: string;
  status: MigrationStatus;
  source: string;
  sourceLabel: string;
  target: string;
  deleteSource: number;
  cursor: string;
  total: number;
  processed: number;
  copied: number;
  skipped: number;
  failed: number;
  bytes: number;
  failures: string;
  error: string;
  owner: string;
  leaseUntil: number;
  created: string;
  updated: string;
  finished: string;
}

function toState(r: Row): MigrationState {
  return {
    id: r.id,
    status: r.status,
    from: r.sourceLabel,
    to: r.target,
    deleteSource: !!r.deleteSource,
    total: r.total,
    processed: r.processed,
    copied: r.copied,
    skipped: r.skipped,
    failed: r.failed,
    bytes: r.bytes,
    cursor: r.cursor,
    failures: JSON.parse(r.failures),
    error: r.error,
    stalled: r.status === "running" && r.leaseUntil < Date.now(),
    created: r.created,
    updated: r.updated,
    finished: r.finished,
  };
}

function row(aux: DatabaseSync, id: string): Row | undefined {
  return aux.prepare(`SELECT * FROM _files_migrations WHERE id = ?`).get(id) as Row | undefined;
}

function latest(aux: DatabaseSync, where = "1"): Row | undefined {
  return aux.prepare(`SELECT * FROM _files_migrations WHERE ${where} ORDER BY created DESC, rowid DESC LIMIT 1`)
    .get() as Row | undefined;
}

function newId(): string {
  return crypto.randomUUID().replaceAll("-", "").slice(0, 15);
}

const active = (msg = "A files migration is already running.") => stableError(409, "files_migration_active", msg);

// --- the run ---------------------------------------------------------------------------------------------------

export interface RunDeps {
  aux: DatabaseSync;
  /** The data db: holds the key the source credentials are sealed with. */
  data: DatabaseSync;
  /** The app's files storage: its target is the destination, its local the "local" source. */
  storage: CurrentStorage;
  /** settings.s3 as this thread sees it now; a getter is read again before every key, so a change stops the run. */
  s3: S3Config | (() => S3Config);
  /** Called with every (throttled) progress update and the final state. */
  progress?: (s: MigrationState) => unknown;
  /** Who runs it; a lease held by another owner and not expired makes this run return without work. */
  owner?: string;
}

/** The source as a BlobStore. */
export function sourceStorage(src: MigrationSource, storage: CurrentStorage): BlobStore {
  return src.kind === "local" ? storage.local : new S3Storage(src.s3);
}

/** Every record-file key of a store, sorted: a total order is what lets the cursor say "everything up to here". */
async function listKeys(store: BlobStore): Promise<{ key: string; size: number }[]> {
  const out: { key: string; size: number }[] = [];
  for await (const b of store.list("")) if (isRecordFileKey(b.key)) out.push({ key: b.key, size: b.size });
  // Only keys are held, never bodies; byte order so it matches S3's listing whatever the locale.
  return out.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
}

/**
 * Runs (or continues) job `id` to its end. Returns false when another live owner holds it. Cancellation is a status
 * change any thread can make; the run sees it between keys.
 */
export async function runMigration(id: string, deps: RunDeps): Promise<boolean> {
  const { aux } = deps;
  ensureMigrationTable(aux);
  const owner = deps.owner ?? crypto.randomUUID();
  const claim = () =>
    aux.prepare(
      `UPDATE _files_migrations SET owner = ?, leaseUntil = ? WHERE id = ? AND status = 'running'
       AND (owner = ? OR leaseUntil < ?)`,
    ).run(owner, Date.now() + LEASE_MS, id, owner, Date.now()).changes > 0;
  if (!claim()) return false;
  const currentS3 = () => (typeof deps.s3 === "function" ? deps.s3() : deps.s3);
  // Renewed on a timer, not only per key: a long listing, one big put or the delete phase outlive LEASE_MS, and a
  // lapsed lease lets a second run take the job over while this one still works.
  const renew = aux.prepare(
    `UPDATE _files_migrations SET leaseUntil = ? WHERE id = ? AND owner = ? AND status = 'running'`,
  );
  let lost = false;
  const heartbeat = setInterval(() => {
    try {
      if (renew.run(Date.now() + LEASE_MS, id, owner).changes === 0) lost = true;
    } catch { /* a busy db: the next beat or key renews it */ }
  }, LEASE_MS / 3);

  let r = row(aux, id)!;
  let lastPublish = 0;
  const publish = async (force = false) => {
    if (!deps.progress || (!force && Date.now() - lastPublish < PUBLISH_MS)) return;
    lastPublish = Date.now();
    try {
      await deps.progress(toState(row(aux, id)!));
    } catch {
      // Progress is a courtesy to the UI; the job's state is in the db either way.
    }
  };
  const finish = async (status: MigrationStatus, error = "") => {
    aux.prepare(
      `UPDATE _files_migrations SET status = ?, error = ?, finished = ?, updated = ?, leaseUntil = 0
       WHERE id = ? AND status = 'running' AND owner = ?`,
    ).run(status, error, nowStamp(), nowStamp(), id, owner);
    await publish(true);
  };

  const targetChanged = async () => {
    const target = storageLabel(currentS3());
    if (target === r.target) return false;
    await finish("failed", `The files storage changed to ${target} since this migration was started for ${r.target}.`);
    return true;
  };
  const statusOf = aux.prepare(`SELECT status, owner FROM _files_migrations WHERE id = ?`);
  /** Canceled, or taken over by another run: stop without touching the row. */
  const stillMine = () => {
    const now = statusOf.get(id) as { status: string; owner: string };
    return !lost && now.status === "running" && now.owner === owner;
  };

  try {
    if (await targetChanged()) return true;
    const src = sourceStorage(await openSource(deps.data, r.source), deps.storage);
    const dst = deps.storage.target;
    const keys = await listKeys(src);
    aux.prepare(`UPDATE _files_migrations SET total = ?, updated = ? WHERE id = ?`).run(keys.length, nowStamp(), id);
    await publish(true);

    const failures: MigrationFailure[] = JSON.parse(r.failures);
    const save = aux.prepare(
      `UPDATE _files_migrations SET cursor = ?, processed = processed + 1, copied = copied + ?, skipped = skipped + ?,
       failed = failed + ?, bytes = bytes + ?, failures = ?, updated = ?, leaseUntil = ? WHERE id = ? AND owner = ?`,
    );
    for (const { key, size } of keys) {
      if (r.cursor && key <= r.cursor) continue;
      if (!stillMine()) return true;
      // The app reads from whatever settings.s3 names now: copying on into the old target would strand the files.
      if (await targetChanged()) return true;
      let copied = 0, skipped = 0, failed = 0, bytes = 0;
      try {
        const there = await dst.stat(key);
        if (there && there.size === size) skipped = 1;
        else {
          const obj = await src.get(key);
          // Gone since the listing (a record deleted meanwhile): nothing left to move.
          if (!obj) skipped = 1;
          else {
            await dst.put(key, obj.body, { type: obj.type });
            copied = 1;
            bytes = obj.size;
          }
        }
      } catch (e) {
        failed = 1;
        if (failures.length < MAX_FAILURES) failures.push({ key, error: (e as Error).message });
      }
      save.run(
        key,
        copied,
        skipped,
        failed,
        bytes,
        JSON.stringify(failures),
        nowStamp(),
        Date.now() + LEASE_MS,
        id,
        owner,
      );
      await publish();
    }

    if (!stillMine()) return true;
    r = row(aux, id)!;
    if (r.failed > 0) {
      await finish("failed", `${r.failed} file(s) could not be copied; the source was left as it was.`);
      return true;
    }
    // Only now, with every file at the destination: deleting earlier would lose what a failure left behind.
    if (r.deleteSource) {
      if (await targetChanged()) return true;
      if (await sameStorage(src, dst)) {
        await finish("failed", "The source and the destination are the same storage; nothing was deleted.");
        return true;
      }
      for (const { key } of keys) {
        if (!stillMine() || await targetChanged()) return true;
        await src.delete(key);
      }
    }
    await finish("done");
  } catch (e) {
    await finish("failed", (e as Error).message);
  } finally {
    clearInterval(heartbeat);
  }
  return true;
}

/** What a dry run reports: nothing is written, not even the job row. */
export interface MigrationPlan {
  total: number;
  /** Missing at the destination, or there with another size. */
  toCopy: number;
  same: number;
  bytes: number;
}

export async function planMigration(src: BlobStore, dst: BlobStore): Promise<MigrationPlan> {
  const plan: MigrationPlan = { total: 0, toCopy: 0, same: 0, bytes: 0 };
  for (const { key, size } of await listKeys(src)) {
    plan.total++;
    const there = await dst.stat(key);
    if (there && there.size === size) plan.same++;
    else {
      plan.toCopy++;
      plan.bytes += size;
    }
  }
  return plan;
}

// --- the manager -----------------------------------------------------------------------------------------------

export interface FilesMigrationsDeps {
  aux: DatabaseSync;
  data: DatabaseSync;
  storage: CurrentStorage;
  s3: () => S3Config;
  /** Starts the run somewhere (the job worker in the app); rejects only on a crash the run could not record. */
  launch: (id: string) => Promise<unknown>;
}

/**
 * app.filesMigration: the state and the controls (start, resume, cancel). Changing settings.s3 records the storage the
 * app used until then as a "proposed" migration, so the UI can offer to move the files.
 */
export class FilesMigrations {
  constructor(readonly deps: FilesMigrationsDeps) {
    ensureMigrationTable(deps.aux);
  }

  /** The most recent job (or proposal); null when there was never one. */
  status(): MigrationState | null {
    const r = latest(this.deps.aux);
    return r ? toState(r) : null;
  }

  /** The running job, stalled or not. */
  active(): MigrationState | null {
    const r = latest(this.deps.aux, `status = 'running'`);
    return r ? toState(r) : null;
  }

  get(id: string): MigrationState | null {
    const r = row(this.deps.aux, id);
    return r ? toState(r) : null;
  }

  /** settings.s3 went from prev to next: keep prev (sealed) as the proposal, replacing an older one. */
  async proposeFrom(prev: S3Config, next: S3Config): Promise<void> {
    // A save that keeps the storage (key rotation, an unrelated field) moves no file.
    if (storageLabel(prev) === storageLabel(next)) return;
    const src: MigrationSource = prev.enabled ? { kind: "s3", s3: structuredClone(prev) } : { kind: "local" };
    const sealed = await sealSource(this.deps.data, src);
    const { aux } = this.deps;
    aux.prepare(`DELETE FROM _files_migrations WHERE status = 'proposed'`).run();
    const now = nowStamp();
    aux.prepare(
      `INSERT INTO _files_migrations (id, status, source, sourceLabel, target, created, updated)
       VALUES (?, 'proposed', ?, ?, ?, ?, ?)`,
    ).run(newId(), sealed, sourceLabel(src), storageLabel(next), now, now);
  }

  /**
   * What starting the latest proposal would move (a dry run, nothing written): the UI's "Migrate N files (X MB)".
   * Null when nothing is proposed.
   */
  async plan(): Promise<(MigrationPlan & { id: string; from: string; to: string }) | null> {
    const proposal = latest(this.deps.aux, `status = 'proposed'`);
    if (!proposal) return null;
    const src = await openSource(this.deps.data, proposal.source);
    const plan = await planMigration(sourceStorage(src, this.deps.storage), this.deps.storage.target);
    return { ...plan, id: proposal.id, from: proposal.sourceLabel, to: proposal.target };
  }

  /**
   * Creates the running job (from `from`, else from the latest proposal) without launching it: the CLI runs it in its
   * own process, start() hands it to the job worker.
   */
  async create(opts: { from?: MigrationSource; deleteSource?: boolean } = {}): Promise<MigrationState> {
    const { aux } = this.deps;
    if (this.active()) throw active();
    const target = storageLabel(this.deps.s3());
    let proposal: Row | undefined;
    let sealed: string, label: string;
    if (opts.from) {
      sealed = await sealSource(this.deps.data, opts.from);
      label = sourceLabel(opts.from);
    } else {
      proposal = latest(aux, `status = 'proposed'`);
      if (!proposal) {
        throw stableError(400, "files_migration_no_source", "There is no previous storage to migrate files from.");
      }
      sealed = proposal.source;
      label = proposal.sourceLabel;
    }
    if (label === target) {
      throw stableError(400, "files_migration_same_storage", "The source is the storage the app already uses.");
    }
    const now = nowStamp();
    const id = proposal?.id ?? newId();
    try {
      if (proposal) {
        aux.prepare(
          `UPDATE _files_migrations SET status = 'running', target = ?, deleteSource = ?, created = ?, updated = ?
           WHERE id = ?`,
        ).run(target, opts.deleteSource ? 1 : 0, now, now, id);
      } else {
        aux.prepare(
          `INSERT INTO _files_migrations (id, status, source, sourceLabel, target, deleteSource, created, updated)
           VALUES (?, 'running', ?, ?, ?, ?, ?, ?)`,
        ).run(id, sealed, label, target, opts.deleteSource ? 1 : 0, now, now);
      }
    } catch (e) {
      // The unique index lost a race with another thread starting one.
      if (/UNIQUE/i.test((e as Error).message)) throw active();
      throw e;
    }
    return this.get(id)!;
  }

  /** create() and hand the job to the runner. */
  async start(opts: { from?: MigrationSource; deleteSource?: boolean } = {}): Promise<MigrationState> {
    const s = await this.create(opts);
    this.#launch(s.id);
    return s;
  }

  /**
   * Continues the latest job: a stalled run is taken over from its cursor; a failed or canceled one runs again (a
   * failed one from the start, so its failures are retried; what is already there is skipped by size).
   */
  resume(): MigrationState {
    const { aux } = this.deps;
    const r = latest(aux, `status IN ('running', 'failed', 'canceled')`);
    if (!r) throw stableError(404, "files_migration_not_found", "There is no files migration to resume.");
    if (r.status === "running") {
      if (r.leaseUntil >= Date.now()) throw active();
    } else {
      if (this.active()) throw active();
      const target = storageLabel(this.deps.s3());
      if (target !== r.target) {
        throw stableError(
          400,
          "files_migration_target_changed",
          `The files storage is ${target} now, not ${r.target}: start a new migration.`,
        );
      }
      const reset = r.status === "failed"
        ? `, cursor = '', total = 0, processed = 0, copied = 0, skipped = 0, failed = 0, bytes = 0, failures = '[]'`
        : "";
      try {
        aux.prepare(
          `UPDATE _files_migrations SET status = 'running', error = '', finished = '', updated = ?${reset} WHERE id = ?`,
        ).run(nowStamp(), r.id);
      } catch (e) {
        if (/UNIQUE/i.test((e as Error).message)) throw active();
        throw e;
      }
    }
    this.#launch(r.id);
    return this.get(r.id)!;
  }

  cancel(): MigrationState {
    const r = latest(this.deps.aux, `status = 'running'`);
    if (!r) throw stableError(404, "files_migration_not_found", "There is no running files migration.");
    this.deps.aux.prepare(
      `UPDATE _files_migrations SET status = 'canceled', finished = ?, updated = ?, leaseUntil = 0 WHERE id = ?`,
    ).run(nowStamp(), nowStamp(), r.id);
    return this.get(r.id)!;
  }

  /** The run in flight from this process, for tests and shutdown. */
  running: Promise<unknown> = Promise.resolve();

  #launch(id: string): void {
    this.running = this.deps.launch(id).catch((e) => {
      // A crashed worker leaves the row running with a lease that expires: resume takes it over then.
      console.error(`files migration ${id}:`, (e as Error).message);
    });
  }
}
