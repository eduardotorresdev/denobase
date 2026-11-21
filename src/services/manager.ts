import type { DatabaseSync } from "node:sqlite";
import { ApiError } from "../core/errors.ts";
import { inAnyTransaction } from "../core/db.ts";
import type { App } from "../app.ts";
import {
  acquireLease,
  addrOf,
  BEAT_MS,
  ensureServiceTables,
  holdsLease,
  leaseOf,
  listStates,
  releaseLease,
  removeStates,
  setWant,
  writeStates,
} from "./table.ts";
import type {
  CallOptions,
  Methods,
  ProvideOptions,
  RestartPolicy,
  ServiceImpl,
  ServiceOptions,
  ServiceState,
  ServiceStatus,
} from "./types.ts";
import { AsyncLocalStorage } from "node:async_hooks";
import { currentSpan, withSpan } from "../telemetry/context.ts";
import { formatTraceparent, parseTraceparent } from "../telemetry/propagation.ts";
import { SpanKind, SpanStatus } from "../telemetry/span.ts";
import { callHash } from "./idem.ts";
import { callOver, type CallRequest, serveCalls } from "./rpc.ts";
import { fromWire, toWire } from "./wire.ts";

import { socketPath, sweepSockets } from "./socket.ts";
export const DEFAULT_DEADLINE_MS = 30_000;

/** What a service method can read about the call it serves. */
export interface CurrentCall {
  service: string;
  method: string;
  /** The call's content key: the same on a retry of the calling job. A service with an external effect keeps it. */
  idem: string | null;
}

const callScope = new AsyncLocalStorage<CurrentCall>();

/** Inside a service method: the call being served (its idempotency key). */
export function currentCall(): CurrentCall | undefined {
  return callScope.getStore();
}

const STOP_TIMEOUT_MS = 10_000;
const STANDBY_RECHECK_MS = 5_000;
const RESERVED = new Set(["start", "stop", "status"]);

export const svcError = (status: number, code: string, message: string) => new ApiError(status, message, {}, code);

interface Entry {
  name: string;
  impl: ServiceImpl<Methods>;
  opts: Required<Omit<ProvideOptions, "autostart">>;
  state: ServiceStatus;
  since: number;
  startedAt: number | null;
  retries: number;
  lastExitAt: number | null;
  lastExitReason: string | null;
  /** Bumped per run: a late crash or exit of an old run is ignored. */
  gen: number;
  ac?: AbortController;
  timer?: ReturnType<typeof setTimeout>;
  /** Whether the manager should keep it up (false after a stop; a crash keeps it true). */
  wanted: boolean;
  leased: boolean;
  /** A stop still running past STOP_TIMEOUT_MS: the next start waits for it (never two instances in a process). */
  pendingStop?: Promise<unknown>;
  /** In memory, for the admin: calls served here, failed ones and their total time. */
  stats: { calls: number; errors: number; totalMs: number };
}

export interface ManagerDeps {
  app: () => App;
  aux: () => DatabaseSync;
  /** Which process this is: only a serve (or a bare app) runs services; elsewhere provide() only records the name. */
  role: () => string;
  /** This node's id (the queue's node id on a serve). */
  node: () => string | undefined;
  /** Several processes share the files: singletons take a lease and the node beats its rows. */
  shared: () => boolean;
  /** The job running in this async context: its id, its calls so far (for the keys) and its abort signal. */
  job?: () => { id: string; calls: Map<string, number>; signal: AbortSignal } | undefined;
  /** Timings (tests shorten them): the beat, the standby recheck, the stop's wait before a start may go on. */
  timing?: { beatMs?: number; recheckMs?: number; stopTimeoutMs?: number };
}

const reason = (e: unknown) => (e instanceof Error ? e.message : e === undefined ? "crashed" : String(e));

/**
 * app.services (§18): the long services of this process under a supervisord-like lifecycle. It knows nothing of the
 * queue; a call from another process arrives over its socket (listen) and is a function call here.
 */
export class ServiceManager {
  readonly #entries = new Map<string, Entry>();
  readonly #listeners = new Set<() => void>();
  #beat?: ReturnType<typeof setInterval>;
  #closed = false;
  #rpc?: { close(): Promise<void> };
  #addr: string | null = null;

  constructor(readonly deps: ManagerDeps) {}

  /** Runs services here: a serve, or a bare app (scripts, tests). Workers, executors and the mcp only call. */
  get runsServices(): boolean {
    const r = this.deps.role();
    return r === "serve" || r === "app";
  }

  /** This process's node id (the admin acts on its rows only). */
  get nodeId(): string {
    return this.#node;
  }

  get #node(): string {
    return this.deps.node() ?? `local:${Deno.pid}`;
  }

  // --- registration and lifecycle ------------------------------------------------------------------------------

  async provide(name: string, impl: ServiceImpl<Methods>, opts: ProvideOptions = {}): Promise<void> {
    if (!this.runsServices) return;
    if (this.#entries.has(name)) throw new Error(`service ${name} is already provided`);
    const e: Entry = {
      name,
      impl,
      opts: {
        singleton: opts.singleton ?? true,
        restart: opts.restart ?? "on-failure",
        startSecs: opts.startSecs ?? 1,
        backoffMs: opts.backoffMs ?? 1_000,
        maxBackoffMs: opts.maxBackoffMs ?? 60_000,
        maxRetries: opts.maxRetries ?? 5,
        stableSecs: opts.stableSecs ?? 60,
      },
      state: "stopped",
      since: Date.now(),
      startedAt: null,
      retries: 0,
      lastExitAt: null,
      lastExitReason: null,
      gen: 0,
      wanted: opts.autostart ?? true,
      leased: false,
      stats: { calls: 0, errors: 0, totalMs: 0 },
    };
    this.#entries.set(name, e);
    // createApp provides its own before the app exists: the app is read once it does.
    await Promise.resolve();
    this.#ensureBeat();
    if (e.wanted) await this.#run(e);
    else this.#changed();
  }

  /** Starts a stopped, fatal or backing-off service now (retries reset). */
  async start(name: string): Promise<ServiceState> {
    const e = this.#get(name);
    // A singleton's stop is the cluster's (in its lease): a start from any node lifts it; the holder starts it.
    if (this.#clustered(e)) this.#aux((aux) => setWant(aux, name, ""));
    e.wanted = true;
    if (e.state === "running" || e.state === "starting" || e.state === "stopping") return this.#view(e);
    clearTimeout(e.timer);
    e.retries = 0;
    await this.#run(e);
    return this.#view(e);
  }

  /** Stops it and keeps it stopped (no restart) until a start. */
  async stop(name: string): Promise<ServiceState> {
    const e = this.#get(name);
    e.wanted = false;
    if (this.#clustered(e)) {
      // Kept as the cluster's intention: the holder keeps the lease while stopped, so no standby takes it over. Run
      // elsewhere, the holder sees it at its next beat and stops.
      this.#aux((aux) => setWant(aux, name, "stopped"));
      if (e.leased) {
        await this.#halt(e, "stopped", true);
        return this.#view(e);
      }
    }
    await this.#halt(e, "stopped");
    return this.#view(e);
  }

  async restart(name: string): Promise<ServiceState> {
    const e = this.#get(name);
    await this.#halt(e, "stopped");
    e.wanted = true;
    e.retries = 0;
    await this.#run(e);
    return this.#view(e);
  }

  #get(name: string): Entry {
    const e = this.#entries.get(name);
    if (!e) throw svcError(404, "service_not_found", `This serve does not provide ${name}.`);
    return e;
  }

  #clustered(e: Entry): boolean {
    return e.opts.singleton && this.deps.shared();
  }

  #aux<T>(fn: (aux: DatabaseSync) => T): T | undefined {
    try {
      return fn(this.deps.aux());
    } catch (err) {
      console.error("services:", (err as Error).message);
      return undefined;
    }
  }

  async #run(e: Entry): Promise<void> {
    if (this.#closed || !e.wanted) return;
    clearTimeout(e.timer);
    if (e.pendingStop) {
      // The last run's stop outlived its timeout: a start now would make a second instance beside it.
      this.#set(e, "stopping");
      await e.pendingStop;
      if (this.#closed || !e.wanted) return this.#set(e, "stopped");
    }
    // Shared files, and this node has no id yet (the serve sets it once its queue is up): a lease or a row taken now
    // under a provisional id would be refused at the next beat under the real one (B3). Wait for it.
    if (this.deps.shared() && !this.deps.node()) {
      e.timer = setTimeout(() => void this.#run(e), 50);
      return;
    }
    const gen = ++e.gen;
    if (this.#clustered(e)) {
      const now = Date.now();
      const l = this.#aux((aux) => leaseOf(aux, e.name, now));
      // Entering STARTING takes the lease in the same statement; held elsewhere it is standby, or stopped when the
      // cluster stopped it (rechecked: a start elsewhere, or the stopper's death, lifts it).
      e.leased = !!this.#aux((aux) => acquireLease(aux, e.name, this.#node, now));
      if (!e.leased) {
        this.#set(e, l?.want === "stopped" ? "stopped" : "standby");
        e.timer = setTimeout(() => void this.#run(e), this.deps.timing?.recheckMs ?? STANDBY_RECHECK_MS);
        return;
      }
    }
    const ac = new AbortController();
    e.ac = ac;
    e.startedAt = Date.now();
    this.#set(e, "starting");
    const ctx = {
      app: this.deps.app(),
      signal: ac.signal,
      crashed: (r?: unknown) => void this.#ended(e, gen, reason(r), true),
      exited: () => void this.#ended(e, gen, "exited", false),
    };
    try {
      await e.impl.start?.(ctx);
    } catch (err) {
      return await this.#ended(e, gen, reason(err), true);
    }
    if (gen !== e.gen || e.state !== "starting") return;
    // Running does not reset the crash count: only a run that stays up stableSecs does (§18), else a service that
    // crashes every few seconds would restart forever and never reach fatal.
    const up = () => {
      if (gen !== e.gen || e.state !== "starting") return;
      this.#set(e, "running");
    };
    if (e.opts.startSecs > 0) e.timer = setTimeout(up, e.opts.startSecs * 1000);
    else up();
  }

  /** The current run ended on its own: a crash (or a failed start) or a clean exit. */
  async #ended(e: Entry, gen: number, why: string, crash: boolean): Promise<void> {
    // Only the current run, and only while it is up: a late crash of an old run, or one fired by its own stop, is not.
    if (gen !== e.gen || (e.state !== "starting" && e.state !== "running")) return;
    // A singleton that lost its lease (another serve took it over: "session replaced") steps back to standby, never
    // backoff, or the two would knock each other down in a loop.
    if (this.#clustered(e) && !this.#aux((aux) => holdsLease(aux, e.name, this.#node, Date.now()))) {
      e.leased = false;
      return this.#lost(e);
    }
    clearTimeout(e.timer);
    e.ac?.abort();
    e.lastExitAt = Date.now();
    e.lastExitReason = why;
    try {
      await e.impl.stop?.();
    } catch { /* what is left of a dead run */ }
    const policy: RestartPolicy = e.opts.restart;
    if (policy === "never" || (!crash && policy !== "always")) {
      this.#releaseLease(e);
      e.wanted = false;
      return this.#set(e, crash ? "fatal" : "stopped");
    }
    if (e.startedAt !== null && Date.now() - e.startedAt >= e.opts.stableSecs * 1000) e.retries = 0;
    e.retries++;
    if (e.retries > e.opts.maxRetries) {
      this.#releaseLease(e);
      return this.#set(e, "fatal");
    }
    const wait = Math.min(e.opts.maxBackoffMs, e.opts.backoffMs * 2 ** Math.max(0, e.retries - 1));
    this.#set(e, "backoff");
    e.timer = setTimeout(() => void this.#run(e), wait);
  }

  /** Stops the current run, cooperatively (never a terminate): past STOP_TIMEOUT_MS the stop goes on, awaited by the
   * next start. `keepLease`: a singleton the cluster stopped keeps it, so no standby takes over. */
  async #halt(e: Entry, to: ServiceStatus, keepLease = false): Promise<void> {
    clearTimeout(e.timer);
    e.gen++;
    const live = e.state === "starting" || e.state === "running";
    if (live) {
      this.#set(e, "stopping");
      e.ac?.abort();
      const stopping: Promise<unknown> = Promise.resolve().then(() => e.impl.stop?.()).catch((err) =>
        console.error(`service ${e.name} stop:`, err)
      );
      e.pendingStop = stopping;
      void stopping.finally(() => {
        if (e.pendingStop === stopping) e.pendingStop = undefined;
      });
      await Promise.race([
        stopping,
        new Promise((r) => setTimeout(r, this.deps.timing?.stopTimeoutMs ?? STOP_TIMEOUT_MS)),
      ]);
    }
    if (!keepLease) this.#releaseLease(e);
    e.startedAt = null;
    this.#set(e, to);
  }

  #releaseLease(e: Entry): void {
    if (!e.leased) return;
    e.leased = false;
    try {
      releaseLease(this.deps.aux(), e.name, this.#node);
    } catch { /* expires on its own */ }
  }

  #set(e: Entry, state: ServiceStatus): void {
    e.state = state;
    e.since = Date.now();
    this.#changed();
  }

  #changed(): void {
    for (const fn of this.#listeners) fn();
    if (this.deps.shared()) this.#write();
  }

  // --- state, beat --------------------------------------------------------------------------------------------

  #view(e: Entry): ServiceState {
    let detail: unknown;
    try {
      detail = e.impl.status?.();
    } catch (err) {
      detail = { error: (err as Error).message };
    }
    return {
      name: e.name,
      node: this.#node,
      state: e.state,
      since: e.since,
      startedAt: e.state === "running" || e.state === "starting" ? e.startedAt : null,
      retries: e.retries,
      lastExitAt: e.lastExitAt,
      lastExitReason: e.lastExitReason,
      singleton: e.opts.singleton,
      addr: e.state === "running" ? this.#addr : null,
      calls: e.stats.calls,
      errors: e.stats.errors,
      avgMs: e.stats.calls ? Math.round(e.stats.totalMs / e.stats.calls) : 0,
      ...(detail === undefined ? {} : { detail }),
    };
  }

  /** This process's services. */
  list(): ServiceState[] {
    return [...this.#entries.values()].map((e) => this.#view(e));
  }

  /** Every node's services (from the aux db), this process's included and current. */
  all(): ServiceState[] {
    const now = Date.now();
    const mine = this.list().map((s) => ({ ...s, beat: now, alive: true }));
    const others = listStates(this.deps.aux(), now).filter((s) => s.node !== this.#node);
    return [...mine, ...others].sort((a, b) => a.name.localeCompare(b.name) || a.node.localeCompare(b.node));
  }

  /** The names running here (where calls can be served). */
  running(): string[] {
    return [...this.#entries.values()].filter((e) => e.state === "running").map((e) => e.name);
  }

  onChange(fn: () => void): () => void {
    this.#listeners.add(fn);
    return () => this.#listeners.delete(fn);
  }

  #ensureBeat(): void {
    if (this.#beat || !this.deps.shared()) return;
    ensureServiceTables(this.deps.aux());
    this.#beat = setInterval(() => this.#tick(), this.deps.timing?.beatMs ?? BEAT_MS);
  }

  /** The lease is gone (in any state): stopping, then standby; the recheck takes it back if it frees up. */
  async #lost(e: Entry): Promise<void> {
    await this.#halt(e, "standby");
    if (!this.#closed && e.wanted) {
      e.timer = setTimeout(() => void this.#run(e), this.deps.timing?.recheckMs ?? STANDBY_RECHECK_MS);
    }
  }

  #tick(): void {
    const now = Date.now();
    for (const e of this.#entries.values()) {
      if (!e.leased) continue;
      // Renewed in every state it is held in (backoff, stopped by the cluster). Lost while this process stalled:
      // another serve took it over; this run steps back.
      if (!this.#aux((aux) => acquireLease(aux, e.name, this.#node, now))) {
        e.leased = false;
        void this.#lost(e);
        continue;
      }
      const want = this.#aux((aux) => leaseOf(aux, e.name, now))?.want;
      if (want === "stopped" && e.wanted) {
        // Stopped from another node: the cluster's intention reaches the holder.
        e.wanted = false;
        void this.#halt(e, "stopped", true);
      } else if (want === "" && !e.wanted && e.state === "stopped") {
        // Started from another node while this one held it stopped: the holder starts it.
        e.wanted = true;
        e.retries = 0;
        void this.#run(e);
      }
    }
    this.#write();
  }

  #write(): void {
    if (!this.deps.node()) return;
    try {
      writeStates(this.deps.aux(), this.#node, this.list(), Date.now());
    } catch { /* busy: the next beat */ }
  }

  // --- calls ----------------------------------------------------------------------------------------------------

  /** Whether calls to `name` run here. */
  local(name: string): boolean {
    return this.#entries.get(name)?.state === "running";
  }

  /** The socket of a live node other than this one that runs `name` now. */
  elsewhere(name: string): string | null {
    if (!this.deps.shared()) return null;
    return addrOf(this.deps.aux(), name, this.#node, Date.now());
  }

  /** Listens for calls from other processes on a Unix socket in `dir` (pb_data): a serve does, once. */
  listen(dir: string): void {
    if (this.#rpc || !this.runsServices) return;
    void sweepSockets(dir); // leftovers of dead processes; never in the way of this listen
    const path = socketPath(dir);
    try {
      this.#rpc = serveCalls(path, (r, tp) => this.#serveCall(r, tp));
      this.#addr = path;
    } catch (e) {
      // Never fatal to the boot: services still run here, only calls from other processes cannot reach them.
      console.error(`services: cannot listen on ${path}: ${(e as Error).message}`);
      return;
    }
    this.#changed();
  }

  async #serveCall(r: CallRequest, traceparent: string | null): Promise<unknown> {
    const app = this.deps.app();
    const parent = parseTraceparent(traceparent);
    const span = app.tracer.startRoot(`service ${r.service}.${r.method}`, {
      kind: SpanKind.server,
      parent,
      attributes: { "service.name": r.service, "service.method": r.method },
    });
    try {
      return await withSpan(span, () => this.execute(r.service, r.method, fromWire(r.args) as unknown[], r.idem));
    } catch (e) {
      span.setStatus(SpanStatus.error, (e as Error).message);
      throw e;
    } finally {
      span.end();
    }
  }

  /** Runs one call of a service running here, with its key in currentCall(). */
  async execute(name: string, method: string, args: unknown[], idem: string | null = null): Promise<unknown> {
    const e = this.#entries.get(name);
    if (!e || e.state !== "running") throw svcError(503, "service_unavailable", `This serve does not run ${name}.`);
    // A singleton serves a call only while it holds the lease: a process that stalled past it no longer owns the
    // session another serve has taken over.
    if (this.#clustered(e) && !this.#aux((aux) => holdsLease(aux, name, this.#node, Date.now()))) {
      e.leased = false;
      void this.#lost(e);
      throw svcError(503, "service_unavailable", `This serve no longer holds ${name}.`);
    }
    const fn = e.impl[method];
    if (typeof fn !== "function" || RESERVED.has(method)) {
      throw svcError(400, "service_no_method", `${name} has no method ${method}.`);
    }
    const t0 = performance.now();
    e.stats.calls++;
    try {
      return await callScope.run({ service: name, method, idem }, () => fn.apply(e.impl, args));
    } catch (err) {
      e.stats.errors++;
      throw err;
    } finally {
      e.stats.totalMs += performance.now() - t0;
    }
  }

  /**
   * A call from anywhere: a function call where the service runs, else one request over the socket of the serve that
   * runs it. No retry and nothing kept: the deadline is the request's abort.
   */
  async call(
    name: string,
    method: string,
    args: unknown[],
    so: ServiceOptions<Methods>,
    co: CallOptions,
  ): Promise<unknown> {
    const idem = await this.#key(name, method, args, so, co);
    if (this.local(name)) return await this.execute(name, method, args, idem);
    if (inAnyTransaction()) {
      throw svcError(
        500,
        "service_call_in_tx",
        `service calls cannot run inside a transaction: call ${name}.${method} after the commit`,
      );
    }
    const addr = this.elsewhere(name);
    if (!addr) throw svcError(503, "service_unavailable", `No serve is running the ${name} service.`);
    const span = currentSpan();
    const traceparent = span?.isRecording
      ? formatTraceparent({ traceId: span.traceId, spanId: span.id, sampled: span.sampled })
      : null;
    return await callOver(addr, { service: name, method, args: toWire(args), idem }, {
      deadlineMs: co.deadlineMs ?? so.deadlineMs ?? DEFAULT_DEADLINE_MS,
      traceparent,
      signal: this.deps.job?.()?.signal,
    });
  }

  /**
   * The call's content key (§16 N4): `<job>:<svc.method>:<hash>:<k>` inside a job (the k-th call with these arguments,
   * so a retry of the job hands the same keys again), or the caller's own `idem`. Null outside a job.
   */
  async #key(name: string, method: string, args: unknown[], so: ServiceOptions<Methods>, co: CallOptions) {
    if (co.idem) return `idem:${name}.${method}:${co.idem}`;
    const job = this.deps.job?.();
    if (!job || so.idempotent?.[method] === false) return null;
    const hash = await callHash(name, method, args);
    const k = job.calls.get(hash) ?? 0;
    job.calls.set(hash, k + 1);
    return `${job.id}:${name}.${method}:${hash}:${k}`;
  }

  async close(): Promise<void> {
    this.#closed = true;
    clearInterval(this.#beat);
    this.#beat = undefined;
    await this.#rpc?.close();
    this.#rpc = undefined;
    for (const e of [...this.#entries.values()].reverse()) await this.#halt(e, "stopped");
    if (this.deps.shared()) {
      try {
        removeStates(this.deps.aux(), this.#node);
      } catch { /* the db is closing */ }
    }
  }
}
