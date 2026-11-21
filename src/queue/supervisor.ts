/**
 * The supervisor (§1, §3, §16 N2/N5): claims, renews, acks and times out jobs on a connection of its own, and hands
 * them to executors (subprocesses); it never runs a handler. In a serve it is a thread (supervisor_thread.ts) and also
 * claims the service calls the main thread answers, ticks the scheduler, checkpoints the WAL and relays the outbox; in
 * the `worker` command it is the main thread. Every queue statement of a serve runs here, never on the HTTP thread.
 */
import type { DatabaseSync } from "node:sqlite";
import { hostname } from "node:os";
import { openDb } from "../core/db.ts";
import { WAL_TRUNCATE_BYTES } from "../cron/tasks/maintenance.ts";
import { argvFor, type Launch } from "./launch.ts";
import { beatNode, ensureNodeTables, eventsAfter, lastEventSeq, type OutboxEvent, removeNode } from "./nodes.ts";
import { type CatalogEntry, encode, type FromExecutor, lines, MARK, type ToExecutor } from "./protocol.ts";
import { fileId, isOrphan, readMarker, removeMarker, sameFileId } from "./restore_marker.ts";
import { enqueueDue, walDue } from "./scheduler.ts";
import { ack, claimJob, ensureJobsTable, heartbeat, insertJob, nack, type Owner, release, requeue } from "./table.ts";
import type { JobErrorCode, JobRow, QueueName, ScheduleDef } from "./types.ts";

export interface SupervisorOptions {
  kind: "serve" | "worker";
  nodeId: string;
  dbPath: string;
  auxPath: string;
  storageDir?: string;
  dataDir?: string;
  setup?: string;
  /** Slots per queue; 0 leaves the queue to other nodes. */
  concurrency: { normal: number; heavy: number };
  /** How to start executors, or why it cannot (shown in the health). */
  launch: Launch | { error: string };
  /** The serve's records and topics to publish (from the outbox). */
  events?: (events: OutboxEvent[]) => void;
  /** The data dir was swapped or is being restored by another node: the process must go (§16 N6). */
  restoring?: (why: string) => void;
  /** A scheduler tick failed: the scheduler service crashed (its manager restarts it). */
  schedulerError?: (error: string) => void;
}

/** What the main thread keeps current on the supervisor (services, schedules, timezone). */
export interface SupervisorState {
  /** The scheduler service is up on this serve: the minute tick enqueues the due schedules. */
  scheduling: boolean;
  schedules: ScheduleDef[];
  timezone: string;
  /** Job defaults for scheduled jobs: name -> queue and tries (what the serve's app knows). */
  defs: Record<
    string,
    { queue: "normal" | "heavy"; maxAttempts: number; backoffMs: number; leaseMs: number; timeoutMs: number }
  >;
}

type Slot = "normal" | "isolated" | "heavy";

interface Inflight {
  row: JobRow;
  owner: Owner;
  slot: Slot;
  start: number;
  lastBeat: number;
  proc?: Proc;
  /** Lost its lease: whatever it reports is dropped. */
  lost: boolean;
  /** Why it was aborted, and when (the kill comes KILL_GRACE_MS later). */
  aborted?: { reason: "timeout" | "canceled" | "lost" | "shutdown"; at: number };
  /** Settled (acked, nacked or given back). */
  settled: boolean;
  /** The ack/nack not written yet (the db was busy): retried, the lease still renewed, until it lands (R1). */
  pending?: () => void;
  traceId?: string;
}

const KILL_GRACE_MS = 5_000;
const IDLE_MS = 1_000;
const OUTBOX_POLL_MS = 50;
const NODE_BEAT_MS = 5_000;

/** A running executor subprocess. */
class Proc {
  readonly child: Deno.ChildProcess;
  readonly #writer: WritableStreamDefaultWriter<Uint8Array>;
  readonly ready: Promise<CatalogEntry[]>;
  readonly exited: Promise<Deno.CommandStatus>;
  killed = false;
  /** Came up (sent its catalog): a death before that is a launch failure, not a job's crash (R2). */
  up = false;

  constructor(launch: Launch, args: string[], onMessage: (m: FromExecutor) => void) {
    const child = new Deno.Command(launch.cmd, {
      args,
      env: launch.env,
      stdin: "piped",
      stdout: "piped",
      stderr: "inherit",
    }).spawn();
    this.child = child;
    this.#writer = child.stdin.getWriter();
    let ready!: (c: CatalogEntry[]) => void, fail!: (e: Error) => void;
    this.ready = new Promise((res, rej) => ((ready = res), (fail = rej)));
    this.exited = child.status;
    (async () => {
      for await (const line of lines(child.stdout)) {
        if (!line.startsWith(MARK)) {
          if (line.trim()) console.error(line);
          continue;
        }
        const m = JSON.parse(line.slice(MARK.length)) as FromExecutor;
        if (m.t === "ready") (this.up = true, ready(m.catalog));
        else if (m.t === "fatal") fail(new Error(m.error));
        else onMessage(m);
      }
    })().catch(() => {}).finally(() => fail(new Error("executor exited before it was ready")));
    this.ready.catch(() => {});
  }

  send(m: ToExecutor): void {
    this.#writer.write(new TextEncoder().encode(encode(m))).catch(() => {});
  }

  kill(): void {
    if (this.killed) return;
    this.killed = true;
    try {
      this.child.kill("SIGKILL");
    } catch { /* already gone */ }
  }

  async close(): Promise<void> {
    await this.#writer.close().catch(() => {});
  }
}

export class Supervisor {
  readonly db: DatabaseSync;
  readonly aux: DatabaseSync;
  readonly #o: SupervisorOptions;
  readonly #inflight = new Map<string, Inflight>();
  readonly #fileId: string | null;
  readonly #started = Date.now();
  #state: SupervisorState = { scheduling: false, schedules: [], timezone: "UTC", defs: {} };
  #catalog: CatalogEntry[] = [];
  #normal?: Proc;
  #stopping = false;
  /** Executors that died before ready, in a row: the relaunch waits 1 s · 2^n (at most 60 s); reset once one is up. */
  #launchFails = 0;
  /** Why the executors did not come up, while the boot retries (shown in the health). */
  #bootError?: string;
  #launchHold = 0;
  #paused = false;
  #orphanWarned = false;
  #timers: ReturnType<typeof setInterval>[] = [];
  #wakeResolve?: () => void;
  #lastVersion = -1;
  #outboxSeq = 0;
  #lastMinute = 0;
  #wal: Record<string, unknown> = {};
  #launchError: string | null;
  #loop?: Promise<void>;

  constructor(o: SupervisorOptions) {
    this.#o = o;
    this.db = openDb(o.dbPath);
    this.aux = openDb(o.auxPath);
    ensureJobsTable(this.db);
    ensureNodeTables(this.aux);
    this.#fileId = fileId(o.dbPath);
    this.#launchError = "error" in o.launch ? o.launch.error : null;
  }

  get catalog(): CatalogEntry[] {
    return this.#catalog;
  }

  update(s: Partial<SupervisorState>): void {
    this.#state = { ...this.#state, ...s };
    this.wake();
  }

  wake(): void {
    this.#wakeResolve?.();
  }

  #queues(): QueueName[] {
    const q: QueueName[] = [];
    if (this.#o.concurrency.normal > 0 && !this.#launchError) q.push("normal");
    if (this.#o.concurrency.heavy > 0 && !this.#launchError) q.push("heavy");
    return q;
  }

  async start(): Promise<void> {
    const wantsExecutors = this.#o.concurrency.normal > 0 || this.#o.concurrency.heavy > 0;
    if (wantsExecutors && !this.#launchError) await this.#boot();
    else if (this.#launchError && wantsExecutors) {
      console.error(`queue: executors unavailable: ${this.#launchError}`);
    }
    if (this.#o.kind === "serve") this.#outboxSeq = lastEventSeq(this.aux);
    this.#beatNode();
    this.#timers.push(setInterval(() => this.#beatNode(), NODE_BEAT_MS));
    this.#timers.push(setInterval(() => this.#beatJobs(), 1_000));
    if (this.#o.kind === "serve") {
      this.#timers.push(setInterval(() => this.#outboxTick(), OUTBOX_POLL_MS));
      this.#timers.push(setInterval(() => this.#minuteTick(), 1_000));
    }
    this.#loop = this.#claimLoop();
  }

  /**
   * The catalog, then the long executor. A setup that fails (a broken deploy) is retried with the launch backoff and
   * claims nothing meanwhile: no job spends a try on it (R2).
   */
  async #boot(): Promise<void> {
    try {
      this.#catalog = await this.#listCatalog();
      this.#launchFails = 0;
      this.#bootError = undefined;
      if (this.#o.concurrency.normal > 0) await this.#startNormal();
    } catch (e) {
      const delay = Math.min(60_000, 1_000 * 2 ** this.#launchFails++);
      this.#bootError = (e as Error).message;
      console.error(`queue: executors did not start (${(e as Error).message}); next try in ${delay} ms`);
      this.#launchHold = Date.now() + delay;
      if (!this.#stopping) setTimeout(() => !this.#stopping && !this.#normal && void this.#boot(), delay);
    }
  }

  async #listCatalog(): Promise<CatalogEntry[]> {
    const l = this.#o.launch as Launch;
    const p = new Proc(l, argvFor(l, this.#args("list")), () => {});
    try {
      return await p.ready;
    } finally {
      await p.close();
      await p.exited;
    }
  }

  #args(kind: "normal" | "heavy" | "list") {
    const o = this.#o;
    return { kind, db: o.dbPath, aux: o.auxPath, storage: o.storageDir, dataDir: o.dataDir, setup: o.setup };
  }

  async #startNormal(): Promise<void> {
    const l = this.#o.launch as Launch;
    const p = new Proc(l, argvFor(l, this.#args("normal")), (m) => this.#onDone(m));
    this.#normal = p;
    void p.exited.then(() => this.#normalExited(p));
    await p.ready;
  }

  /** The long executor died (or was killed for a stuck job): its jobs are given back quarantined (§16 N5). */
  #normalExited(p: Proc): void {
    if (this.#normal === p) this.#normal = undefined;
    const now = Date.now();
    const delay = this.#launchFailed(p);
    for (const f of this.#inflight.values()) {
      if (f.proc !== p || f.settled) continue;
      if (f.lost) {
        f.settled = true;
        this.#inflight.delete(f.row.id);
        continue;
      }
      const out = { node: this.#o.nodeId, start: f.start };
      this.#finalize(f, () => {
        if (f.aborted?.reason === "timeout") {
          nack(this.db, f.owner, "Timed out and was killed.", "timeout", out, now);
        } else if (f.aborted?.reason === "canceled") {
          nack(this.db, f.owner, "Canceled.", "canceled_running", out, now, { final: true, status: "canceled" });
        } else if (!p.up) {
          release(this.db, f.owner, "Its executor did not start.", out, now, delay);
        } else requeue(this.db, f.owner, "The executor it ran in stopped.", out, now, true);
      });
    }
    if (!this.#stopping && !this.#launchError) {
      setTimeout(() => {
        if (!this.#stopping && !this.#normal) this.#startNormal().catch((e) => console.error("queue:", e.message));
      }, Math.max(1_000, delay));
    }
    this.wake();
  }

  #names(q: "normal" | "heavy"): string[] {
    return this.#catalog.filter((c) => c.queue === q).map((c) => c.name);
  }

  #count(slot: Slot): number {
    let n = 0;
    for (const f of this.#inflight.values()) if (f.slot === slot) n++;
    return n;
  }

  /** Claims while slots are free; sleeps IDLE_MS or until woken. */
  async #claimLoop(): Promise<void> {
    while (!this.#stopping) {
      let took = false;
      try {
        if (!this.#paused && this.#restoreCheck()) took = this.#claimRound();
      } catch (e) {
        if (!/database is locked|SQLITE_BUSY/i.test((e as Error).message)) console.error("queue claim:", e);
      }
      if (took) continue;
      await new Promise<void>((r) => {
        const t = setTimeout(r, IDLE_MS);
        this.#wakeResolve = () => (clearTimeout(t), r());
      });
      this.#wakeResolve = undefined;
    }
  }

  #claimRound(): boolean {
    const c = this.#o.concurrency;
    const node = this.#o.nodeId;
    let took = false;
    // Executors keep failing to start: no claim until the backoff passes (the jobs stay pending, tries intact).
    if (Date.now() < this.#launchHold) return false;
    if (!this.#launchError) {
      if (c.normal > 0 && this.#normal && this.#count("normal") < c.normal) {
        const row = claimJob(
          this.db,
          { queue: "normal", names: this.#names("normal"), isolate: false },
          node,
          Date.now(),
        );
        if (row) (this.#dispatch(row, "normal"), took = true);
      }
      // One quarantine slot: a job given back after a crash runs alone, which tells the culprit (§16 N5).
      if (c.normal > 0 && this.#count("isolated") < 1) {
        const row = claimJob(
          this.db,
          { queue: "normal", names: this.#names("normal"), isolate: true },
          node,
          Date.now(),
        );
        if (row) (this.#dispatch(row, "isolated"), took = true);
      }
      if (c.heavy > 0 && this.#count("heavy") < c.heavy) {
        const row = claimJob(this.db, { queue: "heavy", names: this.#names("heavy") }, node, Date.now());
        if (row) (this.#dispatch(row, "heavy"), took = true);
      }
    }
    return took;
  }

  #dispatch(row: JobRow, slot: Slot): void {
    const now = Date.now();
    const f: Inflight = {
      row,
      owner: { id: row.id, leaseId: row.leaseId! },
      slot,
      start: now,
      lastBeat: now,
      lost: false,
      settled: false,
    };
    this.#inflight.set(row.id, f);
    if (slot === "normal") {
      f.proc = this.#normal;
      this.#normal!.send({ t: "run", job: row });
      return;
    }
    const l = this.#o.launch as Launch;
    const p = new Proc(l, argvFor(l, this.#args("heavy")), (m) => this.#onDone(m));
    f.proc = p;
    p.ready.then(() => p.send({ t: "run", job: row })).catch(() => {});
    void p.exited.then(() => {
      // A process of its own that ended without reporting: it crashed, and it was the only job in it.
      if (f.settled) return;
      if (f.lost) {
        f.settled = true;
        this.#inflight.delete(row.id);
        return;
      }
      const delay = this.#launchFailed(p);
      if (!p.up && !f.aborted) {
        return this.#finalize(f, () => {
          release(
            this.db,
            f.owner,
            "Its executor did not start.",
            { node: this.#o.nodeId, start: f.start },
            Date.now(),
            delay,
          );
        });
      }
      const code: JobErrorCode = f.aborted?.reason === "timeout" ? "timeout" : "crashed";
      const msg = code === "timeout" ? "Timed out and was killed." : "The process running it died.";
      this.#finalize(f, () => {
        if (f.aborted?.reason === "canceled") {
          nack(
            this.db,
            f.owner,
            "Canceled.",
            "canceled_running",
            { node: this.#o.nodeId, start: f.start },
            Date.now(),
            {
              final: true,
              status: "canceled",
            },
          );
        } else nack(this.db, f.owner, msg, code, { node: this.#o.nodeId, start: f.start }, Date.now());
      });
      this.wake();
    });
  }

  #onDone(m: FromExecutor): void {
    if (m.t !== "done") return;
    const f = this.#inflight.get(m.id);
    if (!f || f.settled || f.owner.leaseId !== m.leaseId) return;
    if (f.slot !== "normal") void f.proc?.close();
    if (f.lost || m.lost) {
      f.settled = true;
      this.#inflight.delete(m.id);
      return this.wake();
    }
    const out = { node: this.#o.nodeId, start: f.start, traceId: m.traceId };
    const now = Date.now();
    this.#finalize(f, () => {
      if (m.suspect && f.aborted?.reason !== "canceled") requeue(this.db, f.owner, m.suspect, out, now, true);
      else if (m.ok) ack(this.db, f.owner, m.result, out, now);
      else if (m.code === "canceled_running" || f.aborted?.reason === "canceled") {
        nack(this.db, f.owner, m.error ?? "Canceled.", "canceled_running", out, now, {
          final: true,
          status: "canceled",
        });
      } else {
        nack(
          this.db,
          f.owner,
          m.error ?? "failed",
          f.aborted?.reason === "timeout" ? "timeout" : m.code ?? "handler",
          out,
          now,
          {
            final: m.code === "unknown_job",
          },
        );
      }
    });
    this.wake();
  }

  /** Renews leases, turns a cancel flag into an abort, times jobs out and kills what ignored its abort. */
  #beatJobs(): void {
    const now = Date.now();
    for (const f of this.#inflight.values()) {
      if (f.pending) {
        // Its outcome waits for the db: the lease is kept so nobody runs it again meanwhile.
        if (now - f.lastBeat < f.row.leaseMs / 3) continue;
        try {
          if (!heartbeat(this.db, f.owner, now)) this.#inflight.delete(f.row.id);
          f.lastBeat = now;
        } catch { /* busy: the next beat */ }
        continue;
      }
      if (f.settled) continue;
      if (!f.lost && now - f.lastBeat >= f.row.leaseMs / 3) {
        try {
          const r = heartbeat(this.db, f.owner, now);
          f.lastBeat = now;
          if (!r) {
            f.lost = true;
            this.#abort(f, "lost");
          } else if (r.cancel) this.#abort(f, "canceled");
        } catch (e) {
          // BUSY is "try again" (§16 B2): two renewals of slack before the lease lapses.
          if (!/locked|BUSY/i.test((e as Error).message)) console.error("queue heartbeat:", e);
        }
      }
      if (!f.aborted && now - f.start > f.row.timeoutMs) this.#abort(f, "timeout");
      if (f.aborted && now - f.aborted.at > KILL_GRACE_MS && f.proc && !f.proc.killed) {
        // The long executor is shared: killing it gives its other jobs back, quarantined.
        f.proc.kill();
      }
    }
  }

  /** Accounts an executor's exit: the backoff to wait when it never came up, 0 when it did. */
  #launchFailed(p: Proc): number {
    if (p.up) {
      this.#launchFails = 0;
      return 0;
    }
    const delay = Math.min(60_000, 1_000 * 2 ** this.#launchFails);
    this.#launchFails++;
    this.#launchHold = Date.now() + delay;
    if (this.#launchFails === 1 || this.#launchFails % 5 === 0) {
      console.error(
        `queue: an executor died before it was ready (${this.#launchFails} in a row); next try in ${delay} ms`,
      );
    }
    return delay;
  }

  #abort(f: Inflight, reason: NonNullable<Inflight["aborted"]>["reason"]): void {
    if (f.aborted) return;
    f.aborted = { reason, at: Date.now() };
    f.proc?.send({ t: "abort", id: f.row.id, reason });
  }

  // --- the serve's part: scheduler, WAL, outbox --------------------------------------------------

  /** Every minute: the schedules due, and the WAL checkpoints (§5). */
  #minuteTick(): void {
    const now = Date.now();
    const minute = now - (now % 60_000);
    if (minute === this.#lastMinute || this.#paused || this.#stopping) return;
    this.#lastMinute = minute;
    const tz = this.#state.timezone || "UTC";
    // The WAL checkpoints belong to the node, not to the scheduler service (§5).
    if (!this.#state.scheduling) return this.#checkpoint(now);
    try {
      enqueueDue(this.db, this.#state.schedules, now, tz, (s) => {
        const d = this.#state.defs[s.job];
        return {
          queue: d?.queue ?? "normal",
          name: s.job,
          payload: s.payload ?? null,
          maxAttempts: d?.maxAttempts ?? 3,
          backoffMs: d?.backoffMs ?? 10_000,
          leaseMs: d?.leaseMs ?? 60_000,
          timeoutMs: d?.timeoutMs ?? 15 * 60_000,
        };
      }, (fn) => {
        this.db.exec("BEGIN IMMEDIATE");
        try {
          const r = fn();
          this.db.exec("COMMIT");
          return r;
        } catch (e) {
          this.db.exec("ROLLBACK");
          throw e;
        }
      });
      this.wake();
    } catch (e) {
      console.error("queue scheduler:", e);
      this.#o.schedulerError?.((e as Error).message);
    }
    this.#checkpoint(now);
  }

  #checkpoint(now: number): void {
    const due = walDue(now, "UTC");
    const paths: [DatabaseSync, string][] = [[this.db, this.#o.dbPath], [this.aux, this.#o.auxPath]];
    try {
      // PASSIVE never waits on a reader or writer; the next write restarts the WAL once every frame is in the db.
      for (const [c] of paths) c.exec("PRAGMA wal_checkpoint(PASSIVE);");
      if (due.truncate) {
        for (const [c, p] of paths) if (walSize(p) > WAL_TRUNCATE_BYTES) c.exec("PRAGMA wal_checkpoint(TRUNCATE);");
      }
      this.#wal = { at: now, dataBytes: walSize(this.#o.dbPath), auxBytes: walSize(this.#o.auxPath) };
    } catch (e) {
      this.#wal = { at: now, error: (e as Error).message };
    }
  }

  #outboxTick(): void {
    if (!this.#o.events || this.#stopping) return;
    try {
      const batch = eventsAfter(this.aux, this.#outboxSeq);
      if (!batch.length) return;
      this.#outboxSeq = batch[batch.length - 1].seq;
      this.#o.events(batch.map((b) => b.event));
    } catch { /* the aux db is busy: next tick */ }
  }

  // --- node, restore, stop --------------------------------------------------------------------------------------

  /** False (and the restoring callback) when the data dir is being or was swapped (§16 N6, §17). */
  #restoreCheck(): boolean {
    if (!sameFileId(this.#o.dbPath, this.#fileId)) {
      this.#paused = true;
      this.#o.restoring?.("the data dir was swapped");
      return false;
    }
    const m = readMarker(this.#o.dataDir);
    if (m && !isOrphan(m) && m.owner !== this.#o.nodeId) {
      this.#paused = true;
      this.#o.restoring?.(`a restore is running (${m.key})`);
      return false;
    }
    if (m && m.owner === this.#o.nodeId) return false;
    if (m) {
      // An orphan (the restore died mid-way): nothing is claimed over a data dir in an unknown state (R8). A serve
      // clears it once data.db passes quick_check; a worker waits for that, it does not exit.
      if (this.#o.kind !== "serve") return false;
      try {
        const r = this.db.prepare("PRAGMA quick_check").get() as { quick_check: string };
        if (r.quick_check !== "ok") {
          if (!this.#orphanWarned) {
            console.error(`queue: a restore (${m.key}) stopped mid-way; data.db fails quick_check`);
          }
          this.#orphanWarned = true;
          return false;
        }
      } catch {
        return false;
      }
      removeMarker(this.#o.dataDir!);
      console.error(`queue: the orphaned restore marker of ${m.key} was cleared (data.db passes quick_check)`);
    }
    return true;
  }

  #beatNode(): void {
    this.#restoreCheck();
    const queues = this.#queues();
    const handlers = [...new Set([...this.#catalog.map((c) => c.name)])];
    try {
      beatNode(this.aux, {
        id: this.#o.nodeId,
        kind: this.#o.kind,
        pid: Deno.pid,
        host: hostname(),
        queues,
        handlers,
        started: this.#started,
        beat: Date.now(),
        info: {
          concurrency: this.#o.concurrency,
          running: this.#inflight.size,
          ...(this.#launchError || this.#bootError ? { executorError: this.#launchError ?? this.#bootError } : {}),
          ...(this.#o.kind === "serve" ? { wal: this.#wal } : {}),
        },
      });
    } catch { /* busy aux: the next beat */ }
  }

  /**
   * Writes a job's outcome. A busy db never drops it (R1): it is retried every 100 ms while #beatJobs keeps the lease,
   * until it lands or the lease is lost (another node took the job: then the fenced write would change nothing).
   */
  #finalize(f: Inflight, write: () => void): void {
    f.settled = true;
    f.pending = write;
    this.#flush(f);
  }

  #flush(f: Inflight): void {
    if (!f.pending || !this.#inflight.has(f.row.id)) return;
    try {
      f.pending();
    } catch (e) {
      if (/locked|BUSY/i.test((e as Error).message)) {
        setTimeout(() => this.#flush(f), 100);
        return;
      }
      console.error("queue:", (e as Error).message);
    }
    f.pending = undefined;
    this.#inflight.delete(f.row.id);
    this.wake();
  }

  /** Runs a statement on the supervisor's connection; a busy db is logged, never thrown into a callback. */
  #safe(fn: () => void): void {
    try {
      fn();
    } catch (e) {
      console.error("queue:", (e as Error).message);
    }
  }

  /** Enqueues on the supervisor's connection (the serve main thread never writes the queue outside a request tx). */
  enqueueRaw(j: Parameters<typeof insertJob>[1]): JobRow {
    const r = insertJob(this.db, j, Date.now());
    this.wake();
    return r.row;
  }

  /**
   * Stops claiming, waits for what runs (at most graceMs), gives back what is left and stops the executors. The
   * node row goes, so the health does not count it as dead.
   */
  async stop(graceMs = 30_000): Promise<void> {
    if (this.#stopping) return;
    this.#stopping = true;
    this.wake();
    for (const t of this.#timers) clearInterval(t);
    const until = Date.now() + graceMs;
    // Outcomes still waiting for a busy db count as running: their write must land before the connection goes.
    while ([...this.#inflight.values()].some((f) => !f.settled || f.pending) && Date.now() < until) {
      this.#beatJobs();
      await new Promise((r) => setTimeout(r, 100));
    }
    const now = Date.now();
    for (const f of this.#inflight.values()) {
      if (f.settled || f.lost) continue;
      f.settled = true;
      this.#safe(() =>
        requeue(this.db, f.owner, "The node stopped.", { node: this.#o.nodeId, start: f.start }, now, false, true)
      );
      f.proc?.kill();
    }
    this.#inflight.clear();
    if (this.#normal) {
      await this.#normal.close();
      const p = this.#normal;
      await Promise.race([p.exited, new Promise((r) => setTimeout(r, 2_000))]);
      p.kill();
    }
    await this.#loop;
    this.#safe(() => removeNode(this.aux, this.#o.nodeId));
    this.db.close();
    this.aux.close();
  }
}

function walSize(path: string): number {
  try {
    return Deno.statSync(`${path}-wal`).size;
  } catch {
    return 0;
  }
}
