import { DatabaseSync } from "node:sqlite";
import { AsyncLocalStorage } from "node:async_hooks";
import { traceTx } from "../telemetry/instrument/tx.ts";
import { traced } from "../telemetry/instrument/child.ts";
import { SpanKind } from "../telemetry/span.ts";
import { currentSpan } from "../telemetry/context.ts";
import { syncExternalCommits } from "./coherence.ts";

/**
 * The pragmas every connection the app opens gets, so the HTTP thread, the job worker, the backup copy and the
 * maintenance connections behave alike. PB's tuning: a 32 MB page cache and temp tables in
 * memory; a writable file connection also gets WAL and synchronous=NORMAL, which drops the fsync per commit: a power
 * loss may undo the last commits but never corrupts the file. A read-only one only gets the cache and temp settings.
 */
export function tuneConnection(db: DatabaseSync, opts: { file: boolean; readOnly?: boolean }): void {
  db.exec("PRAGMA busy_timeout = 5000; PRAGMA cache_size = -32000; PRAGMA temp_store = MEMORY;");
  if (opts.readOnly) return;
  db.exec("PRAGMA foreign_keys = ON;");
  if (opts.file) db.exec("PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL;");
}

/**
 * The serving thread's connections never checkpoint the WAL: the auto-checkpoint lands (~50 ms) inside whichever
 * request commit crosses the threshold. The job worker checkpoints instead (system jobs `__denobaseWalCheckpoint__`
 * and `__denobaseWalTruncate__`); a checkpoint covers the whole file, whichever connection runs it.
 */
export function offRequestCheckpoints(db: DatabaseSync): DatabaseSync {
  db.exec("PRAGMA wal_autocheckpoint = 0;");
  return db;
}

/** Opens SQLite with the pragmas the API relies on (FKs, WAL for file DBs, PB's tuning). */
export function openDb(path = ":memory:"): DatabaseSync {
  const db = new DatabaseSync(path);
  tuneConnection(db, { file: path !== ":memory:" });
  ensureMathFunctions(db);
  return db;
}

/** The SQLite math functions the PB filter compiles to (geoDistance), as PB's SQLite build has them. */
const MATH_FUNCTIONS: Record<string, (x: number) => number> = {
  acos: Math.acos,
  cos: Math.cos,
  sin: Math.sin,
  radians: (degrees) => degrees * Math.PI / 180,
};

/** Connections already given the functions: every store registers them, so the check must be cheap. */
const comFuncoes = new WeakSet<DatabaseSync>();

/**
 * Registers the math functions the SQLite bundled with Deno lacks (built without SQLITE_ENABLE_MATH_FUNCTIONS), so
 * filters compile to the same SQL as PB. A function the build already has is left alone. NULL in, NULL out.
 * Also registers fold(), which the text-match operators compile to.
 */
export function ensureMathFunctions(db: DatabaseSync): void {
  if (comFuncoes.has(db)) return;
  comFuncoes.add(db);
  for (const [name, fn] of Object.entries(MATH_FUNCTIONS)) {
    try {
      db.prepare(`SELECT ${name}(0)`).get();
      continue;
    } catch {
      // missing in this build
    }
    db.function(name, { deterministic: true }, (x) => (x === null ? null : fn(Number(x))));
  }
  db.function("fold", { deterministic: true }, (x) => (x === null ? null : foldText(String(x))));
}

/** Lower case without accents ("Ação" -> "acao"): what `~`/like compare, since SQLite's LIKE folds ASCII only. */
export const foldText = (s: string): string => s.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase();

/** One open tx level: callbacks queued by afterCommit run once the outermost level commits. */
interface Frame {
  db: DatabaseSync;
  afterCommit: (() => void)[];
  /** Callbacks run if this level, or any level around it, rolls back; handed to the parent on release. */
  afterRollback: (() => void)[];
  /** The outermost level of this transaction, where beforeCommit work is queued; undefined on that level. */
  root?: Frame;
  /** Root only: work keyed for dedup, run inside the transaction right before it commits. */
  beforeCommit: Map<string, () => void | Promise<void>>;
  /** Root only: per-transaction state of txState, gone with the frame on commit or rollback. */
  state?: Map<string, unknown>;
}

/** The tx frame the current async context runs inside; nested tx() calls see it here. */
const inTx = new AsyncLocalStorage<Frame>();
/** Tail of the queue of top-level txs per connection: one shared DatabaseSync can hold only one transaction. */
const queues = new WeakMap<DatabaseSync, Promise<unknown>>();

/**
 * Runs fn in a transaction; nested calls (same async context) use savepoints so hooks can call engine ops.
 * fn is async, so concurrent top-level calls are queued: otherwise a second request would open a savepoint
 * inside the first one's transaction and share its commit or rollback.
 */
export function tx<T>(db: DatabaseSync, fn: (db: DatabaseSync) => T | Promise<T>): Promise<T> {
  const parent = inTx.getStore();
  if (parent?.db === db) return traceTx(true, (began) => run(db, fn, parent, true, began));
  const prev = queues.get(db) ?? Promise.resolve();
  // A transaction opened by hand outside tx() (raw BEGIN) still nests as a savepoint.
  const out = traceTx(false, (began) => prev.then(() => run(db, fn, undefined, db.isTransaction, began)));
  queues.set(db, out.catch(() => {}));
  return out;
}

/**
 * Runs fn after the transaction around the caller commits, or now outside one; dropped if that level rolls
 * back. What must not leak uncommitted state (realtime events) goes through here.
 */
export function afterCommit(db: DatabaseSync, fn: () => void): void {
  const frame = inTx.getStore();
  if (frame?.db === db) frame.afterCommit.push(fn);
  else fn();
}

/**
 * Runs fn once the transaction level around the caller rolls back (its own savepoint or any level above it that
 * later fails, commit included); dropped once the outermost level commits. Outside a transaction it never runs.
 * Undo of side effects made outside the db (uploaded files) goes through here.
 */
export function afterRollback(db: DatabaseSync, fn: () => void): void {
  const frame = inTx.getStore();
  if (frame?.db === db) frame.afterRollback.push(fn);
}

/**
 * Queues fn to run inside the transaction around the caller, once, right before the outermost level commits; later
 * calls with the same key while it is pending are dropped. Derived data that many writes of one transaction touch
 * (a summary per parent) is recomputed once instead of once per write. Outside a transaction fn runs now. Work queued
 * by fn runs in the same flush; a rollback drops the queue.
 */
export async function beforeCommit(db: DatabaseSync, key: string, fn: () => void | Promise<void>): Promise<void> {
  const frame = inTx.getStore();
  if (frame?.db !== db) return await fn();
  const root = frame.root ?? frame;
  if (!root.beforeCommit.has(key)) root.beforeCommit.set(key, fn);
}

/**
 * State that lives exactly as long as the transaction around the caller: the same object for every call with this key
 * inside it, a fresh one after it commits or rolls back (a rollback cannot leak it into the next transaction).
 * Outside a transaction every call gets a fresh object. Pairs with beforeCommit: marks accumulate here, the queued
 * work reads them.
 */
export function txState<T>(db: DatabaseSync, key: string, init: () => T): T {
  const frame = inTx.getStore();
  if (frame?.db !== db) return init();
  const root = frame.root ?? frame;
  const state = (root.state ??= new Map());
  if (!state.has(key)) state.set(key, init());
  return state.get(key) as T;
}

/** Above this many rounds the queued work keeps queueing itself: a bug, not a big transaction. */
const BEFORE_COMMIT_ROUNDS = 100;

async function drainBeforeCommit(frame: Frame): Promise<void> {
  for (let round = 0; frame.beforeCommit.size; round++) {
    if (round >= BEFORE_COMMIT_ROUNDS) throw new Error("beforeCommit: work keeps queueing itself");
    const fns = [...frame.beforeCommit];
    frame.beforeCommit.clear();
    // A span per key: the derived rewrites run after the caller's code, so without one their time shows as the
    // request's self time.
    for (const [key, fn] of fns) {
      await traced("db.beforeCommit", { kind: SpanKind.internal, attributes: { "db.before_commit.key": key } }, fn);
    }
  }
}

async function run<T>(
  db: DatabaseSync,
  fn: (db: DatabaseSync) => T | Promise<T>,
  parent: Frame | undefined,
  nested: boolean,
  began: () => void,
): Promise<T> {
  began();
  const span = currentSpan();
  const frame: Frame = {
    db,
    afterCommit: [],
    afterRollback: [],
    root: parent ? parent.root ?? parent : undefined,
    beforeCommit: new Map(),
  };
  const sp = `sp_${crypto.randomUUID().replaceAll("-", "")}`;
  db.exec(nested ? `SAVEPOINT ${sp}` : "BEGIN IMMEDIATE");
  // A transaction is an entry point: what another thread committed before it began invalidates this thread's caches.
  if (!nested) syncExternalCommits(db);
  let out: T;
  try {
    out = await inTx.run(frame, async () => {
      const r = await fn(db);
      // The outermost level flushes its queued work while the transaction is still open.
      if (!frame.root) await drainBeforeCommit(frame);
      return r;
    });
    db.exec(nested ? `RELEASE ${sp}` : "COMMIT");
  } catch (e) {
    try {
      db.exec(nested ? `ROLLBACK TO ${sp}; RELEASE ${sp}` : "ROLLBACK");
    } finally {
      for (const f of frame.afterRollback) f();
    }
    throw e;
  }
  // Under a hand-opened BEGIN the commit is not ours to see, so callbacks run when this level releases.
  if (parent) {
    parent.afterCommit.push(...frame.afterCommit);
    parent.afterRollback.push(...frame.afterRollback);
  } else {
    if (frame.afterCommit.length) span?.addEvent("afterCommit", { callbacks: frame.afterCommit.length });
    for (const f of frame.afterCommit) f();
  }
  return out;
}

/** PB-style 15-char lowercase alnum id. */
export function newId(): string {
  const a = "abcdefghijklmnopqrstuvwxyz0123456789";
  const b = crypto.getRandomValues(new Uint8Array(15));
  return Array.from(b, (x) => a[x % a.length]).join("");
}
